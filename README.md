# 🧊 IceBreaker — LLM API 与 GPU 服务器全方位性能压力与基准评测系统

一站式压测平台,覆盖三大测试对象:

- **LLM API 压测**: 兼容 OpenAI 规范的各类网关 —— OpenAI、DeepSeek、SiliconFlow、通义 DashScope、智谱 GLM、Kimi、本地 Ollama / vLLM
- **GPU 服务器压测**: gpu-burn / torch 双引擎满载烤机 + 15 秒级遥测采样 + 上架验收报告,支持**多台机器同时并发压测**
- **NPU 服务器压测(昇腾)**: npu-smi 基线健康检查 + ascend-dmi 满载 + 验收报告,工作流与 GPU 完全同构

登录后选择压测对象卡片进入对应工作台,支持白天/夜间双主题,所有弹窗均为项目内样式。

---

## 🌟 核心特性

### LLM API 压测
- **并发阶梯矩阵 (1/5/10/20/50/100)**: 闭环饱和并发,实测 RPS/RPM、TPS/TPM、TTFT(首字耗时)、TPOT、P50/P90/P99 延迟分布
- **长上下文极限探测**: 结构化长文本梯度注入 + 针尖探针(Needle In A Haystack)校验,验证注意力是否真的有效而非仅 HTTP 200
- **单次最大输出探测**: 识别网关侧截断(`finish_reason` 判定 length/stop),实测持续解码速率
- **智能诊断**: Sweet Spot 最佳并发推荐、压力拐点定位(429 限流边界 / P90 突变点)、落地建议

### GPU 服务器压测
- **双压测引擎**: `gpu-burn`(需 CUDA toolkit,支持所有 NVIDIA 卡)或 `torch 满载`(免 CUDA 编译,只需 PyTorch,可选 **FP16/FP32** 计算精度,FP32 与 gpu-burn 同口径);吞吐(GFLOPS)解析兼容新/旧 gpu-burn 与 torch 三种输出格式
- **多机并发**: 粘贴/表格批量导入机器,一键同时压测,机器数不设上限(同机在途任务自动防重复)
- **三种录入方式**: 批量粘贴(密码模式 / 密钥模式两个识别按钮)、CSV/Excel 表格导入(含模板下载)、手动加行;密钥可页面上传(全局+单机)
- **双认证**: 密码或密钥登录(Linux/Windows 密钥路径均可),「sudo 提权」开关支持免密 sudo;密钥登录时密码可仅用于 sudo
- **单机启动**: 每台机器一个「启动」按钮,可逐台发起;也有「启动全部」
- **实时遥测**: 每台机器独立任务块 —— 阶段(硬件巡检中 → GPU 满载压测中 → 脚本收尾中)、进度、逐卡温度/功耗/利用率(≥85℃ 标红)、单独停止
- **稳健传输**: SFTP 被禁用的机器自动降级 exec+base64 传输;SSH 瞬时断连自动重试
- **报告自动化**: 跑完秒级出报告 —— KPI 磁贴、逐卡遥测算力表、全卡温度/功耗/SM 时钟**可交互平滑曲线**(图例点击显隐/悬停十字线数值/可折叠数据表/85℃ 告警线)、明暗双主题、WARN 自动甄别(AER 误报/内核噪声/热降频)、结论建议;时间统一北京时间
- **报告管理**: 单台在线查看(浏览器直达 URL)/导出 HTML·MD·PDF;**一键 ZIP 打包全部报告**(按 内网IP_端口 命名);一键清空历史记录(含执行错误记录)

### NPU 服务器压测(昇腾)
- 工作流与 GPU 工作台**完全同构**: 批量粘贴/表格导入/逐台启动/实时遥测/自动报告/ZIP 导出/清空历史
- 基线健康检查(npu-smi 温度/功耗/算力利用率)→ ascend-dmi 满载 → 压后复检,无 ToolBox 时降级为仅基线并给出安装指引
- 页面内 **MindX ToolBox 一键安装**(把 CANN/ToolBox `.run` 安装包放进 `packages/` 目录,平台自动上传安装)

