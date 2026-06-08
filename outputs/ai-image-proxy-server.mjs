import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import {
  buildGeminiRequest,
  normalizeGeminiResponse
} from "./provider-adapters.mjs";
import {
  publicProviderSummary,
  resolveProviderConfig
} from "./provider-config.mjs";
import {
  createDailyLogger,
  summarizePayload
} from "./request-logger.mjs";

const ROOT = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8787);
const DEFAULT_PROVIDER = (process.env.AI_IMAGE_PROVIDER || "openai").trim().toLowerCase();
const MAX_BODY_BYTES = Number(process.env.MAX_BODY_MB || 80) * 1024 * 1024;
const LOG_DIR = process.env.AI_IMAGE_LOG_DIR || join(dirname(ROOT), "logs");
const logger = createDailyLogger({ logDir: LOG_DIR });

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp"
};

function writeLog(level, event, fields = {}) {
  logger[level](event, fields).catch(error => {
    console.error(JSON.stringify({
      level: "error",
      event: "logger.write_failed",
      message: error.message
    }));
  });
}

function sendJson(res, status, body, headers = {}) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(Buffer.byteLength(text)),
    "connection": "close",
    ...headers
  });
  res.end(text);
}

function apiKeyIssue(apiKey) {
  if (!apiKey) return "Missing API key for selected provider. Fill API Key on the page or set OPENAI_IMAGE_API_KEY/GEMINI_IMAGE_API_KEY on the proxy server.";
  if (/[^\x20-\x7e]/.test(apiKey)) {
    return "API key contains non-ASCII characters. Check the page API Key input or selected provider environment variable.";
  }
  if (apiKey.includes("<") || apiKey.includes(">") || /your|placeholder|key/i.test(apiKey)) {
    return "API key looks like a placeholder. Replace it with the real key.";
  }
  return "";
}

function baseUrlIssue(baseUrl) {
  if (!baseUrl) return "Missing Base URL for selected provider. Set OPENAI_IMAGE_BASE_URL or GEMINI_IMAGE_BASE_URL on the proxy server.";
  try {
    const url = new URL(baseUrl);
    if (!["http:", "https:"].includes(url.protocol)) {
      return "Base URL must start with http:// or https://.";
    }
    return "";
  } catch {
    return "Base URL is not a valid URL.";
  }
}

function requestProvider(req) {
  const providerHeader = req.headers["x-ai-image-provider"];
  return String(Array.isArray(providerHeader) ? providerHeader[0] : providerHeader || DEFAULT_PROVIDER)
    .trim()
    .toLowerCase();
}

function requestApiKey(req) {
  const apiKeyHeader = req.headers["x-ai-image-api-key"];
  return String(Array.isArray(apiKeyHeader) ? apiKeyHeader[0] : apiKeyHeader || "").trim();
}

function providerIssue(provider) {
  if (["openai", "gemini"].includes(provider)) return "";
  return `Unsupported provider: ${provider}. Use openai or gemini.`;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", chunk => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error(`Request body exceeds ${MAX_BODY_BYTES} bytes`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function requestIdFrom(req) {
  const clientRequestId = req.headers["x-client-request-id"];
  return String(Array.isArray(clientRequestId) ? clientRequestId[0] : clientRequestId || randomUUID()).trim();
}

function responsePreview(buffer) {
  if (!buffer?.length) return "";
  return buffer.toString("utf8", 0, Math.min(buffer.length, 1200));
}

function previewJson(value) {
  try {
    return JSON.stringify(value).slice(0, 1200);
  } catch {
    return "";
  }
}

function geminiEmptyImageError(normalized, json) {
  const details = {
    ...(normalized.text ? { text: normalized.text } : {}),
    ...(normalized.finishReasons?.length ? { finishReasons: normalized.finishReasons } : {}),
    ...(normalized.promptFeedback ? { promptFeedback: normalized.promptFeedback } : {}),
    responsePreview: typeof json.raw === "string" ? json.raw.slice(0, 1200) : previewJson(json)
  };
  const messageParts = [
    "服务商返回成功，但没有返回图片。可能是提示词被安全策略拦截、模型只返回了文本，或服务商未按 Gemini 图片格式返回。"
  ];

  if (details.text) {
    messageParts.push(`服务商说明：${details.text}`);
  }

  if (details.finishReasons?.length) {
    messageParts.push(`finishReason：${details.finishReasons.join(", ")}`);
  }

  const blockReason = details.promptFeedback?.blockReason || details.promptFeedback?.block_reason;
  if (blockReason) {
    messageParts.push(`promptFeedback.blockReason：${blockReason}`);
  }

  return {
    message: messageParts.join("\n"),
    details
  };
}

