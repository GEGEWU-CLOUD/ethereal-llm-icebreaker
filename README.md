# 🧊 IceBreaker — LLM API 与 GPU 全方位性能压力与基准评测系统

专门为大模型 API（兼容 OpenAI 规范）打造的一站式纯前端基准与高并发压测工具。支持直连 **OpenAI、DeepSeek、硅基流动 (SiliconFlow)、阿里通义 DashScope、智谱 GLM、月之暗面 Kimi、本地 Ollama / vLLM** 等各类兼容网关。

---

## 🌟 核心特性与测试维度

### 1. 梯级并发压测矩阵 (5 / 10 / 20 / 50 / 100)
- **多阶梯并发调度**：模拟多客户端同时并发请求，支持自定义测试请求量与 Prompt 复杂度。
- **关键性能指标 (KPI)**：
  - **实际 RPS & RPM**：测量每秒实际处理请求数与等效每分钟请求数。
  - **实际 TPS & TPM**：测量 Token 生成速率（tok/s）与等效每分钟总处理 Token 数。
  - **首字耗时 (TTFT)**：借助流式传输（SSE Stream）毫秒级捕获首个 Token 到达耗时（反映服务端 Prefill 算力与排队延时）。
  - **延迟分布分位数**：精确统计 P50、P90、P99 延迟，杜绝长尾偏差。

### 2. 极限长上下文承载力探测 (64k / 128k / 256k / 512k / 1M)
- **多梯度渐进注入**：自动生成经过 Token 密度校准的结构化长文本（64k、128k、256k、512k 直至 1,048,576 Tokens）。
- **探针验证机制 (Needle In A Haystack)**：在深层上下文注入特征密钥。不仅测试服务端是否返回 `HTTP 200`，更验证模型是否发生注意力弥散或被网关悄默截断。
- **KV Cache 算力评估**：绘制「上下文深度 vs 首字 Prefill 耗时」曲线。

### 3. 单次最大输出极限探测
- **突破标称迷雾**：部分厂商宣称支持 8k/16k 输出，但实际在网关侧配置了 4k 截断。本工具注入深度展开任务，要求模型持续吐出极限 Token。
- **截断原因分析**：抓取 `finish_reason`（`length` 还是 `stop`），输出持续解码速度（tok/s）。

### 4. GPU 服务器压测 (hardware_check / gpu-burn)
- **SSH 全自动模式**:页面填 SSH 主机/账号,自动上传 `gpu_check.sh` + 离线源码包 `vendor/gpu-burn.tar.gz` → 远端 nohup 后台压测(断开页面不影响,无需访问 GitHub)→ 实时遥测(温度/功耗/利用率)→ 跑完自动取回产物并生成报告(需平台后端 `pip install paramiko`)。
- **手动上传模式**:下载 `gpu_check.sh` 与 `gpu-burn.tar.gz` 两个文件放入服务器同一目录执行,跑完上传 `REPORT_*.txt / gpu_telemetry.csv / gpu_burn.log` 三件产物,平台解析生成报告(零额外依赖)。
- gpu-burn 源码已内置(`vendor/gpu-burn.tar.gz`):服务器**离线也能编译压测**,只有当源码包缺失时才回退 git 克隆。
- **自动报告生成**:与《GPU服务器压力测试报告》样例同款的 HTML / Markdown / PDF 报告——逐卡遥测与算力表、全卡温度/功耗/SM时钟 SVG 曲线(85℃ 告警线)、WARN/FAIL 自动甄别(AER 子串误报 / nouveau 噪声 / 热降频观察项)、结论与建议,一键导出。

### 5. 智能化诊断报告引擎
- **最佳并发推荐 (Sweet Spot 效益算法)**：
  $$\text{Score} = \frac{\text{RPS} \times \frac{\text{SuccessRate}}{100}}{\text{P90 Latency}^{0.65}}$$
  在吞吐提升与响应延时劣化之间自动计算出效能最高的黄金并发点。
- **压力拐点定位 (Bottleneck Detection)**：
  - 自动识别触发 **HTTP 429 (Too Many Requests)** 的并发边界。
  - 自动识别 P90 延迟突变恶化（+100% 以上）的性能拐点。
  - 给出针对生产网关限流、缓存与超时设置的落地建议。

---

## 📁 文件目录说明

```
大模型压力测试/
├── index.html           # 压测仪表盘主页面 (可视化面板、配置表单、实时指标与报告)
├── login.html           # 登录页面 (账号密码 + Cookie 会话)
├── style.css            # 暗黑科技感响应式视觉样式表
├── stress-engine.js     # 压测与探针核心引擎 (流式捕获、并发工作池、长文本生成)
├── analyzer.js          # 数据分析与诊断引擎 (Sweet Spot、压力拐点定位、Markdown 报告)
├── report-builder.js    # 自包含 HTML/PDF 报告生成器 (图表快照内嵌)
├── charts.js            # Chart.js 响应图表管理器 (双轴吞吐、延迟分布、状态码分布)
├── app.js               # 页面交互控制器、状态暂存与事件绑定
├── vendor/              # 本地化第三方库 (Chart.js / html2pdf, 离线可用)
├── server.py            # 后端: 静态托管 + CORS 代理 + 登录鉴权 + 账号管理 (纯标准库)
├── start.bat            # Windows 一键启动脚本
├── build_exe.py/.bat    # PyInstaller 打包为单文件 .exe
├── Dockerfile           # Linux 容器化部署
├── docker-compose.yml   # Compose 一键部署 (含账号数据持久化卷)
├── headless-bench.mjs   # 命令行无头压测驱动 (复用同一套引擎)
└── README.md            # 项目使用与技术说明文档
```

