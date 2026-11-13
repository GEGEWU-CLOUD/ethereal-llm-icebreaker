# LLM API 压力测试系统 - 容器化部署
# 构建:   docker build -t llm-benchmark .
# 运行:   docker run -d -p 8765:8765 -v llm-bench-data:/data --name llm-benchmark llm-benchmark
# 访问:   http://<主机IP>:8765  (默认账号 admin / admin123)
FROM python:3.12-slim

LABEL org.opencontainers.image.title="LLM API Stress Benchmark"
LABEL org.opencontainers.image.description="LLM API 全方位性能压力与极限基准评测系统 (纯 Python 标准库后端)"

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    BENCH_PORT=8765 \
    BENCH_DATA_DIR=/data

WORKDIR /app

# GPU 压测 SSH 编排依赖 (缺失时 GPU 自动模式优雅降级为手动上传模式)
RUN pip install --no-cache-dir paramiko

# 静态前端 + 后端
COPY server.py \
     gpu_agent.py \
     npu_agent.py \
     gpu_check.sh \
     npu_check.sh \
     torch_wrapper.sh \
     index.html \
     login.html \
     style.css \
     favicon.svg \
     app.js \
     analyzer.js \
     charts.js \
     stress-engine.js \
     report-builder.js \
     gpu-report-builder.js \
     npu-report-builder.js \
     ./
COPY vendor/ ./vendor/

# 数据目录 (users.json 持久化挂载点)
RUN mkdir -p /data
VOLUME /data

EXPOSE 8765

CMD ["python", "server.py"]