async function proxyImages(req, res, pathname, requestId) {
  const startedAt = Date.now();
  const provider = requestProvider(req);
  const pageApiKey = requestApiKey(req);
  const config = resolveProviderConfig(provider, process.env, { apiKey: pageApiKey });
  writeLog("info", "proxy.request", {
    requestId,
    method: req.method,
    pathname,
    provider,
    resolvedProvider: config?.provider,
    apiKeySource: pageApiKey ? "page" : "env",
    config: config ? {
      baseUrl: config.baseUrl,
      model: config.model,
      hasApiKey: Boolean(config.apiKey)
    } : null
  });

  const body = await readBody(req);
  const issue = providerIssue(config?.provider || provider)
    || (!config ? `Unsupported provider: ${provider}. Use openai or gemini.` : "")
    || baseUrlIssue(config.baseUrl)
    || apiKeyIssue(config.apiKey);
  if (issue) {
    writeLog("error", "proxy.config_error", {
      requestId,
      provider,
      message: issue,
      durationMs: Date.now() - startedAt
    });
    sendJson(res, 500, { error: { source: "proxy", message: issue }, request_id: requestId }, { "x-request-id": requestId });
    return;
  }

  if (config.provider === "gemini") {
    await proxyGeminiImages(res, { config, pathname, body, requestId, startedAt });
    return;
  }

  await proxyOpenAICompatibleImages(req, res, { config, pathname, body, requestId, startedAt });
}

async function proxyOpenAICompatibleImages(req, res, { config, pathname, body, requestId, startedAt }) {
  const contentType = req.headers["content-type"] || "";
  const headers = {
    authorization: `Bearer ${config.apiKey}`,
    "x-client-request-id": requestId
  };

  let requestBody = body;
  let upstreamPath = pathname.replace(/^\/api/, "");
  let payloadSummary = {};
  let editMultipart = false;

  if (contentType.includes("application/json")) {
    const payload = JSON.parse(body.toString("utf8"));
    payload.model = config.model;
    payloadSummary = summarizePayload(payload);

    if (upstreamPath.endsWith("/edits") && Array.isArray(payload.input_images)) {
      const form = new FormData();
      const imageFieldName = payload.image_field_name || "image[]";
      editMultipart = true;
      for (const [key, value] of Object.entries(payload)) {
        if (key === "input_images" || key === "image_field_name") continue;
        if (value === undefined || value === null || value === "") continue;
        form.append(key, String(value));
      }
      payload.input_images.forEach((image, index) => {
        const bytes = Buffer.from(image.data, "base64");
        const blob = new Blob([bytes], { type: image.mime_type || "image/png" });
        form.append(imageFieldName, blob, image.name || `image-${index + 1}.png`);
      });
      requestBody = form;
    } else {
      requestBody = JSON.stringify(payload);
      headers["content-type"] = "application/json";
      headers["content-length"] = String(Buffer.byteLength(requestBody));
    }
  } else {
    requestBody = body;
    headers["content-type"] = contentType;
    headers["content-length"] = String(body.length);
  }

  writeLog("info", "proxy.upstream_request", {
    requestId,
    provider: config.provider,
    upstreamPath,
    upstreamBaseUrl: config.baseUrl,
    contentType: contentType || "application/octet-stream",
    payload: payloadSummary,
    editMultipart
  });

  const upstream = await fetch(`${config.baseUrl}${upstreamPath}`, {
    method: "POST",
    headers,
    body: requestBody
  });

  const responseBody = Buffer.from(await upstream.arrayBuffer());
  const responseHeaders = {
    "content-type": upstream.headers.get("content-type") || "application/octet-stream",
    "cache-control": "no-store",
    "x-request-id": requestId
  };
  const upstreamRequestId = upstream.headers.get("x-request-id");
  if (upstreamRequestId) responseHeaders["x-upstream-request-id"] = upstreamRequestId;

  writeLog(upstream.ok ? "info" : "warn", "proxy.upstream_response", {
    requestId,
    provider: config.provider,
    upstreamPath,
    upstreamStatus: upstream.status,
    upstreamRequestId,
    responseContentType: responseHeaders["content-type"],
    responseBytes: responseBody.length,
    durationMs: Date.now() - startedAt,
    ...(upstream.ok ? {} : { responsePreview: responsePreview(responseBody) })
  });

  res.writeHead(upstream.status, responseHeaders);
  res.end(responseBody);
}

