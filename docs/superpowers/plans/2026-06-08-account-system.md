# AI 图片生成器账号体系 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 AI 图片生成器增加邮箱账号、登录会话、积分余额、生成扣费和管理员按邮箱调分入口。

**Architecture:** 在现有 Node 静态服务和图片代理中增加一个轻量账号层，使用服务端 SQLite 文件作为账号和积分真相源。所有图片生成请求必须带有效会话，代理在调用上游前原子预扣积分，调用失败或无图片时自动退款，调用成功后保留扣费流水。

**Tech Stack:** Node.js 22、`node:sqlite`、`node:crypto`、HTTP-only Cookie、现有单文件前端、Docker 持久化 volume。

---

## 产品规则

- 用户用邮箱注册，MVP 只校验邮箱格式，不做邀请码、域名白名单、邮箱验证或手机号绑定。
- 注册成功后初始积分为 `100`。
- 每生成 1 张图扣 `20` 积分。
- GPT Image 的 `n` 大于 1 时按预计图片数扣费：`cost = 20 * n`。
- Nano Banana 当前按 1 张图扣费：`cost = 20`。
- 用户积分小于本次所需积分时，禁止发起生成请求，返回 `402`。
- 管理员需要一个后端 API，可以按邮箱增加、减少或设置某个账号积分。

## 推荐认证口径

“使用邮箱即可”建议解释为：账号身份只用邮箱，不引入手机号、OAuth、邀请码或实名限制。登录本身仍需要密码，否则任何人只要知道邮箱就能冒用账号。

MVP 采用邮箱 + 密码：

- 注册字段：`email`、`password`
- 登录字段：`email`、`password`
- 密码使用 `scrypt` 加盐哈希，不保存明文。
- 登录后写入 HTTP-only Cookie，前端不保存 token。

如果后续明确要“无密码邮箱验证码登录”，可以把登录模块替换为邮箱验证码或 magic link，但那需要接入邮件服务，复杂度更高。

## 数据模型

SQLite 文件路径：

```text
${AI_IMAGE_DATA_DIR || /app/data}/image-generator.sqlite
```

新增环境变量：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `AI_IMAGE_DATA_DIR` | Docker 为 `/app/data`，本地为项目 `data/` | SQLite 数据目录 |
| `AUTH_SESSION_SECRET` | 必填 | 会话签名密钥 |
| `ADMIN_CREDIT_TOKEN` | 必填后才启用管理员调分接口 | 管理员调分口令 |
| `AUTH_COOKIE_SECURE` | `false` | HTTPS 部署时设为 `true` |

表结构：

```sql
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  credits INTEGER NOT NULL DEFAULT 100,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS credit_ledger (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  delta INTEGER NOT NULL,
  balance_after INTEGER NOT NULL,
  reason TEXT NOT NULL,
  request_id TEXT,
  actor TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_credit_ledger_user_id ON credit_ledger(user_id);
```

## API 设计

### 用户认证

`POST /api/auth/register`

```json
{
  "email": "user@example.com",
  "password": "password123"
}
```

成功返回：

```json
{
  "user": {
    "email": "user@example.com",
    "credits": 100
  }
}
```

`POST /api/auth/login`

```json
{
  "email": "user@example.com",
  "password": "password123"
}
```

`POST /api/auth/logout`

```json
{
  "ok": true
}
```

`GET /api/auth/me`

```json
{
  "user": {
    "email": "user@example.com",
    "credits": 80
  }
}
```

未登录返回：

```json
{
  "user": null
}
```

### 图片生成扣费

所有已有图片接口保持路径不变：

- `POST /api/images/generations`
- `POST /api/images/edits`

新增要求：

- 未登录：返回 `401`
- 积分不足：返回 `402`
- 上游失败：退款并返回原有错误
- 上游成功但没有图片：退款并返回现有 `proxy.empty_image_response` 错误
- 上游成功并返回图片：扣费流水落账，不退款

积分不足响应：

```json
{
  "error": {
    "source": "proxy",
    "message": "积分不足，本次需要 20 积分，当前余额 0。",
    "required_credits": 20,
    "current_credits": 0
  },
  "request_id": "client_xxx"
}
```

### 管理员调分入口

`POST /api/admin/credits`

Headers:

```text
X-Admin-Token: ${ADMIN_CREDIT_TOKEN}
Content-Type: application/json
```

Body 支持两种模式，二选一：