### 平台能力
- 登录鉴权(PBKDF2 哈希存储、页面内自助改密、24h 滑动会话)
- 白天/夜间主题切换(跟随系统 + 手动记忆)
- HTML / Markdown / PDF 三格式报告(html2pdf 本地渲染,中文无乱码;全资源本地化,离线可用)

---

## 🚀 部署指南(详细)

### 部署方式总览

| 方式 | 适用场景 | 前置条件 |
|---|---|---|
| ① 拉取镜像部署 | 生产/服务器,**推荐** | Docker |
| ② 源码构建部署 | 需要自定义修改后构建 | Docker + git |
| ③ Windows 本地运行 | 办公机快速使用 | Python 3.7+ |
| ④ 打包单文件 exe | Windows 免安装分发 | 按需执行 |

---

### 方式一:拉取镜像部署(推荐)

镜像地址:`registry.cn-hangzhou.aliyuncs.com/zznn/llm-icebreaker:latest`

**1. 拉取镜像**
```bash
docker pull registry.cn-hangzhou.aliyuncs.com/zznn/llm-icebreaker:latest
```

**2. 启动(二选一)**

A. `docker run` 一条命令:
```bash
docker run -d \
  --name icebreaker \
  -p 8765:8765 \
  -v icebreaker-data:/data \
  --restart unless-stopped \
  registry.cn-hangzhou.aliyuncs.com/zznn/llm-icebreaker:latest
```

| 参数 | 说明 |
|---|---|
| `-p 8765:8765` | 端口映射(宿主机:容器);改端口如 `-p 9000:8765` |
| `-v icebreaker-data:/data` | 账号数据持久化卷(users.json),重建/升级容器不丢失 |
| `--restart unless-stopped` | 宿主机重启后自动拉起 |

B. `docker compose`(仓库根目录已提供 `docker-compose.image.yml`):
```bash
# 默认 8765 端口
docker compose -f docker-compose.image.yml up -d
# 自定义端口
ICE_PORT=9000 docker compose -f docker-compose.image.yml up -d
```

**3. 密钥登录的机器(如需)**:密钥路径是**容器内路径**,需先挂载:
```bash
docker run -d --name icebreaker -p 8765:8765 -v icebreaker-data:/data \
  -v /root/keys:/keys:ro \
  --restart unless-stopped \
  registry.cn-hangzhou.aliyuncs.com/zznn/llm-icebreaker:latest
# 平台里密钥路径填 /keys/id_rsa
```

**4. 访问与首登**:浏览器打开 `http://<服务器IP>:8765`,默认账号 `admin / admin123`,**登录后立即点右上角「改密」修改**。

**5. 升级**:
```bash
docker compose -f docker-compose.image.yml pull && \
docker compose -f docker-compose.image.yml up -d
```

**6. 运维常用**:
```bash
docker compose -f docker-compose.image.yml logs -f    # 日志
docker compose -f docker-compose.image.yml down       # 停止(数据卷保留)
```

---

### 方式二:源码构建部署

```bash
git clone <仓库地址> icebreaker && cd icebreaker && ./run.sh
```

`run.sh` 自动完成:Docker 环境检查 → 构建镜像(利用层缓存,改动小时秒级)→ 启动容器 → 健康检查(最长 60s)→ 打印访问地址与初始账号;失败自动输出容器日志。

- 自定义端口:`ICE_PORT=9000 ./run.sh`
- 免 clone 管道模式:`curl -fsSL <仓库raw地址>/run.sh | bash -s -- <git仓库地址>`
- 日常升级同一条:`git pull && ./run.sh`
- 等价手动操作:`docker compose up -d --build`(compose 文件内置数据卷与重启策略)

> 构建说明:Dockerfile 基于 `python:3.12-slim`,内置 paramiko(GPU SSH 压测)与 gpu-burn 离线源码包;`vendor/` 前端依赖全部本地化,构建与运行均不需要外网(除基础镜像拉取)。

---

### 方式三:Windows 本地运行

**最简单**:双击 `start.bat` —— 自动清理端口占用残留 → 启动服务 → 打开浏览器 `http://127.0.0.1:8765`。