async function proxyGeminiImages(res, { config, pathname, body, requestId, startedAt }) {
  let payload;
  try {
    payload = JSON.parse(body.toString("utf8"));
  } catch {
    const message = "Gemini provider expects a JSON request body.";
    writeLog("error", "proxy.invalid_json", { requestId, provider: config.provider, pathname, message });
    sendJson(res, 400, { error: { source: "proxy", message }, request_id: requestId }, { "x-request-id": requestId });
    return;
  }
  payload.model = config.model;

  const geminiRequest = buildGeminiRequest({ baseUrl: config.baseUrl, apiKey: config.apiKey, pathname, body: payload });
  const requestBody = JSON.stringify(geminiRequest.body);
  writeLog("info", "proxy.upstream_request", {
    requestId,
    provider: config.provider,
    upstreamUrl: geminiRequest.url,
    payload: summarizePayload(payload)
  });

  const upstream = await fetch(geminiRequest.url, {
    method: "POST",
    headers: {
      ...geminiRequest.headers,
      "content-length": String(Buffer.byteLength(requestBody))
    },
    body: requestBody
  });

  const contentType = upstream.headers.get("content-type") || "";
  const raw = await upstream.text();
  let json;
  try {
    json = JSON.parse(raw);
  } catch {
    json = { raw };
  }

  const responseHeaders = {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-request-id": requestId
  };

  if (!upstream.ok) {
    writeLog("warn", "proxy.upstream_response", {
      requestId,
      provider: config.provider,
      upstreamStatus: upstream.status,
      responseContentType: contentType || "unknown",
      durationMs: Date.now() - startedAt,
      responsePreview: typeof json.raw === "string" ? json.raw : JSON.stringify(json).slice(0, 1200)
    });
    res.writeHead(upstream.status, responseHeaders);
    res.end(JSON.stringify(json));
    return;
  }

  const normalized = normalizeGeminiResponse(json);
  if (normalized.data.length === 0) {
    const emptyImageError = geminiEmptyImageError(normalized, json);
    writeLog("warn", "proxy.empty_image_response", {
      requestId,
      provider: config.provider,
      upstreamStatus: upstream.status,
      responseContentType: contentType || "unknown",
      imageCount: 0,
      durationMs: Date.now() - startedAt,
      ...emptyImageError.details
    });
    sendJson(res, 502, {
      error: {
        source: "proxy",
        message: emptyImageError.message,
        upstream_status: upstream.status,
        details: emptyImageError.details
      },
      request_id: requestId
    }, responseHeaders);
    return;
  }

  writeLog("info", "proxy.upstream_response", {
    requestId,
    provider: config.provider,
    upstreamStatus: upstream.status,
    responseContentType: contentType || "unknown",
    imageCount: normalized.data.length,
    durationMs: Date.now() - startedAt
  });
  res.writeHead(200, responseHeaders);
  res.end(JSON.stringify(normalized));
}

async function serveStatic(res, pathname) {
  const safePath = pathname === "/" ? "/ai-image-generator.html" : pathname;
  const normalized = normalize(safePath).replace(/^(\.\.[/\\])+/, "");
  const filePath = join(ROOT, normalized);

  if (!filePath.startsWith(ROOT)) {
    sendJson(res, 403, { error: { message: "Forbidden" } });
    return;
  }

  try {
    const data = await readFile(filePath);
    res.writeHead(200, {
      "content-type": MIME[extname(filePath)] || "application/octet-stream",
      "cache-control": "no-store"
    });
    res.end(data);
  } catch {
    sendJson(res, 404, { error: { message: "Not found" } });
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const requestId = requestIdFrom(req);

  try {
    if (req.method === "GET" && url.pathname === "/api/health") {
      sendJson(res, 200, {
        ok: true,
        defaultProvider: DEFAULT_PROVIDER,
        providers: ["openai", "gemini"],
        providerConfigs: publicProviderSummary(),
        logDir: LOG_DIR,
        pageApiKeySupported: true,
        pageHeadersSupported: true
      });
      return;
    }

    if (
      req.method === "POST"
      && ["/api/images/generations", "/api/images/edits"].includes(url.pathname)
    ) {
      await proxyImages(req, res, url.pathname, requestId);
      return;
    }

    if (req.method === "GET") {
      await serveStatic(res, url.pathname);
      return;
    }

    sendJson(res, 405, { error: { message: "Method not allowed" } }, { "x-request-id": requestId });
  } catch (error) {
    writeLog("error", "proxy.error", {
      requestId,
      method: req.method,
      pathname: url.pathname,
      error
    });
    sendJson(res, 500, { error: { source: "proxy", message: error.message || "Proxy error" }, request_id: requestId }, { "x-request-id": requestId });
  }
});

server.listen(PORT, () => {
  console.log(`AI image tool: http://127.0.0.1:${PORT}/`);
  console.log(`Default provider: ${DEFAULT_PROVIDER}`);
  console.log(`Daily log dir: ${LOG_DIR}`);
  console.log("Provider Base URL and Model are loaded from backend grouped configuration. API Key can be supplied by the page.");
});