```json
{
  "email": "user@example.com",
  "delta": 100,
  "reason": "manual top-up"
}
```

```json
{
  "email": "user@example.com",
  "set_to": 200,
  "reason": "reset balance"
}
```

返回：

```json
{
  "user": {
    "email": "user@example.com",
    "credits": 200
  }
}
```

命令行示例：

```bash
curl -X POST http://127.0.0.1:8787/api/admin/credits \
  -H "Content-Type: application/json" \
  -H "X-Admin-Token: $ADMIN_CREDIT_TOKEN" \
  -d '{"email":"user@example.com","delta":100,"reason":"manual top-up"}'
```

## 文件规划

- Create: `outputs/auth-store.mjs`
  - SQLite 初始化、用户创建、密码校验、会话创建/读取/删除、积分预扣/退款/调分。
- Create: `tests/auth-store.test.mjs`
  - 覆盖注册初始积分、重复邮箱、密码校验、积分预扣、积分不足、退款、管理员调分。
- Modify: `outputs/ai-image-proxy-server.mjs`
  - 增加认证路由、Cookie 解析、图片接口鉴权、扣费和退款。
- Modify: `outputs/ai-image-generator.html`
  - 增加登录/注册 UI、用户邮箱和积分展示、生成前余额校验、登出。
- Modify: `tests/frontend-markup.test.mjs`
  - 校验页面包含账号入口、积分展示和登录必需控件。
- Create: `tests/auth-proxy.test.mjs`
  - 使用临时 SQLite 和 fake upstream 测试端到端鉴权、扣费、退款、管理员调分。
- Modify: `Dockerfile`
  - 创建 `/app/data`，设置 `AI_IMAGE_DATA_DIR=/app/data`。
- Modify: `README.md`
  - 更新 Docker volume、账号变量、管理员调分命令。
- Modify: `.gitignore`
  - 增加 `data/`，避免本地 SQLite 文件入库。

## Task 1: Auth Store

**Files:**
- Create: `outputs/auth-store.mjs`
- Create: `tests/auth-store.test.mjs`
- Modify: `.gitignore`

- [ ] **Step 1: 写失败测试**

新增测试覆盖这些行为：

```js
test("creates a user with 100 credits", async () => {
  const store = createAuthStore({ dataDir, sessionSecret: "test-secret" });
  const user = store.registerUser({ email: "User@Example.com", password: "password123" });
  assert.equal(user.email, "user@example.com");
  assert.equal(user.credits, 100);
});

test("reserves and refunds generation credits atomically", async () => {
  const store = createAuthStore({ dataDir, sessionSecret: "test-secret" });
  const user = store.registerUser({ email: "a@example.com", password: "password123" });
  const charge = store.reserveCredits({ userId: user.id, cost: 20, requestId: "req-1" });
  assert.equal(charge.balanceAfter, 80);
  const refunded = store.refundCredits({ userId: user.id, amount: 20, requestId: "req-1" });
  assert.equal(refunded.credits, 100);
});
```

- [ ] **Step 2: 跑测试并确认失败**

```bash
node --test tests/auth-store.test.mjs
```

Expected: `createAuthStore` 尚未导出导致失败。

- [ ] **Step 3: 实现最小 Store**

实现要点：

- 使用 `DatabaseSync` 打开 SQLite。
- 启动时执行 schema migration。
- `normalizeEmail(email)` 统一 trim + lower case。
- `hashPassword(password)` 使用 `scryptSync`。
- `createSession(userId)` 生成随机 token，只保存 token hash。
- `reserveCredits()` 使用 transaction，`credits < cost` 时抛出 `INSUFFICIENT_CREDITS`。
- 每次积分变化写 `credit_ledger`。

- [ ] **Step 4: 验证测试通过**

```bash
node --test tests/auth-store.test.mjs
```

Expected: all pass。

- [ ] **Step 5: 提交**

```bash
git add .gitignore outputs/auth-store.mjs tests/auth-store.test.mjs
git commit -m "Add auth store and credit ledger"
```

## Task 2: Auth API And Cookies

**Files:**
- Modify: `outputs/ai-image-proxy-server.mjs`
- Create: `tests/auth-proxy.test.mjs`

- [ ] **Step 1: 写认证 API 失败测试**

测试需要启动代理，使用临时 `AI_IMAGE_DATA_DIR`，断言：

- `POST /api/auth/register` 返回用户和 `set-cookie`
- `GET /api/auth/me` 带 cookie 返回用户
- `POST /api/auth/logout` 后 `GET /api/auth/me` 返回 `user: null`