或手动:
```bash
python server.py            # 默认 8765 端口
BENCH_PORT=9000 python server.py   # 自定义端口 (cmd: set BENCH_PORT=9000)
```

- 要求 Python 3.7+(纯标准库即可跑;GPU SSH 压测需 `pip install paramiko`)
- 首次启动自动创建账号 `admin / admin123`(存于脚本同目录 `users.json`)

**账号管理(命令行)**:
```bash
python server.py --add-user alice     # 添加/重置账号 (交互输密码, ≥6位)
BENCH_PASSWORD=NewPass python server.py --add-user alice   # 非交互(自动化)
python server.py --list-users         # 列出账号
python server.py --del-user alice     # 删除账号
```
改自己的密码优先用页面:登录后右上角「改密」按钮(验证原密码,即时生效)。

**环境变量**:`BENCH_PORT`(端口)、`BENCH_DATA_DIR`(users.json 目录)。

---

### 方式四:打包 Windows 单文件 exe(按需)

```bash
build_exe.bat     # 或 python build_exe.py
```
产出 `dist/LLM-Benchmark-Server.exe`,双击即起完整服务,目标机免装 Python;`users.json` 在 exe 同目录,升级替换不丢账号。

### 镜像发布(维护者)

```bash
docker compose build
docker tag llm-benchmark:latest registry.cn-hangzhou.aliyuncs.com/zznn/llm-icebreaker:latest
docker login registry.cn-hangzhou.aliyuncs.com
docker push registry.cn-hangzhou.aliyuncs.com/zznn/llm-icebreaker:latest
```

---

## 📝 使用指南

### LLM API 压测工作台

1. 左侧填 Base URL / API Key / 模型(可拉取列表或用预设)→「验证连接」
2. 选模式:一键全方位 / 并发阶梯 / 长文本极限 / 最大输出 → 开始
3. 右侧实时 KPI、图表、阶梯表;完成后右上角导出 JSON / HTML / PDF 或复制 Markdown

### GPU 服务器压测工作台

1. **录入机器**(三选一,左侧):
   - 批量粘贴:每行 `IP 端口 用户名 密码` 或 `IP 端口 用户名 密钥路径`,点对应识别按钮(第4段=密码 / 第4段=密钥路径,支持 Windows 路径)
   - 表格导入:下载模板 → 填好 → 导入(CSV/Excel)
   - 手动「+ 添加服务器」
2. 按需开启每行「sudo 提权」开关(root 自动禁用;免密 sudo 则密码留空)
3. 选**压测引擎**: `gpu-burn`(机器有 CUDA toolkit)/ `torch 满载`(机器有 PyTorch;选 torch 时可再选 **FP16 吞吐最高 / FP32 与 gpu-burn 同口径**)
4. 选压测时长(1 分钟冒烟 / 5 / 10 / 30 标准 / 60 分钟)→ 逐台「启动」或「启动全部压测」
5. 右侧任务区实时看遥测;每台跑完自动出结果卡(结论徽章 + KPI + 逐卡表 + 甄别摘要)
6. 结果区操作:**在线查看**(浏览器打开报告)/ 单台导出 HTML·MD·PDF / **下载全部报告 ZIP(按 内网IP_端口 命名)** / **清空历史记录**
7. 无法 SSH 的机器:页面下载 `gpu_check.sh` + `gpu-burn.tar.gz` 放服务器 `/tmp` 执行 `sudo ./gpu_check.sh 1800`,跑完上传三件产物手动解析

> 引擎选择:有 CUDA toolkit → gpu-burn;只有 PyTorch → torch;两者都没有 → 装 PyTorch 最简单(免编译,`pip3 install torch`,装在 SSH 登录所用的用户下)。

> 时长说明:所选时长仅是**烧卡段**;脚本前有硬件巡检(约 1~2 分钟)、后有汇总,进度条会按「硬件巡检中 → GPU 满载压测中 → 脚本收尾中」分阶段显示。

### NPU 服务器压测工作台(昇腾)

