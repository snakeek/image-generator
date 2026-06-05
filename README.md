# AI 图片生成器

一个可部署的 AI 图片生成工具页，支持 `gpt-image-2`、Gemini / Nano Banana 文生图和图生图。

页面通过同源代理调用图片接口，避免浏览器直连三方服务商时遇到 CORS 限制。页面只选择服务商类型和创作参数，`Base URL`、`API Key`、`Model` 都由后端按服务商分组配置。

## 本地运行

```bash
cd /path/to/image-generator
OPENAI_IMAGE_BASE_URL="https://ai98pro.xyz/v1" \
OPENAI_IMAGE_API_KEY="your-openai-compatible-key" \
OPENAI_IMAGE_MODEL="gpt-image-2" \
GEMINI_IMAGE_BASE_URL="https://generativelanguage.googleapis.com/v1" \
GEMINI_IMAGE_API_KEY="your-google-api-key" \
GEMINI_IMAGE_MODEL="gemini-3.1-flash-image" \
PORT=8787 \
node outputs/ai-image-proxy-server.mjs
```

打开：

```text
http://127.0.0.1:8787/
```

页面上只需要选择：

- `GPT Image`: 使用后端 `OPENAI_IMAGE_*` 配置组。
- `Gemini / Nano Banana`: 使用后端 `GEMINI_IMAGE_*` 配置组。

后端配置变量：

| 变量 | 说明 |
| --- | --- |
| `OPENAI_IMAGE_BASE_URL` | OpenAI-compatible 服务商地址，例如 `https://ai98pro.xyz/v1` |
| `OPENAI_IMAGE_API_KEY` | OpenAI-compatible 服务商密钥 |
| `OPENAI_IMAGE_MODEL` | OpenAI-compatible 图片模型，默认 `gpt-image-2` |
| `GEMINI_IMAGE_BASE_URL` | Gemini 服务地址，例如 `https://generativelanguage.googleapis.com/v1` |
| `GEMINI_IMAGE_API_KEY` | Gemini / Google AI Studio 密钥 |
| `GEMINI_IMAGE_MODEL` | Gemini 图片模型，默认 `gemini-3.1-flash-image` |
| `AI_IMAGE_PROVIDER` | 可选，默认服务商，支持 `openai` 或 `gemini` |

可选模型：

- `gemini-2.5-flash-image`: Nano Banana
- `gemini-3.1-flash-image`: Nano Banana 2
- `gemini-3-pro-image`: Nano Banana Pro

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

OpenAI-compatible 配置示例：

```bash
docker run -d \
  --name image-generator \
  --restart unless-stopped \
  -p 8787:8787 \
  -e OPENAI_IMAGE_BASE_URL="https://ai98pro.xyz/v1" \
  -e OPENAI_IMAGE_API_KEY="your-openai-compatible-key" \
  -e OPENAI_IMAGE_MODEL="gpt-image-2" \
  -e AI_IMAGE_PROVIDER="openai" \
  image-generator:latest
```

Gemini / Nano Banana 配置示例：

```bash
docker run -d \
  --name image-generator \
  --restart unless-stopped \
  -p 8787:8787 \
  -e GEMINI_IMAGE_BASE_URL="https://generativelanguage.googleapis.com/v1" \
  -e GEMINI_IMAGE_API_KEY="your-google-api-key" \
  -e GEMINI_IMAGE_MODEL="gemini-3.1-flash-image" \
  -e AI_IMAGE_PROVIDER="gemini" \
  image-generator:latest
```

如果同一个部署同时支持 GPT Image 和 Nano Banana，可以同时传入两组环境变量，页面下拉框会决定本次请求使用哪一组。

## 生产部署注意

- 建议部署在 HTTPS 后面，例如 Nginx、Caddy、Cloudflare Tunnel 或服务器网关。
- 不建议把这个页面开放给不受信任的用户，因为后端代理会持有真实服务商密钥。
- 如果要多人使用，建议在代理层增加登录鉴权、访问限制、请求额度控制和服务商域名白名单。

## 文件说明

- `outputs/ai-image-generator.html`: 前端工具页面。
- `outputs/ai-image-proxy-server.mjs`: 静态文件服务和图片接口代理。
- `outputs/provider-adapters.mjs`: OpenAI-compatible 与 Gemini / Nano Banana 协议适配。
- `Dockerfile`: 镜像构建文件。
- `.dockerignore`: Docker 构建忽略规则。
