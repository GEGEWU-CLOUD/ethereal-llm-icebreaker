#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
LLM API 压力测试系统 - 本地多线程高速流式反向代理、静态托管与登录鉴权服务器
解决痛点：
1. 完全放行所有 OPTIONS 预检请求并注入宽松 CORS 响应头，免除浏览器拦截
2. 配置兼容的 SSL/TLS 握手上下文，解决 UNEXPECTED_EOF_WHILE_READING 报错
3. 采用 ThreadingHTTPServer 支持 100+ 并发连接同时中继
4. 支持 Server-Sent Events (SSE) 流式传输无缓冲直达
5. 内置登录鉴权 (users.json + PBKDF2 + Cookie 会话)，支持容器化与 PyInstaller 打包

账号管理 (命令行):
    python server.py --add-user alice     # 添加/重置账号 (交互输入密码)
    python server.py --list-users         # 列出所有账号
    python server.py --del-user alice     # 删除账号

环境变量:
    BENCH_PORT       服务端口 (默认 8765)
    BENCH_DATA_DIR   可写数据目录, users.json 存放处 (Docker 挂卷用; 默认与程序同目录)
    BENCH_PASSWORD   --add-user 的非交互密码来源 (自动化/Docker exec 场景, 日常勿用)
"""

import http.server
import socketserver
import urllib.request
import urllib.error
import urllib.parse
import ssl
import json
import sys
import os
import time
import getpass
import secrets
import hashlib
import hmac
import threading
from datetime import datetime

# ---------------------------- 路径与配置 ----------------------------

def asset_root():
    """静态资源根目录 (PyInstaller onefile 时为临时解包目录)"""
    if getattr(sys, 'frozen', False):
        return getattr(sys, '_MEIPASS', os.path.dirname(os.path.abspath(sys.executable)))
    return os.path.dirname(os.path.abspath(__file__))

def data_root():
    """可写数据目录 (users.json 所在处; 打包后 exe 的解包目录只读, 数据须放 exe 旁边)"""
    env = os.environ.get('BENCH_DATA_DIR')
    if env:
        os.makedirs(env, exist_ok=True)
        return env
    if getattr(sys, 'frozen', False):
        return os.path.dirname(os.path.abspath(sys.executable))
    return os.path.dirname(os.path.abspath(__file__))

ASSET_DIR = asset_root()
DATA_DIR = data_root()
USERS_FILE = os.path.join(DATA_DIR, 'users.json')
PORT = int(os.environ.get('BENCH_PORT', '8765'))

# 创建兼容且稳定的 SSL 上下文，彻底解决 CDN 握手断开问题
SSL_CONTEXT = ssl.create_default_context()
SSL_CONTEXT.check_hostname = False
SSL_CONTEXT.verify_mode = ssl.CERT_NONE
try:
    SSL_CONTEXT.set_ciphers('DEFAULT:@SECLEVEL=1')
except Exception:
    pass

# ---------------------------- 账号与密码 ----------------------------

PBKDF2_ITERATIONS = 200_000

def hash_password(password, salt=None):
    if salt is None:
        salt = secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac(
        'sha256', password.encode('utf-8'), bytes.fromhex(salt), PBKDF2_ITERATIONS)
    return '{0}${1}'.format(salt, digest.hex())

def verify_password(password, stored):
    try:
        salt = stored.split('$', 1)[0]
        return hmac.compare_digest(hash_password(password, salt), stored)
    except Exception:
        return False

def load_users():
    if os.path.exists(USERS_FILE):
        try:
            with open(USERS_FILE, 'r', encoding='utf-8') as f:
                data = json.load(f)
            if isinstance(data, dict) and isinstance(data.get('users'), list):
                return data
        except Exception:
            pass
    return {"users": []}

def save_users(data):
    with open(USERS_FILE, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=2)

def ensure_default_user():
    """首次启动自动创建默认账号 admin / admin123"""
    data = load_users()
    if data["users"]:
        return
    data["users"].append({
        "username": "admin",
        "pbkdf2": hash_password("admin123"),
        "created": datetime.now().isoformat(timespec='seconds')
    })
    save_users(data)
    print("[!] 未检测到账号数据，已自动创建默认账号: admin / admin123")
    print("[!] ⚠ 安全提醒: 请尽快执行  python server.py --add-user admin  重置默认密码!")

# ---------------------------- 会话管理 (内存态) ----------------------------
# 说明: 会话保存在进程内存中, 服务重启后所有登录态失效需重新登录 (工具场景可接受)

SESSION_TTL = 24 * 3600  # 24 小时滑动过期
_SESSIONS = {}           # token -> {"user": str, "expires": float}
_SESSION_LOCK = threading.Lock()

def create_session(username):
    now = time.time()
    with _SESSION_LOCK:
        # 顺手清理已过期会话
        for tk in [t for t, s in _SESSIONS.items() if s["expires"] < now]:
            _SESSIONS.pop(tk, None)
        token = secrets.token_hex(32)
        _SESSIONS[token] = {"user": username, "expires": now + SESSION_TTL}
    return token

def get_session(token):
    if not token:
        return None
    with _SESSION_LOCK:
        s = _SESSIONS.get(token)
        if not s:
            return None
        if time.time() > s["expires"]:
            _SESSIONS.pop(token, None)
            return None
        s["expires"] = time.time() + SESSION_TTL  # 滑动续期
        return s

def destroy_session(token):
    with _SESSION_LOCK:
        _SESSIONS.pop(token, None)

# ---------------------------- GPU 压测编排 (懒加载) ----------------------------

GPU_MANAGER = None

# 在线查看报告的临时存储: token -> html (上限 30 份, 先进先出)
_REPORT_VIEWS = {}
_REPORT_VIEWS_LOCK = threading.Lock()

def get_gpu_manager():
    """GpuJobPool 单例 (gpu_agent 懒加载, paramiko 未装时不影响其他功能)"""
    global GPU_MANAGER
    if GPU_MANAGER is None:
        import gpu_agent
        script = os.path.join(ASSET_DIR, 'gpu_check.sh')
        GPU_MANAGER = gpu_agent.GpuJobPool(script)
    return GPU_MANAGER

# ---------------------------- HTTP Handler ----------------------------

# 无需登录即可访问的静态路径 (登录页自身及其样式)
PUBLIC_PATHS = {'/login.html', '/style.css', '/favicon.svg'}

class CORSProxyHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ASSET_DIR, **kwargs)

    # ---------- 通用辅助 ----------

    def _send_cors_headers(self, status=200, content_type="application/json"):
        self.send_response(status)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS, HEAD")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.send_header("Access-Control-Max-Age", "86400")
        if content_type:
            self.send_header("Content-Type", content_type)

    def end_headers(self):
        # 页面资源 (html/js/css) 注入 no-cache: 保证版本升级后浏览器不残留旧界面
        try:
            buf = getattr(self, "_headers_buffer", None)
            if buf:
                is_page = any(
                    (b"text/html" in h) or (b"text/css" in h) or (b"javascript" in h)
                    for h in buf if isinstance(h, bytes) or isinstance(h, bytearray))
                has_cc = any(b"Cache-Control" in h for h in buf)
                if is_page and not has_cc:
                    self.send_header("Cache-Control", "no-cache, must-revalidate")
        except Exception:
            pass
        super().end_headers()

    def _send_json(self, obj, status=200):
        body = json.dumps(obj, ensure_ascii=False).encode('utf-8')
        self._send_cors_headers(status)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _get_session_token(self):
        for part in (self.headers.get('Cookie') or '').split(';'):
            if '=' in part:
                k, v = part.strip().split('=', 1)
                if k == 'bench_session':
                    return v
        # 跨源代理场景无法携带 Cookie: 允许查询参数/请求头携带会话令牌
        qs = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        tok = (qs.get('bench_token') or [None])[0]
        if tok:
            return tok
        return self.headers.get('X-Bench-Token')

    def is_authenticated(self):
        return get_session(self._get_session_token()) is not None

    def _reject_unauthenticated(self):
        """浏览器导航请求 302 到登录页; 接口/资源请求返回 401"""
        path = urllib.parse.urlparse(self.path).path
        mode = self.headers.get('Sec-Fetch-Mode', '')
        accept = self.headers.get('Accept', '')
        is_navigation = mode == 'navigate' or (
            not mode and 'text/html' in accept and 'application/json' not in accept)
        if is_navigation and not path.startswith(('/proxy', '/api/')):
            self.send_response(302)
            self.send_header("Location", "/login.html")
            self.send_header("Content-Length", "0")
            self.end_headers()
        else:
            self._send_json({"error": "未登录或会话已过期，请重新登录"}, 401)

    # ---------- 基础谓词 ----------

    def do_OPTIONS(self):
        """放行所有 OPTIONS 预检请求"""
        self._send_cors_headers(204, content_type=None)
        self.end_headers()

    def do_HEAD(self):
        if not self.is_authenticated() and urllib.parse.urlparse(self.path).path not in PUBLIC_PATHS:
            return self._reject_unauthenticated()
        super().do_HEAD()

    def do_GET(self):
        path = urllib.parse.urlparse(self.path).path

        # 公开接口
        if path == '/health':
            self._send_cors_headers(200)
            self.end_headers()
            self.wfile.write(b'{"status":"ok","proxy":true}')
            return
        if path == '/api/me':
            token = self._get_session_token()
            s = get_session(token)
            if s:
                # proxyToken: 供跨源 CORS 代理携带会话 (浏览器跨端口 fetch 带不上 Cookie)
                self._send_json({"ok": True, "username": s["user"], "proxyToken": token})
            else:
                self._send_json({"ok": False, "error": "未登录"}, 401)
            return
        # GPU 压测: 状态与结果 (登录态保护, 多任务池)
        if path == '/api/gpu/status':
            if not self.is_authenticated():
                return self._send_json({"ok": False, "error": "未登录"}, 401)
            return self._send_json({"ok": True, "jobs": get_gpu_manager().status_all()})
        if path == '/api/gpu/result':
            if not self.is_authenticated():
                return self._send_json({"ok": False, "error": "未登录"}, 401)
            qs = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            job_id = (qs.get('jobId') or [None])[0]
            result, err = get_gpu_manager().get_result(job_id)
            if result:
                return self._send_json({"ok": True, "result": result})
            return self._send_json({"ok": False, "error": err or "暂无结果"}, 404)
        # 在线查看报告 (浏览器直接打开的 HTML 页面)
        if path.startswith('/api/gpu/report/'):
            if not self.is_authenticated():
                return self._reject_unauthenticated()
            token = path.split('/api/gpu/report/', 1)[1].strip('/')
            with _REPORT_VIEWS_LOCK:
                html = _REPORT_VIEWS.get(token)
            if html is None:
                return self._send_json({"ok": False, "error": "报告不存在或已过期, 请重新生成"}, 404)
            body = html.encode('utf-8')
            self._send_cors_headers(200, content_type="text/html; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return

        if path.startswith('/api/'):
            self._send_json({"error": "Not found"}, 404)
            return

        # 受保护接口: 代理中继
        if self.path.startswith('/proxy'):
            if not self.is_authenticated():
                return self._reject_unauthenticated()
            return self._handle_proxy()

        # 受保护静态资源
        if path not in PUBLIC_PATHS and not self.is_authenticated():
            return self._reject_unauthenticated()
        super().do_GET()

    def _read_json_body(self):
        length = int(self.headers.get('Content-Length', 0))
        raw = self.rfile.read(length).decode('utf-8') if length > 0 else ''
        return json.loads(raw or '{}')

    def do_POST(self):
        path = urllib.parse.urlparse(self.path).path

        if path == '/api/login':
            return self._handle_login()
        if path == '/api/logout':
            destroy_session(self._get_session_token())
            return self._send_json({"ok": True})

        # 修改自己的密码 (登录态保护)
        if path == '/api/change-password':
            if not self.is_authenticated():
                return self._send_json({"ok": False, "error": "未登录"}, 401)
            try:
                payload = self._read_json_body()
            except Exception:
                return self._send_json({"ok": False, "error": "请求体格式错误"}, 400)
            old_pw = str(payload.get('oldPassword') or '')
            new_pw = str(payload.get('newPassword') or '')
            if len(new_pw) < 6:
                return self._send_json({"ok": False, "error": "新密码至少 6 位"}, 400)
            sess = get_session(self._get_session_token())
            username = sess["user"] if sess else None
            data = load_users()
            user = next((u for u in data["users"] if u.get("username") == username), None)
            if not user or not verify_password(old_pw, user.get("pbkdf2", "")):
                time.sleep(0.3)
                return self._send_json({"ok": False, "error": "原密码错误"}, 401)
            user["pbkdf2"] = hash_password(new_pw)
            user["passwordChanged"] = datetime.now().isoformat(timespec="seconds")
            save_users(data)
            return self._send_json({"ok": True, "message": "密码已修改, 下次登录使用新密码"})

        # GPU 压测: 启动 / 停止 / 手动产物解析 (登录态保护, 多任务池)
        if path == '/api/gpu/start':
            if not self.is_authenticated():
                return self._send_json({"ok": False, "error": "未登录"}, 401)
            try:
                payload = self._read_json_body()
            except Exception:
                return self._send_json({"ok": False, "error": "请求体格式错误"}, 400)
            host = str(payload.get('host') or '').strip()
            username = str(payload.get('username') or '').strip()
            password = str(payload.get('password') or '')
            key_path = str(payload.get('keyPath') or '').strip() or None
            if not host or not username:
                return self._send_json({"ok": False, "error": "请填写主机与用户名"}, 400)
            if not password and not key_path:
                return self._send_json({"ok": False, "error": "请填写密码或密钥路径"}, 400)
            try:
                burn = int(payload.get('burnSeconds') or 1800)
            except Exception:
                burn = 1800
            burn = min(max(burn, 60), 24 * 3600)
            job_id, msg = get_gpu_manager().start_job({
                "host": host, "port": int(payload.get('port') or 22),
                "username": username, "password": password, "keyPath": key_path,
                "burnSeconds": burn,
                "useSudo": bool(payload.get('useSudo')),
            })
            return self._send_json({"ok": bool(job_id), "jobId": job_id, "message": msg},
                                   200 if job_id else 409)

        if path == '/api/gpu/stop':
            if not self.is_authenticated():
                return self._send_json({"ok": False, "error": "未登录"}, 401)
            try:
                payload = self._read_json_body()
            except Exception:
                payload = {}
            job_id = str(payload.get('jobId') or '').strip() or None
            ok, msg = get_gpu_manager().stop_job(job_id)
            return self._send_json({"ok": ok, "message": msg})

        if path == '/api/gpu/parse':
            if not self.is_authenticated():
                return self._send_json({"ok": False, "error": "未登录"}, 401)
            try:
                payload = self._read_json_body()
            except Exception:
                return self._send_json({"ok": False, "error": "请求体格式错误"}, 400)
            report_txt = str(payload.get('reportTxt') or '')
            telemetry_csv = str(payload.get('telemetryCsv') or '')
            burn_log = str(payload.get('burnLog') or '')
            if not report_txt and not telemetry_csv and not burn_log:
                return self._send_json({"ok": False, "error": "请至少上传一份产物文件"}, 400)
            try:
                import gpu_agent
                aer_raw = str(payload.get('dmesgAer') or '')
                aer_lines = [x for x in aer_raw.splitlines() if x.strip()] if aer_raw else None
                parsed = gpu_agent.parse_gpu_artifacts(
                    report_txt, telemetry_csv, burn_log,
                    enrich={"source": "manual", "dmesgAer": aer_lines,
                            "hostname": str(payload.get('hostname') or '') or None})
                return self._send_json({"ok": True, "result": parsed})
            except Exception as e:
                return self._send_json({"ok": False, "error": "解析失败: {}".format(e)[:300]}, 500)

        # 报告在线查看: 前端提交已生成的 HTML, 返回浏览器可直达的 URL
        if path == '/api/gpu/report':
            if not self.is_authenticated():
                return self._send_json({"ok": False, "error": "未登录"}, 401)
            try:
                payload = self._read_json_body()
            except Exception:
                return self._send_json({"ok": False, "error": "请求体格式错误"}, 400)
            html = str(payload.get('html') or '')
            if not html:
                return self._send_json({"ok": False, "error": "html 内容为空"}, 400)
            if len(html) > 8 * 1024 * 1024:
                return self._send_json({"ok": False, "error": "报告内容过大"}, 413)
            token = secrets.token_hex(8)
            with _REPORT_VIEWS_LOCK:
                _REPORT_VIEWS[token] = html
                while len(_REPORT_VIEWS) > 30:
                    _REPORT_VIEWS.pop(next(iter(_REPORT_VIEWS)))
            return self._send_json({"ok": True, "url": "/api/gpu/report/" + token})

        if path.startswith('/api/'):
            return self._send_json({"error": "Not found"}, 404)
        if self.path.startswith('/proxy'):
            if not self.is_authenticated():
                return self._reject_unauthenticated()
            return self._handle_proxy()

        self.send_error(404, "Endpoint not found")

    # ---------- 登录 ----------

    def _handle_login(self):
        try:
            length = int(self.headers.get('Content-Length', 0))
            payload = json.loads(self.rfile.read(length).decode('utf-8') or '{}')
        except Exception:
            return self._send_json({"ok": False, "error": "请求体格式错误"}, 400)

        username = str(payload.get('username') or '').strip()
        password = str(payload.get('password') or '')
        if not username or not password:
            return self._send_json({"ok": False, "error": "请输入账号与密码"}, 400)

        user = next((u for u in load_users()["users"] if u.get('username') == username), None)
        if not user or not verify_password(password, user.get('pbkdf2', '')):
            time.sleep(0.3)  # 轻微延迟抑制爆破
            return self._send_json({"ok": False, "error": "账号或密码错误"}, 401)

        token = create_session(username)
        self._send_cors_headers(200)
        self.send_header(
            "Set-Cookie",
            "bench_session={0}; Path=/; HttpOnly; SameSite=Lax; Max-Age={1}".format(token, SESSION_TTL))
        body = json.dumps({"ok": True, "username": username}, ensure_ascii=False).encode('utf-8')
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    # ---------- 代理中继 (原有逻辑不变, 仅入口加鉴权) ----------

    def _handle_proxy(self):
        parsed = urllib.parse.urlparse(self.path)
        qs = urllib.parse.parse_qs(parsed.query)
        target_url = qs.get("url", [None])[0]

        if not target_url:
            self._send_cors_headers(400)
            self.end_headers()
            self.wfile.write(b'{"error":"Missing ?url= parameter"}')
            return

        # 去除意外的嵌套代理
        if "/proxy?url=" in target_url:
            target_url = target_url.split("/proxy?url=")[-1]
        target_url = urllib.parse.unquote(target_url)

        content_length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(content_length) if content_length > 0 else None

        req_headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "Accept": "*/*",
            "Accept-Encoding": "identity"  # 避免代理二次解压 gzip 引起流式中断
        }
        for h in ["Authorization", "Content-Type"]:
            if h in self.headers:
                req_headers[h] = self.headers[h]

        if "Content-Type" not in req_headers:
            req_headers["Content-Type"] = "application/json"

        # 动态解析目标 Host
        try:
            target_parsed = urllib.parse.urlparse(target_url)
            if target_parsed.netloc:
                req_headers["Host"] = target_parsed.netloc
        except Exception:
            pass

        req = urllib.request.Request(
            target_url,
            data=body,
            headers=req_headers,
            method=self.command
        )

        try:
            with urllib.request.urlopen(req, timeout=300, context=SSL_CONTEXT) as response:
                status_code = response.getcode()
                content_type = response.headers.get("Content-Type", "application/json")

                self._send_cors_headers(status_code, content_type=content_type)
                if "text/event-stream" in content_type:
                    self.send_header("Cache-Control", "no-cache")
                    self.send_header("X-Accel-Buffering", "no")
                self.end_headers()

                while True:
                    chunk = response.read(1024)
                    if not chunk:
                        break
                    try:
                        self.wfile.write(chunk)
                        self.wfile.flush()
                    except (BrokenPipeError, ConnectionResetError):
                        break

        except urllib.error.HTTPError as e:
            err_body = e.read()
            self._send_cors_headers(e.code, content_type=e.headers.get("Content-Type", "application/json"))
            self.end_headers()
            self.wfile.write(err_body)
        except Exception as e:
            self._send_cors_headers(502)
            self.end_headers()
            err_json = json.dumps({"error": f"Proxy request failed: {str(e)}"}).encode("utf-8")
            self.wfile.write(err_json)

# ---------------------------- CLI 账号管理 ----------------------------

def run_cli(argv):
    def flag_value(name):
        if name in argv:
            i = argv.index(name)
            if i + 1 < len(argv):
                return argv[i + 1]
        return None

    if '--add-user' in argv:
        name = flag_value('--add-user')
        if not name or not name.replace('_', '').replace('-', '').isalnum():
            print("用法: python server.py --add-user <账号名>  (字母/数字/中划线/下划线)")
            return 1
        # 非交互模式: 指定 BENCH_PASSWORD 环境变量 (适用于 Docker exec / CI 自动化)
        env_pw = os.environ.get('BENCH_PASSWORD')
        if env_pw is not None:
            pw1 = env_pw
            if len(pw1) < 6:
                print("✘ 密码至少 6 位。")
                return 1
        else:
            pw1 = getpass.getpass("请输入 {0} 的密码: ".format(name))
            pw2 = getpass.getpass("再确认一次密码: ".format(name))
            if len(pw1) < 6:
                print("✘ 密码至少 6 位。")
                return 1
            if pw1 != pw2:
                print("✘ 两次输入不一致。")
                return 1
        data = load_users()
        existed = any(u.get('username') == name for u in data['users'])
        data['users'] = [u for u in data['users'] if u.get('username') != name]
        data['users'].append({
            'username': name,
            'pbkdf2': hash_password(pw1),
            'created': datetime.now().isoformat(timespec='seconds')
        })
        save_users(data)
        print("✔ {0} 账号 {1} → {2}".format(name, '密码已重置' if existed else '创建成功',
                                           USERS_FILE))
        return 0

    if '--list-users' in argv:
        users = load_users()['users']
        if not users:
            print("(暂无账号, 启动服务时会自动创建 admin/admin123)")
        for u in users:
            print("- {0}  (创建于 {1})".format(u.get('username'), u.get('created', 'unknown')))
        return 0

    if '--del-user' in argv:
        name = flag_value('--del-user')
        if not name:
            print("用法: python server.py --del-user <账号名>")
            return 1
        data = load_users()
        before = len(data['users'])
        data['users'] = [u for u in data['users'] if u.get('username') != name]
        if len(data['users']) == before:
            print("✘ 账号 {0} 不存在。".format(name))
            return 1
        save_users(data)
        print("✔ 已删除账号 {0}。".format(name))
        return 0

    return None  # 无 CLI 参数, 正常启动服务

# ---------------------------- 启动 ----------------------------

def run():
    if sys.platform.startswith('win'):
        try:
            sys.stdout.reconfigure(encoding='utf-8')
            sys.stderr.reconfigure(encoding='utf-8')
        except Exception:
            pass

    cli_code = run_cli(sys.argv)
    if cli_code is not None:
        sys.exit(cli_code)

    ensure_default_user()

    server_address = ("0.0.0.0", PORT)
    httpd = http.server.ThreadingHTTPServer(server_address, CORSProxyHandler)
    print("==================================================================")
    print("  [*] IceBreaker - LLM API 与 GPU 压测平台 (登录鉴权 + CORS 中继) 已启动")
    print(f"  [*] 本地访问:  http://127.0.0.1:{PORT}  (未登录将自动跳转登录页)")
    print(f"  [*] 代理中继:  http://127.0.0.1:{PORT}/proxy?url=<TargetAPI>")
    print(f"  [*] 账号文件:  {USERS_FILE}")
    print(f"  [*] 账号管理:  python server.py --add-user/--list-users/--del-user")
    print("==================================================================")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n正在停止服务器...")
        httpd.server_close()

if __name__ == "__main__":
    run()