---

## 🚀 快速启动

### 方法一：双击打开（最简单）
双击目录下的 `index.html` 或 `start.bat` 即可直接在浏览器中打开。
> **提示**：主流大模型 API（如 OpenAI 官方、DeepSeek 官方、SiliconFlow 等）均默认允许跨域调用 (CORS `*`)，直接双击网页即可发起请求。

### 方法二：本地静态服务（推荐）
如果你调用的自定义私有网关或内网 vLLM 服务有本地浏览器的跨域限制，可以使用 Python 快速启动静态服务器：
```bash
python -m http.server 8080
```
然后在浏览器访问：`http://localhost:8080`

### 方法三：完整服务模式（含登录鉴权，Windows/Linux 通用）
```bash
python server.py
```
浏览器访问 `http://127.0.0.1:8765`，未登录会自动跳转登录页。**默认账号 `admin / admin123`，首次登录后请立即重置。**

#### 登录与账号管理
```bash
python server.py --add-user alice     # 添加账号 (同名执行即重置密码, 密码≥6位)
python server.py --list-users         # 查看账号列表
python server.py --del-user alice     # 删除账号
```
- 账号存放在 `users.json`（PBKDF2-HMAC-SHA256 单向哈希，不存明文）
- 会话保存在服务进程内存中，24 小时滑动过期；**服务重启后需重新登录**
- 环境变量：`BENCH_PORT`（端口，默认 8765）、`BENCH_DATA_DIR`（users.json 存放目录）

### 方法四：Docker 容器化部署（Linux）
```bash
# 方式 A: docker compose 一键起 (账号数据持久化在命名卷, 重建容器不丢)
docker compose up -d

# 方式 B: 手动构建运行
docker build -t llm-benchmark .
docker run -d --name llm-benchmark -p 8765:8765 -v llm-bench-data:/data llm-benchmark
```
访问 `http://<主机IP>:8765`，同样默认 `admin / admin123` 首启自动创建。

### 方法五：打包为 Windows 单文件 .exe
```bash
build_exe.bat          # 或: python build_exe.py (自动安装 PyInstaller)
```
产出 `dist/LLM-Benchmark-Server.exe`，**双击即启动完整服务**（静态前端 + 登录 + CORS 代理），目标机器无需安装 Python。`users.json` 生成在 exe 同目录，升级替换 exe 不丢账号。

---

## 📝 使用步骤

1. **输入配置**：
   - 输入 API Base URL（例如 `https://api.deepseek.com/v1` 或点击右上角「预设模版」快速填充）。
   - 输入你的 API Key（密钥仅保存在当前浏览器的本地 LocalStorage 中，绝对不会上传第三方）。
   - 输入模型标识（例如 `deepseek-chat` 或点击「拉取列表」从服务端同步）。
2. **连接验证**：
   - 点击「验证连接连通性 (Ping 1 次)」，确保网络与密钥无误。
3. **选择测试模式**：
   - **一键全方位评测**（推荐）：自动按顺序进行「输出极限探测」$\to$「64k-1M 上下文探测」$\to$「5, 10, 20, 50, 100 并发阶梯压测」，完成后生成全套分析报告。
   - **单独模块测试**：可独立运行「并发阶梯压测」、「长上下文极限」或「最大输出探测」。
4. **查看与导出分析结果**：
   - 顶部实时查看实际 RPM、TPM、最佳并发点、压力崩坏点。
   - 点击右上角「导出测试数据 (JSON)」保存完整数据包。
   - 点击「导出 HTML」生成**自包含单文件报告**（图表快照 base64 内嵌，可离线打开/直接归档/发同事）。
   - 点击「导出 PDF」一键生成 A4 版式 PDF 报告（含 KPI 卡、图表、阶梯表与诊断结论；由内置 html2pdf.js 本地渲染，中文无乱码）。
   - 点击「复制分析报告 (Markdown)」即可将格式化的专业评测报告直接粘贴到文档中。
5. **GPU 服务器压测**(压测方案第 5 个 Tab「GPU 压测」):
   - 自动模式:填 SSH 信息与压测时长 → 「启动 GPU 压测」→ 页面实时看遥测 → 完成后自动出报告。
   - 手动模式:下载 `gpu_check.sh` 上传服务器 `/tmp` 执行 `sudo ./gpu_check.sh 1800`,跑完把 `hwcheck_*/` 里的三件产物拖入页面上传解析。
   - 结果区一键「导出 HTML / 导出 MD / 导出 PDF / 预览完整报告」。
   - 说明:SSH 凭据仅存服务进程内存;会话/任务重启即失效;同时只允许一个 GPU 压测任务。

---

*安全保证：本系统为 100% 纯前端静态架构，所有请求均从本地浏览器直接发往目标大模型服务器，无任何中间服务器中转。*