操作与 GPU 工作台完全一致(录入机器 → 选时长 → 逐台启动 → 自动报告 → ZIP/清空);两点差异:

- 远端需有 `npu-smi`;满载依赖 `ascend-dmi`(MindX ToolBox),没有时自动降级为仅基线检查并在报告标注
- **ToolBox 在线安装**:从 hiascend.com 下载 CANN/ToolBox `.run` 放进平台 `packages/` 目录,工作台点「安装 ToolBox」自动上传安装

---

## ❓ 常见问题

| 问题 | 说明 |
|---|---|
| 重启后要重新登录 | 会话存内存(安全设计),24h 滑动过期 |
| 页面显示旧版界面 | 浏览器缓存,`Ctrl+F5` 强刷一次 |
| 8765 端口被占 | `start.bat` 会自动清理残留进程;手动:`netstat -ano \| findstr 8765` 后 taskkill |
| 同公网 IP 不同端口的多台机器 | 完全支持,任务与报告按 `IP:端口` 区分,报告按 `内网IP_端口` 命名 |
| 某台机器 SFTP 被禁用 | 自动降级 exec+base64 传输,任务块会标注传输方式 |
| 批量启动偶发某台失败 | 网关/NAT 瞬时限流,平台已自动重试一次;对该台单独再点「启动」即可 |
| 正在压测的机器再点启动 | 弹项目内警告且点击不生效(前后端双重拦截) |
| 压测对服务器的影响 | 仅 GPU 满载(硬件保护全程在岗);系统零改动,只在 `/tmp` 留几 MB 产物,错峰生产业务即可 |
| 引擎怎么选(gpu-burn / torch) | 有 CUDA toolkit → gpu-burn;只有 PyTorch → torch;都没有 → 装 torch 最简单(免编译) |
| torch 引擎报「找不到带 CUDA torch 的 Python」 | 机器没装 PyTorch,或装在了别的用户名下 —— 报错会**直接指明 torch 在哪个用户与路径**,按提示换用户/关 sudo 或安装即可 |
| 报告里 ECC 显示「未检测」 | 消费级 GPU(GeForce 系列)硬件无 ECC,属正常;数据中心卡(H20/H100/A100)会显示实际 CE/UE 计数 |

---

## 📁 目录结构

```
IceBreaker/
├── index.html / login.html     # 主页面(入口卡片/三大工作台) / 登录页
├── style.css / app.js          # 样式(昼夜主题) / 交互控制器
├── stress-engine.js            # LLM 压测引擎
├── analyzer.js                 # LLM 分析诊断 (Sweet Spot/拐点)
├── report-builder.js           # LLM 报告生成器 (HTML/MD/PDF)
├── gpu_agent.py                # GPU 多机并发编排 + 产物解析 (paramiko)
├── gpu-report-builder.js       # GPU 报告生成器 (KPI磁贴/交互曲线/甄别)
├── gpu_check.sh                # 远端压测脚本 (硬件巡检+gpu-burn+遥测)
├── torch_wrapper.sh            # torch 引擎远端脚本 (FP16/FP32, 产物格式与 gpu-burn 对齐)
├── npu_agent.py / npu_check.sh / npu-report-builder.js   # NPU(昇腾) 同构模块
├── server.py                   # 后端: 静态托管/登录鉴权/CORS代理/报告托管 (纯标准库)
├── vendor/                     # 本地化依赖: Chart.js / html2pdf / xlsx / fflate / gpu-burn 源码包
├── packages/                   # (可选) NPU CANN/ToolBox .run 安装包存放处
├── Dockerfile / docker-compose.yml / docker-compose.image.yml / run.sh
├── start.bat / build_exe.py / DEPLOY.md
└── headless-bench.mjs          # LLM 命令行无头压测
```

---

## 🔐 安全说明

- 账号密码 PBKDF2-HMAC-SHA256 哈希存储,绝不存明文;SSH 凭据仅存服务进程内存,重启即清
- LLM API Key 仅保存在你的浏览器 LocalStorage,直接发往目标 API
- 报告在线查看链接需登录会话才能访问;建议部署在内网并尽快修改默认密码