- [ ] **Step 2: 跑测试并确认失败**

```bash
node --test tests/auth-proxy.test.mjs
```

Expected: 路由未实现，返回 `404`。

- [ ] **Step 3: 实现认证路由**

在 `ai-image-proxy-server.mjs` 中增加：

- `parseCookies(req)`
- `setSessionCookie(res, token)`
- `clearSessionCookie(res)`
- `currentUserFromRequest(req)`
- `/api/auth/register`
- `/api/auth/login`
- `/api/auth/logout`
- `/api/auth/me`

Cookie 属性：

```text
HttpOnly; Path=/; SameSite=Lax; Max-Age=2592000
```

`AUTH_COOKIE_SECURE=true` 时追加 `Secure`。

- [ ] **Step 4: 验证测试通过**

```bash
node --test tests/auth-proxy.test.mjs tests/auth-store.test.mjs
```

- [ ] **Step 5: 提交**

```bash
git add outputs/ai-image-proxy-server.mjs tests/auth-proxy.test.mjs
git commit -m "Add email auth API"
```

## Task 3: Credit Gate For Image Requests

**Files:**
- Modify: `outputs/ai-image-proxy-server.mjs`
- Modify: `tests/auth-proxy.test.mjs`

- [ ] **Step 1: 写扣费失败测试**

新增端到端测试：

- 未登录调用 `/api/images/generations` 返回 `401`
- 登录后生成成功，积分从 `100` 变 `80`
- 设置 `n: 2` 时扣 `40`
- 积分不足返回 `402`，不调用 upstream
- upstream 返回 500 时退款
- Gemini 200 但无图时退款

- [ ] **Step 2: 跑测试并确认失败**

```bash
node --test tests/auth-proxy.test.mjs
```

Expected: 图片接口尚未鉴权和扣费。

- [ ] **Step 3: 实现扣费编排**

新增函数：

```js
function generationCost(provider, payload) {
  if (provider === "openai") return 20 * Math.max(1, Number(payload.n || 1));
  return 20;
}
```

调用顺序：

1. 解析当前用户。
2. 未登录返回 `401`。
3. 解析 payload 后计算成本。
4. 调用 `reserveCredits()` 原子预扣。
5. 调用上游。
6. 上游失败或无图片时 `refundCredits()`。
7. 成功响应时追加响应字段：

```json
{
  "billing": {
    "credits_charged": 20,
    "credits_remaining": 80
  }
}
```

- [ ] **Step 4: 验证测试通过**

```bash
node --test tests/auth-proxy.test.mjs tests/gemini-empty-response-proxy.test.mjs
```

- [ ] **Step 5: 提交**

```bash
git add outputs/ai-image-proxy-server.mjs tests/auth-proxy.test.mjs
git commit -m "Gate image generation by credits"
```

## Task 4: Admin Credit Adjustment API

**Files:**
- Modify: `outputs/ai-image-proxy-server.mjs`
- Modify: `tests/auth-proxy.test.mjs`

- [ ] **Step 1: 写管理员调分失败测试**

测试：

- 未带 `X-Admin-Token` 返回 `403`
- token 正确时 `delta: 100` 增加积分
- token 正确时 `set_to: 0` 设置积分
- 不存在邮箱返回 `404`

- [ ] **Step 2: 跑测试并确认失败**

```bash
node --test tests/auth-proxy.test.mjs
```

- [ ] **Step 3: 实现管理员接口**

新增 `POST /api/admin/credits`：

- 读取 `ADMIN_CREDIT_TOKEN`。
- 未配置时返回 `404` 或 `503`，避免误开放。
- token 不匹配返回 `403`。
- body 必须包含 `email` 和 `reason`。
- `delta` 与 `set_to` 二选一。
- 调用 store 写入 `credit_ledger`，`actor` 为 `admin`。

- [ ] **Step 4: 验证测试通过**

```bash
node --test tests/auth-proxy.test.mjs
```

- [ ] **Step 5: 提交**

```bash
git add outputs/ai-image-proxy-server.mjs tests/auth-proxy.test.mjs
git commit -m "Add admin credit adjustment API"
```

## Task 5: Frontend Account UI

**Files:**
- Modify: `outputs/ai-image-generator.html`
- Modify: `tests/frontend-markup.test.mjs`

- [ ] **Step 1: 写页面标记失败测试**

