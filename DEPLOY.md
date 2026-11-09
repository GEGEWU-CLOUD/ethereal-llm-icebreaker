# IceBreaker 部署指南

## 方式一 · 拉取已有镜像部署(推荐, 最快)

镜像仓库:`registry.cn-hangzhou.aliyuncs.com/zznn/llm-icebreaker:v2`

### 1. 拉取镜像

```bash
docker pull registry.cn-hangzhou.aliyuncs.com/zznn/llm-icebreaker:v2
```

### 2. 启动(二选一)

**A. docker run 一条命令:**

```bash
docker run -d --name icebreaker \
  -p 8765:8765 \
  -v icebreaker-data:/data \
  --restart unless-stopped \
  registry.cn-hangzhou.aliyuncs.com/zznn/llm-icebreaker:v2
```

> 自定义端口:把 `-p 8765:8765` 改成 `-p 9000:8765` 即可。

**B. docker compose(项目根目录已提供 `docker-compose.image.yml`):**

```bash
docker compose -f docker-compose.image.yml up -d
# 自定义端口:
ICE_PORT=9000 docker compose -f docker-compose.image.yml up -d
```

### 3. 访问

- 地址:`http://<服务器IP>:8765`
- 初始账号:`admin / admin123`(**登录后立即在右上角「改密」修改**)
- 账号数据持久化在 `icebreaker-data` 卷,重建/升级容器不丢失

---

## 方式二 · 从源码构建部署

```bash
git clone <仓库地址> icebreaker && cd icebreaker && ./run.sh
```

`run.sh` 自动完成:构建镜像 → 启动容器 → 健康检查 → 打印访问信息。
升级同样一条:`git pull && ./run.sh`。

---

## 镜像发布(维护者)

```bash
# 在项目目录构建并打 tag
docker compose build
docker tag llm-benchmark:latest registry.cn-hangzhou.aliyuncs.com/zznn/llm-icebreaker:v2

# 登录阿里云镜像仓库后推送
docker login registry.cn-hangzhou.aliyuncs.com
docker push registry.cn-hangzhou.aliyuncs.com/zznn/llm-icebreaker:v2
```

## 常用运维

```bash
docker compose -f docker-compose.image.yml logs -f      # 看日志
docker compose -f docker-compose.image.yml down          # 停止
docker compose -f docker-compose.image.yml pull && \
docker compose -f docker-compose.image.yml up -d         # 升级到最新镜像
```
