# AI 图片生成器

一个可部署的 AI 图片生成工具页，支持 `gpt-image-2` 文生图和图生图。

页面通过同源代理调用 OpenAI-compatible 图片接口，避免浏览器直连三方服务商时遇到 CORS 限制。`Base URL` 和 `API Key` 默认由页面输入，代理只负责转发。

## 本地运行

```bash
cd /path/to/image-generator
PORT=8787 node outputs/ai-image-proxy-server.mjs
```

打开：

```text
http://127.0.0.1:8787/
```

页面中填写：

- `Base URL`: `https://ai.nomorebug.xyz`
- `API Key`: 服务商提供的真实 `sk-...`
- `请求方式`: `后端代理`
- `代理路径`: `/api`
- `Model`: `gpt-image-2`

## Docker 构建

```bash
docker build -t image-generator:latest .
```

## Docker 运行

```bash
docker run -d \
  --name image-generator \
  --restart unless-stopped \
  -p 8787:8787 \
  image-generator:latest
```

如果希望设置默认服务商配置，也可以通过环境变量提供；页面输入值仍会优先使用：

```bash
docker run -d \
  --name image-generator \
  --restart unless-stopped \
  -p 8787:8787 \
  -e AI_IMAGE_BASE_URL="https://ai98pro.xyz/v1" \
  -e AI_IMAGE_API_KEY="sk-xxxx" \
  image-generator:latest
```

## 生产部署注意

- 建议部署在 HTTPS 后面，例如 Nginx、Caddy、Cloudflare Tunnel 或服务器网关。
- 不建议把这个页面开放给不受信任的用户，因为页面会把用户输入的 API Key 发给同源代理转发。
- 如果要多人使用，建议在代理层增加登录鉴权、访问限制和服务商域名白名单。

## 文件说明

- `outputs/ai-image-generator.html`: 前端工具页面。
- `outputs/ai-image-proxy-server.mjs`: 静态文件服务和图片接口代理。
- `Dockerfile`: 镜像构建文件。
- `.dockerignore`: Docker 构建忽略规则。
