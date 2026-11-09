#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
NPU(昇腾) 压测编排模块 — 与 gpu_agent.py 同构但完全独立, 不影响 GPU 链路
- NpuJob / NpuJobPool: SSH 远程执行 npu_check.sh (基线 + ascend-dmi 满载)
- ToolboxInstaller: 上传本地 .run 安装包并安装 CANN/MindX ToolBox
- parse_npu_artifacts: 解析 npu_check.sh 三件产物 → 结构化 JSON
- packages/ 目录: 用户从昇腾官网下载配套版本安装包放入 (不入库/镜像)
"""

import os
import re
import time
import shlex
import glob
import threading
import datetime
import secrets

from gpu_agent import _try_float, parse_telemetry, _parse_ts, _to_beijing, _apply_offset, _thin

# ================================ 产物解析 ================================

def parse_npu_report_txt(txt):
    """REPORT_*.txt → 基础事实 + PASS/WARN/FAIL 条目"""
    info = {"passItems": [], "warnItems": [], "failItems": [], "cards": []}
    lines = (txt or "").splitlines()
    for ln in lines:
        s = ln.strip()
        pm = re.match(r"^\[(PASS|WARN|FAIL)\]\s*(.+)$", s)
        if pm:
            key = {"PASS": "passItems", "WARN": "warnItems", "FAIL": "failItems"}[pm.group(1)]
            info[key].append(pm.group(2).strip())
            continue
        if "NPU 数量" in s and ":" in s:
            info["npuCount"] = int(_try_float(s.split(":", 1)[1]) or 0)
        if s.strip().startswith("型号") and ":" in s:
            info["model"] = s.split(":", 1)[1].strip()
        if "压测启动" in s:
            mm = re.search(r"(\d{4}[-/]\d{2}[-/]\d{2}[T ][\d:.]+)([+-]\d{2}:?\d{2})?", s)
            if mm:
                info["burnStart"] = mm.group(1); info["burnStartTz"] = mm.group(2)
        if "压测结束" in s:
            mm = re.search(r"(\d{4}[-/]\d{2}[-/]\d{2}[T ][\d:.]+)([+-]\d{2}:?\d{2})?", s)
            if mm:
                info["burnEnd"] = mm.group(1); info["burnEndTz"] = mm.group(2)
        if "上架结论" in s:
            info["scriptVerdict"] = s.split("上架结论")[-1].strip(" :>：<")
    return info


def parse_npu_artifacts(report_txt, telemetry_csv, burn_log, enrich=None):
    """NPU 三件产物 → 报告用结构化 JSON"""
    enrich = enrich or {}
    rep = parse_npu_report_txt(report_txt)
    tele = parse_telemetry(telemetry_csv)     # 遥测 CSV 与 GPU 同构, 直接复用

    npus = {}
    for idx in sorted(set(list(tele.keys())) | set([str(i) for i in range(int(rep.get("npuCount") or 0))])):
        t = tele.get(str(idx), {}) or {}
        g = npus.setdefault(str(idx), {"index": int(_try_float(idx) or 0)})
        g["tmax"] = t.get("tmax")
        g["pmax"] = t.get("pmax")
        g["hbmMax"] = t.get("tmax") and None  # 占位, 下面从 util 序列取
        g["sampleCount"] = t.get("sampleCount", 0)
        g["series"] = t.get("series", [])
        # HBM 峰值 = util 列峰值
        utils = [p.get("util") for p in (t.get("series") or []) if p.get("util") is not None]
        g["hbmMax"] = max(utils) if utils else None

    npu_list = sorted(npus.values(), key=lambda g: g["index"])

    # 甄别 (规则引擎, 同 GPU 风格)
    adjudications = []
    for it in rep.get("failItems", []):
        adjudications.append({"level": "FAIL", "text": it, "cls": "fail", "note": "脚本判定失败项, 需排查处理"})
    for it in rep.get("warnItems", []):
        if "ascend-dmi" in it or "未执行满载" in it:
            cls, note = "env", "目标机未安装 MindX ToolBox (ascend-dmi), 本次仅基线健康检查; 可在平台点「安装 MindX ToolBox」后重测"
        elif "峰值温度" in it:
            cls, note = "real", "峰值温度达到告警阈值, 关注该卡散热"
        elif "返回码" in it:
            cls, note = "env", "ascend-dmi 执行异常, 详见 npu_burn.log"
        else:
            cls, note = "env", "自动规则未覆盖, 请人工复核"
        adjudications.append({"level": "WARN", "text": it, "cls": cls, "note": note})

    dmi_missing = any("ascend-dmi" in w or "未执行满载" in w for w in rep.get("warnItems", []))
    fails = [a for a in adjudications if a["cls"] == "fail"]
    reals = [a for a in adjudications if a["cls"] == "real"]
    if fails:
        verdict, verdictCls = "不通过 (FAIL)", "fail"
    elif dmi_missing and not reals:
        verdict, verdictCls = "有条件通过 (仅基线检查)", "warn"
    elif reals or not dmi_missing:
        verdict, verdictCls = ("通过 (附 {} 项观察)".format(len(reals)) if reals else "通过", "warn" if reals else "pass")

    all_tmax = [g["tmax"] for g in npu_list if g.get("tmax") is not None]
    all_pmax = [g["pmax"] for g in npu_list if g.get("pmax") is not None]
    t1 = _apply_offset(_parse_ts(rep.get("burnStart") or ""), rep.get("burnStartTz"))
    t2 = _apply_offset(_parse_ts(rep.get("burnEnd") or ""), rep.get("burnEndTz"))
    duration = int((t2 - t1).total_seconds()) if (t1 and t2) else None

    recs = []
    if dmi_missing:
        recs.append({"prio": "中", "text": "该机未安装 MindX ToolBox, 本次仅基线检查; 在平台 NPU 工作台点「安装 MindX ToolBox」自动安装后重测获取满载数据"})
    hot = [g["index"] for g in npu_list if (g.get("tmax") or 0) >= 80]
    if hot:
        recs.append({"prio": "中", "text": "NPU{} 峰值温度≥80℃: 检查风道/风扇, 建议复验".format(",".join(map(str, hot)))})
    recs.append({"prio": "中", "text": "上架后将健康状态/温度纳入例行监控, 以本次数据为基线"})

    return {
        "device": "npu",
        "meta": {
            "hostname": enrich.get("hostname"),
            "hostIps": enrich.get("hostIps") or [],
            "sshHost": enrich.get("sshHost"), "sshPort": enrich.get("sshPort"),
            "model": rep.get("model") or enrich.get("model"),
            "npuCount": int(rep.get("npuCount") or len(npu_list) or 0),
            "burnStart": _to_beijing(rep.get("burnStart"), rep.get("burnStartTz")),
            "burnEnd": _to_beijing(rep.get("burnEnd"), rep.get("burnEndTz")),
            "durationSec": duration,
            "source": enrich.get("source", "manual"),
            "remoteDir": enrich.get("remoteDir"),
            "generatedAt": datetime.datetime.now().isoformat(timespec="seconds"),
        },
        "burn": {
            "dmiMissing": dmi_missing,
            "passCount": len(rep.get("passItems", [])),
            "warnCount": len(rep.get("warnItems", [])),
            "failCount": len(rep.get("failItems", [])),
            "scriptVerdict": rep.get("scriptVerdict"),
        },
        "summary": {
            "tmaxAll": max(all_tmax) if all_tmax else None,
            "tmaxCard": (max(npu_list, key=lambda g: g.get("tmax") or 0)["index"] if all_tmax else None),
            "pmaxAll": max(all_pmax) if all_pmax else None,
        },
        "npus": npu_list,
        "adjudications": adjudications,
        "recommendations": recs,
        "verdict": verdict,
        "verdictCls": verdictCls,
    }


# ================================ SSH 编排 ================================

def _try_import_paramiko():
    import paramiko
    return paramiko


class NpuJob:
    """单台 NPU 机器的压测任务 (与 GpuJob 同构, 独立实现避免影响 GPU)"""

    def __init__(self, job_id, script_path, cfg):
        self.id = job_id
        self.script_path = script_path
        self.cfg = dict(cfg)
        self.use_sudo = bool(cfg.get("useSudo"))
        self._lock = threading.RLock()
        self._ssh = None
        self._sftp = None
        self._cfg_pw = self.cfg.get("password") or ""
        _port = int(cfg.get("port") or 22)
        _host_label = "{}:{}".format(cfg.get("host"), _port) if _port != 22 else cfg.get("host")
        self.state = {
            "phase": "connecting", "device": "npu",
            "host": _host_label, "username": cfg.get("username"),
            "burnSeconds": int(cfg.get("burnSeconds", 1800)),
            "remoteDir": None, "startedAt": time.time(), "endedAt": None,
            "error": None, "result": None, "live": [], "progress": 0, "stage": "connecting",
        }

    def snapshot(self, with_result=False):
        with self._lock:
            st = dict(self.state)
            if not with_result:
                st.pop("result", None)
            st["id"] = self.id
            st["elapsed"] = int(time.time() - st["startedAt"]) if st.get("startedAt") else 0
            st["hasResult"] = bool(self.state.get("result"))
            if st.get("phase") == "running" and not st.get("stage"):
                st["stage"] = "preparing"
            return st

    def _set(self, **kw):
        with self._lock:
            self.state.update(kw)

    def _exec(self, cmd, timeout=12):
        with self._lock:
            if not self._ssh:
                raise RuntimeError("SSH 会话不存在")
            stdin, stdout, stderr = self._ssh.exec_command(cmd, timeout=timeout)
            chan = stdout.channel
            if not chan.status_event.wait(timeout + 3):
                try:
                    chan.close()
                except Exception:
                    pass
                raise TimeoutError("远端命令超时({}s): {}".format(timeout, cmd[:60]))
            rc = chan.exit_status
            return rc, stdout.read().decode("utf-8", "replace"), stderr.read().decode("utf-8", "replace")

    def _sudo_prefix(self):
        if not self.use_sudo:
            return ""
        pw = self._cfg_pw or ""
        if not pw:
            return "sudo "
        return "printf '%s\\n' {} | sudo -S -p '' ".format(shlex.quote(pw))

    def _upload_file(self, local_path, remote_path, mode=None):
        try:
            sftp = self._sftp or (self._ssh.open_sftp() if self._ssh else None)
        except Exception:
            sftp = None
        if sftp is not None:
            try:
                sftp.put(local_path, remote_path)
                if mode is not None:
                    sftp.chmod(remote_path, mode)
                with self._lock:
                    self._sftp = sftp
                return True
            except Exception:
                pass
        import base64 as _b64
        data = _b64.b64encode(open(local_path, "rb").read()).decode("ascii")
        size = os.path.getsize(local_path)
        rq = shlex.quote(remote_path)
        self._exec("rm -f {r}".format(r=rq))
        CH = 48000
        chunks = [data[i:i + CH] for i in range(0, len(data), CH)] or [""]
        for i, chunk in enumerate(chunks):
            op = ">" if i == 0 else ">>"
            self._exec("printf '%s' '{c}' | base64 -d {op} {r}".format(c=chunk, op=op, r=rq), timeout=60)
        if mode is not None:
            self._exec("chmod {m:o} {r}".format(m=mode, r=rq))
        _, out, _ = self._exec("stat -c %s {r} 2>/dev/null || wc -c < {r}".format(r=rq))
        if out.strip() != str(size):
            raise RuntimeError("exec 降级上传校验失败: {}".format(remote_path))
        return False

    def _download_file(self, remote_path):
        sftp = self._sftp
        if sftp is not None:
            try:
                with sftp.open(remote_path, "r") as f:
                    return f.read().decode("utf-8", "replace")
            except Exception:
                pass
        rc, out, _ = self._exec("base64 -w0 {r} 2>/dev/null".format(r=shlex.quote(remote_path)), timeout=120)
        import base64 as _b64
        return _b64.b64decode(out.strip() or "").decode("utf-8", "replace")

    def start(self):
        threading.Thread(target=self._run, daemon=True).start()

    def _run(self):
        try:
            paramiko = _try_import_paramiko()
        except ImportError:
            self._set(phase="error", error="后端未安装 paramiko (pip install paramiko)")
            return
        self._paramiko = paramiko
        last_err = None
        for attempt in (1, 2):
            try:
                self._run_once()
                return
            except paramiko.AuthenticationException:
                self._set(phase="error", error="SSH 认证失败: 用户名/密码/密钥不匹配")
                self._close()
                return
            except Exception as e:
                last_err = e
                if attempt == 1:
                    with self._lock:
                        self.state["lastPollError"] = "启动瞬时失败({}), 3 秒后自动重试…".format(str(e))[:120]
                    self._set(phase="connecting")
                    self._close()
                    time.sleep(3)
                    continue
        self._set(phase="error", error="SSH 连接/启动失败(已自动重试 1 次): {}".format(last_err))
        self._close()

    def _run_once(self):
        paramiko = self._paramiko
        self._cfg_pw = self.cfg.get("password") or ""
        cfg = self.cfg
        ssh = paramiko.SSHClient()
        ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
        kwargs = {"hostname": cfg["host"], "port": int(cfg.get("port", 22)),
                  "username": cfg.get("username"), "timeout": 15,
                  "allow_agent": False, "look_for_keys": False}
        if cfg.get("keyPath"):
            kwargs["key_filename"] = cfg["keyPath"]
        else:
            kwargs["password"] = cfg.get("password")
        ssh.connect(**kwargs)
        with self._lock:
            self._ssh = ssh

        self._set(phase="uploading")
        remote_dir = "/tmp/npubench_{}_{}".format(
            datetime.datetime.now().strftime("%Y%m%d_%H%M%S"), self.id[-6:])
        self._exec("mkdir -p {}".format(shlex.quote(remote_dir)))
        via_sftp = self._upload_file(self.script_path, remote_dir + "/npu_check.sh", mode=0o755)
        self._set(remoteDir=remote_dir,
                  lastNote=("传输方式: sftp" if via_sftp else "传输方式: exec+base64"))

        sudo = self._sudo_prefix()
        launch = ("cd {d} && {sudo}bash -c 'nohup bash {d}/npu_check.sh {sec} > {d}/hwcheck.out 2>&1 &'"
                  ).format(d=shlex.quote(remote_dir), sudo=sudo, sec=int(cfg.get("burnSeconds", 1800)))
        rc, out, err = self._exec(launch, timeout=20)
        time.sleep(2)
        rc2, out2, _ = self._exec("pgrep -fc 'npu_check[.]sh' || true")
        if rc2 == 0 and out2.strip() in ("", "0"):
            self._set(phase="error", error="远端压测进程启动失败: " + (err.strip() or out.strip() or "未知原因")[:200])
            self._close()
            return
        self._set(phase="running", stage="preparing")
        self._start_refresher()

    def status(self):
        return self.snapshot()

    def _start_refresher(self):
        def loop():
            fail_streak = 0
            while True:
                with self._lock:
                    phase = self.state.get("phase")
                if phase not in ("running", "collecting"):
                    return
                try:
                    self._refresh_once()
                    fail_streak = 0
                except Exception as e:
                    fail_streak += 1
                    with self._lock:
                        self.state["lastPollError"] = str(e)[:200]
                    if fail_streak >= 10:
                        self._set(phase="error", error="远端状态轮询连续失败: " + str(e)[:150])
                        self._close()
                        return
                time.sleep(5)
        threading.Thread(target=loop, daemon=True).start()

    def _refresh_once(self):
        _, pg, _ = self._exec("pgrep -f 'npu_check[.]sh' >/dev/null && echo RUN || echo EXIT")
        running = pg.strip().endswith("RUN")
        remote_dir = self.state.get("remoteDir") or ""
        _, ls_out, _ = self._exec(
            "ls -t {d}/npucheck_*/REPORT_*.txt 2>/dev/null | head -1".format(d=remote_dir))
        report_path = ls_out.strip().splitlines()[0] if ls_out.strip() else None

        live = []
        if report_path:
            hw_dir = os.path.dirname(report_path)
            _, tl, _ = self._exec(
                "tail -n 80 {h}/npu_telemetry.csv 2>/dev/null".format(h=shlex.quote(hw_dir)))
            latest = {}
            for ln in (tl or "").strip().splitlines():
                parts = [p.strip() for p in ln.split(",")]
                if len(parts) >= 5 and parts[1].isdigit():
                    latest[parts[1]] = parts
            for idx, p in sorted(latest.items(), key=lambda kv: int(kv[0])):
                live.append({"index": int(idx), "temp": _try_float(p[2]),
                             "pwr": _try_float(p[3]), "util": _try_float(p[4]),
                             "clk": _try_float(p[6]) if len(p) > 6 else None})

        elapsed = int(time.time() - (self.state.get("startedAt") or time.time()))
        total = max(1, self.state.get("burnSeconds", 1))
        if live:
            stage = "burning" if elapsed <= total + 15 else "finalizing"
            progress = min(95, int(elapsed / total * 100)) if elapsed <= total else 96
        else:
            stage = "preparing"
            progress = min(5, int(elapsed / total * 100))
        self._set(live=live, progress=progress, stage=stage)

        if report_path and not running:
            with self._lock:
                if self.state.get("phase") == "running":
                    self._set(phase="collecting")
                    threading.Thread(target=self._collect, args=(report_path,), daemon=True).start()

    def _collect(self, report_path):
        try:
            st = self.state
            cfg_pw = self._cfg_pw or ""
            hw_dir = os.path.dirname(report_path)
            if self._ssh is None and self._sftp is None:
                raise RuntimeError("SSH 会话已关闭")

            def get(remote):
                return self._download_file(remote)

            _, ls_csv, _ = self._exec("ls -t {d}/npucheck_*/npu_telemetry.csv 2>/dev/null | head -1".format(
                d=shlex.quote(st.get("remoteDir") or "")))
            _, ls_log, _ = self._exec("ls -t {d}/npucheck_*/npu_burn.log 2>/dev/null | head -1".format(
                d=shlex.quote(st.get("remoteDir") or "")))
            report_txt = get(report_path)
            telemetry_csv = get(ls_csv.strip().splitlines()[0]) if ls_csv.strip() else ""
            burn_log = get(ls_log.strip().splitlines()[0]) if ls_log.strip() else ""

            sudo = self._sudo_prefix()
            _, host_out, _ = self._exec("hostname")
            _, ips_out, _ = self._exec("hostname -I 2>/dev/null || hostname --all-ip-addresses 2>/dev/null")
            host_ips = [x for x in (ips_out or "").split() if x]
            _, model_out, _ = self._exec(
                "npu-smi info 2>/dev/null | grep -oE '910[A-Z0-9]*|310P[0-9]*' | sort -u | paste -sd, -")

            parsed = parse_npu_artifacts(
                report_txt, telemetry_csv, burn_log,
                enrich={
                    "source": "ssh", "hostname": host_out.strip(),
                    "hostIps": host_ips,
                    "sshHost": self.cfg.get("host"), "sshPort": int(self.cfg.get("port") or 22),
                    "model": model_out.strip() or None,
                    "remoteDir": hw_dir,
                })
            parsed["jobId"] = self.id
            self._set(phase="done", result=parsed, progress=100, endedAt=time.time())
        except Exception as e:
            self._set(phase="error", error="产物收集/解析失败: {}".format(e)[:300])
        finally:
            self._close()

    def stop(self):
        try:
            sudo = self._sudo_prefix()
            self._exec("{s}pkill -f 'npu_check[.]sh' 2>/dev/null; {s}pkill -f 'ascend-dmi' 2>/dev/null; true".format(s=sudo))
        except Exception:
            pass
        self._set(phase="stopped", endedAt=time.time())
        self._close()
        return True, "已发送停止指令"

    def _close(self):
        with self._lock:
            for attr in ("_sftp", "_ssh"):
                obj = getattr(self, attr, None)
                if obj is not None:
                    try:
                        obj.close()
                    except Exception:
                        pass
                setattr(self, attr, None)
            self._cfg_pw = None


class ToolboxInstallJob:
    """MindX ToolBox 安装任务: 探测→上传本地 .run→安装→验证 (独立状态机)"""

    def __init__(self, job_id, packages_dir, cfg):
        self.id = job_id
        self.packages_dir = packages_dir
        self.cfg = dict(cfg)
        self.use_sudo = True   # 安装必须 root
        self._lock = threading.RLock()
        self._ssh = None
        self._sftp = None
        self._cfg_pw = cfg.get("password") or ""
        _port = int(cfg.get("port") or 22)
        self.state = {
            "phase": "connecting", "device": "npu-install",
            "host": "{}:{}".format(cfg.get("host"), _port) if _port != 22 else cfg.get("host"),
            "username": cfg.get("username"),
            "progress": 0, "note": "", "error": None, "result": None,
            "startedAt": time.time(), "endedAt": None,
        }

    def snapshot(self, with_result=True):
        with self._lock:
            st = dict(self.state)
            st["id"] = self.id
            st["elapsed"] = int(time.time() - st["startedAt"])
            st["hasResult"] = bool(self.state.get("result"))
            return st

    def _set(self, **kw):
        with self._lock:
            self.state.update(kw)

    def _exec(self, cmd, timeout=15):
        stdin, stdout, stderr = self._ssh.exec_command(cmd, timeout=timeout)
        chan = stdout.channel
        if not chan.status_event.wait(timeout + 5):
            chan.close()
            raise TimeoutError("远端命令超时: {}".format(cmd[:60]))
        return chan.exit_status, stdout.read().decode("utf-8", "replace"), stderr.read().decode("utf-8", "replace")

    def _sudo(self, cmd, timeout=15):
        pw = self._cfg_pw or ""
        pre = ("printf '%s\\n' {} | sudo -S -p '' ".format(shlex.quote(pw)) if pw else "sudo ")
        return self._exec(pre + cmd, timeout=timeout)

    def run(self):
        """同步执行安装 (由池线程调用)"""
        try:
            self._run_install()
        except Exception as e:
            self._set(phase="error", error=str(e)[:300])
        finally:
            self._close()

    def _run_install(self):
        import paramiko
        cfg = self.cfg
        ssh = paramiko.SSHClient()
        ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
        kwargs = {"hostname": cfg["host"], "port": int(cfg.get("port", 22)),
                  "username": cfg.get("username"), "timeout": 15,
                  "allow_agent": False, "look_for_keys": False}
        if cfg.get("keyPath"):
            kwargs["key_filename"] = cfg["keyPath"]
        else:
            kwargs["password"] = cfg.get("password")
        ssh.connect(**kwargs)
        self._ssh = ssh

        self._set(phase="detecting", note="探测组件…", progress=5)
        _, dmi_out, _ = self._exec(
            "for c in ascend-dmi /usr/local/Ascend/toolbox/latest/Ascend-DMI/bin/ascend-dmi /usr/local/Ascend/toolbox/*/Ascend-DMI/bin/ascend-dmi; do [ -x \"$c\" ] && echo FOUND && exit 0; done; echo MISSING")
        if "FOUND" in dmi_out:
            self._set(phase="done", progress=100, note="ascend-dmi 已存在, 无需安装",
                      result={"alreadyHad": True, "installed": False})
            return
        _, cann_out, _ = self._exec("[ -d /usr/local/Ascend/ascend-toolbox ] && echo TB || echo NO; [ -d /usr/local/Ascend/ascend-toolkit ] && echo CANNN || echo NOC")
        has_cann = "CANNN" in cann_out

        # 本地安装包
        cann_runs = sorted(glob.glob(os.path.join(self.packages_dir, "*cann-toolkit*.run"))
                           + glob.glob(os.path.join(self.packages_dir, "Ascend-cann*.run")))
        tb_runs = sorted(glob.glob(os.path.join(self.packages_dir, "*mindx-toolbox*.run"))
                         + glob.glob(os.path.join(self.packages_dir, "Ascend-mindx*.run")))

        if not has_cann and not cann_runs:
            raise RuntimeError("目标机缺 CANN 且本地 packages/ 无 CANN 安装包 (Ascend-cann-toolkit_*.run), 请下载后放入项目 packages/ 目录")
        if not tb_runs:
            raise RuntimeError("本地 packages/ 无 MindX ToolBox 安装包 (Ascend-mindx-toolbox_*.run), 请从 hiascend.com 下载配套版本后放入项目 packages/ 目录")

        sftp = ssh.open_sftp()
        self._sftp = sftp
        remote_dir = "/tmp/icebreaker_pkgs"
        self._exec("mkdir -p " + remote_dir)

        def upload(local, name, pct_a, pct_b):
            size_mb = os.path.getsize(local) / 1048576
            self._set(phase="uploading", note="上传 {} ({:.0f} MB)…".format(name, size_mb), progress=pct_a)
            try:
                sftp.put(local, remote_dir + "/" + name)
            except Exception:
                ssh_exec = self._ssh
                ssh_exec.exec_command("echo bucket")[2].channel.recv_exit_status()
                raise
            self._set(progress=pct_b, note="已上传 {}".format(name))

        if not has_cann:
            cann_local = cann_runs[0]
            upload(cann_local, os.path.basename(cann_local), 10, 40)
            self._set(phase="installing", note="安装 CANN toolkit (数分钟)…", progress=45)
            rc, out, err = self._sudo(
                "chmod +x {d}/{f} && cd {d} && ./{f} --install > /tmp/cann_install.log 2>&1; tail -3 /tmp/cann_install.log".format(
                    d=remote_dir, f=os.path.basename(cann_local)), timeout=1800)
            if "success" not in (out + err).lower() and rc != 0:
                raise RuntimeError("CANN 安装异常 (rc={}): {}".format(rc, (out or err)[-200:]))

        tb_local = tb_runs[0]
        upload(tb_local, os.path.basename(tb_local), 60, 80)
        self._set(phase="installing", note="安装 MindX ToolBox (数分钟)…", progress=85)
        rc, out, err = self._sudo(
            "chmod +x {d}/{f} && cd {d} && ./{f} --install > /tmp/toolbox_install.log 2>&1; tail -3 /tmp/toolbox_install.log".format(
                d=remote_dir, f=os.path.basename(tb_local)), timeout=1800)
        _, verify, _ = self._exec(
            "for c in /usr/local/Ascend/toolbox/latest/Ascend-DMI/bin/ascend-dmi /usr/local/Ascend/toolbox/*/Ascend-DMI/bin/ascend-dmi ascend-dmi; do [ -x \"$c\" ] && echo FOUND && exit 0; done; echo MISSING")
        if "FOUND" not in verify:
            raise RuntimeError("安装流程结束但未检测到 ascend-dmi; 安装日志尾部: " + (out or err)[-200:])
        self._set(phase="done", progress=100, note="MindX ToolBox 安装成功",
                  result={"alreadyHad": False, "installed": True})

    def _close(self):
        for attr in ("_sftp", "_ssh"):
            obj = getattr(self, attr, None)
            if obj is not None:
                try:
                    obj.close()
                except Exception:
                    pass
            setattr(self, attr, None)


class NpuJobPool:
    """NPU 多机并发任务池 + ToolBox 安装任务池"""

    KEEP_DONE = 60

    def __init__(self, script_path, packages_dir):
        self.script_path = script_path
        self.packages_dir = packages_dir
        os.makedirs(self.packages_dir, exist_ok=True)
        self._lock = threading.Lock()
        self._jobs = {}
        self._installs = {}

    def packages_status(self):
        cann = sorted(glob.glob(os.path.join(self.packages_dir, "*cann*.run")))
        tb = sorted(glob.glob(os.path.join(self.packages_dir, "*mindx-toolbox*.run"))
                    + glob.glob(os.path.join(self.packages_dir, "*toolbox*.run")))
        return {
            "cann": [os.path.basename(x) for x in cann],
            "toolbox": [os.path.basename(x) for x in tb],
            "dir": self.packages_dir,
            "ready": bool(cann or tb),
        }

    def start_job(self, cfg):
        _ACTIVE = ("connecting", "uploading", "running", "collecting")
        with self._lock:
            _hp = (str(cfg.get("host") or "").strip(), int(cfg.get("port") or 22))
            for j in self._jobs.values():
                if j.state.get("phase") in _ACTIVE:
                    jp = (str(j.cfg.get("host") or "").strip(), int(j.cfg.get("port") or 22))
                    if jp == _hp:
                        return None, "该机器({}:{})已有进行中的 NPU 压测任务".format(_hp[0], _hp[1])
            job_id = "n{}{}".format(datetime.datetime.now().strftime("%H%M%S"), secrets.token_hex(3))
            job = NpuJob(job_id, self.script_path, cfg)
            self._jobs[job_id] = job
            finished = [k for k, v in self._jobs.items() if v.state.get("phase") in ("done", "error", "stopped")]
            for k in (finished[:-self.KEEP_DONE] if len(finished) > self.KEEP_DONE else []):
                self._jobs.pop(k, None)
        job.start()
        return job_id, "started"

    def status_all(self):
        with self._lock:
            jobs = list(self._jobs.values())
            installs = list(self._installs.values())
        return [j.status() for j in jobs] + [i.snapshot() for i in installs]

    def stop_job(self, job_id=None):
        if job_id:
            with self._lock:
                job = self._jobs.get(job_id)
            if not job:
                return False, "任务不存在"
            return job.stop()
        with self._lock:
            jobs = list(self._jobs.values())
        stopped = 0
        for j in jobs:
            if j.state.get("phase") in ("connecting", "uploading", "running", "collecting"):
                j.stop()
                stopped += 1
        return True, "已向 {} 个任务发送停止指令".format(stopped)

    def get_result(self, job_id=None):
        if job_id:
            with self._lock:
                job = self._jobs.get(job_id)
            if not job:
                return None, "任务不存在"
        else:
            with self._lock:
                jobs = list(self._jobs.values())
            job = next((j for j in reversed(jobs) if j.state.get("result")), None)
            if not job:
                return None, "暂无结果"
        snap = job.snapshot(with_result=True)
        if snap.get("result"):
            return snap["result"], None
        return None, "该任务暂无结果"

    def clear_finished(self):
        with self._lock:
            finished = [k for k, v in self._jobs.items() if v.state.get("phase") in ("done", "error", "stopped")]
            for k in finished:
                self._jobs.pop(k, None)
            self._installs = {k: v for k, v in self._installs.items() if v.state.get("phase") not in ("done", "error")}
        return True, "已清空 {} 条历史记录".format(len(finished))

    def install_toolbox(self, cfg):
        """发起 MindX ToolBox 安装 (同步在线程中执行, 状态经 status_all 查询)"""
        with self._lock:
            _hp = (str(cfg.get("host") or "").strip(), int(cfg.get("port") or 22))
            for inst in self._installs.values():
                if inst.state.get("phase") in ("connecting", "detecting", "uploading", "installing"):
                    ip = (str(inst.cfg.get("host") or "").strip(), int(inst.cfg.get("port") or 22))
                    if ip == _hp:
                        return None, "该机器已有进行中的安装任务"
            install_id = "i{}{}".format(datetime.datetime.now().strftime("%H%M%S"), secrets.token_hex(3))
            job = ToolboxInstallJob(install_id, self.packages_dir, cfg)
            self._installs[install_id] = job
        threading.Thread(target=job.run, daemon=True).start()
        return install_id, "安装任务已启动"