新增断言：

- 页面包含邮箱输入 `#authEmail`
- 页面包含密码输入 `#authPassword`
- 页面包含登录按钮 `#loginBtn`
- 页面包含注册按钮 `#registerBtn`
- 页面包含积分展示 `#creditsBadge`

- [ ] **Step 2: 跑测试并确认失败**

```bash
node --test tests/frontend-markup.test.mjs
```

- [ ] **Step 3: 实现账号 UI**

在顶部或服务商面板中增加紧凑账号区域：

- 未登录：邮箱、密码、注册、登录
- 已登录：邮箱、积分、退出
- 生成按钮状态：
  - 未登录：禁用，状态显示“请先登录”
  - 积分不足：禁用，状态显示“积分不足”
  - 可生成：保持现有逻辑

新增前端函数：

- `fetchMe()`
- `register()`
- `login()`
- `logout()`
- `refreshAccountState()`

图片生成成功后从响应 `billing.credits_remaining` 更新积分；如果响应里没有 billing，调用 `/api/auth/me` 刷新。

- [ ] **Step 4: 验证页面测试通过**

```bash
node --test tests/frontend-markup.test.mjs
```

- [ ] **Step 5: 提交**

```bash
git add outputs/ai-image-generator.html tests/frontend-markup.test.mjs
git commit -m "Add account controls to image generator"
```

## Task 6: Docker And Docs

**Files:**
- Modify: `Dockerfile`
- Modify: `README.md`

- [ ] **Step 1: 更新 Dockerfile**

增加：

```dockerfile
ENV AI_IMAGE_DATA_DIR=/app/data
RUN mkdir -p /app/logs /app/data && chown -R node:node /app/logs /app/data
```

- [ ] **Step 2: 更新 README 部署命令**

运行命令需增加：

```bash
mkdir -p /opt/image-generator/logs /opt/image-generator/data

docker run -d \
  --name image-generator \
  --restart unless-stopped \
  -p 8787:8787 \
  -v /opt/image-generator/logs:/app/logs \
  -v /opt/image-generator/data:/app/data \
  -e AUTH_SESSION_SECRET="换成一串至少32位随机字符串" \
  -e ADMIN_CREDIT_TOKEN="换成管理员调分口令" \
  image-generator:latest
```

生成随机密钥：

```bash
openssl rand -hex 32
```

- [ ] **Step 3: 验证镜像**

```bash
docker build -t image-generator:auth-test .
docker run --rm -p 8788:8787 \
  -e AUTH_SESSION_SECRET="test-session-secret-1234567890" \
  -e ADMIN_CREDIT_TOKEN="test-admin-token" \
  image-generator:auth-test
```

另一个终端：

```bash
curl http://127.0.0.1:8788/api/health
```

- [ ] **Step 4: 提交**

```bash
git add Dockerfile README.md
git commit -m "Document account deployment settings"
```

## 最终验收

运行：

```bash
node --test tests/provider-adapters.test.mjs tests/provider-config.test.mjs tests/request-logger.test.mjs tests/frontend-markup.test.mjs tests/gemini-empty-response-proxy.test.mjs tests/auth-store.test.mjs tests/auth-proxy.test.mjs
node --check outputs/ai-image-proxy-server.mjs
node --check outputs/provider-adapters.mjs
node --check outputs/provider-config.mjs
node --check outputs/request-logger.mjs
node --check outputs/auth-store.mjs
git diff --check
docker build -t image-generator:auth-test .
```

手工验收：

1. 新邮箱注册后页面显示 `100` 积分。
2. 生成 1 张图成功后页面显示 `80` 积分。
3. 管理员把该邮箱积分设置为 `0` 后，页面无法继续生成。
4. 管理员给该邮箱 `delta: 100` 后，页面可以继续生成。
5. 上游返回错误时积分不会减少。

## 风险和后续扩展

- `node:sqlite` 在 Node 22 中会提示 ExperimentalWarning，但可用；如果后续用户量变大，建议迁移到 Postgres。
- 当前仍保留页面输入 API Key 的机制；账号系统只控制谁能用、扣多少积分，不负责托管服务商 Key。
- 若要开放给不可信公众用户，下一阶段应加入验证码、邮箱验证、请求频率限制和后台管理页。
- 若担心服务重启导致预扣未退款，可以增加 `generation_charges` 表记录 pending 状态，并在启动时扫描超时 pending 记录自动退款。
