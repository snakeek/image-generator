import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import {
  buildGeminiRequest,
  normalizeGeminiResponse
} from "./provider-adapters.mjs";

const ROOT = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8787);
const DEFAULT_BASE_URL = (process.env.AI_IMAGE_BASE_URL || "https://ai98pro.xyz/v1").replace(/\/+$/, "");
const DEFAULT_API_KEY = (process.env.AI_IMAGE_API_KEY || "").trim();
const DEFAULT_PROVIDER = (process.env.AI_IMAGE_PROVIDER || "openai").trim().toLowerCase();
const MAX_BODY_BYTES = Number(process.env.MAX_BODY_MB || 80) * 1024 * 1024;

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

function sendJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function apiKeyIssue(apiKey) {
  if (!apiKey) return "Missing API key. Fill API Key on the page or set AI_IMAGE_API_KEY on the proxy server.";
  if (/[^\x20-\x7e]/.test(apiKey)) {
    return "API key contains non-ASCII characters. It may still be the placeholder text; use the real sk-... key.";
  }
  if (apiKey.includes("<") || apiKey.includes(">") || /your|placeholder|key/i.test(apiKey)) {
    return "API key looks like a placeholder. Replace it with the real sk-... key.";
  }
  return "";
}

function baseUrlIssue(baseUrl) {
  if (!baseUrl) return "Missing Base URL. Fill Base URL on the page or set AI_IMAGE_BASE_URL on the proxy server.";
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

function requestConfig(req) {
  const baseUrlHeader = req.headers["x-ai-image-base-url"];
  const apiKeyHeader = req.headers["x-ai-image-api-key"];
  const providerHeader = req.headers["x-ai-image-provider"];
  const baseUrl = String(Array.isArray(baseUrlHeader) ? baseUrlHeader[0] : baseUrlHeader || DEFAULT_BASE_URL)
    .trim()
    .replace(/\/+$/, "");
  const apiKey = String(Array.isArray(apiKeyHeader) ? apiKeyHeader[0] : apiKeyHeader || DEFAULT_API_KEY).trim();
  const provider = String(Array.isArray(providerHeader) ? providerHeader[0] : providerHeader || DEFAULT_PROVIDER)
    .trim()
    .toLowerCase();
  return { baseUrl, apiKey, provider };
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

async function proxyImages(req, res, pathname) {
  const { baseUrl, apiKey, provider } = requestConfig(req);
  const issue = providerIssue(provider) || baseUrlIssue(baseUrl) || apiKeyIssue(apiKey);
  if (issue) {
    sendJson(res, 500, { error: { source: "proxy", message: issue } });
    return;
  }

  const body = await readBody(req);

  if (provider === "gemini") {
    await proxyGeminiImages(res, { baseUrl, apiKey, pathname, body });
    return;
  }

  await proxyOpenAICompatibleImages(req, res, { baseUrl, apiKey, pathname, body });
}

async function proxyOpenAICompatibleImages(req, res, { baseUrl, apiKey, pathname, body }) {
  const headers = {
    authorization: `Bearer ${apiKey}`,
    "content-length": String(body.length),
    "x-client-request-id": randomUUID()
  };

  if (req.headers["content-type"]) {
    headers["content-type"] = req.headers["content-type"];
  }

  const upstream = await fetch(`${baseUrl}${pathname.replace(/^\/api/, "")}`, {
    method: "POST",
    headers,
    body
  });

  const responseBody = Buffer.from(await upstream.arrayBuffer());
  const responseHeaders = {
    "content-type": upstream.headers.get("content-type") || "application/octet-stream",
    "cache-control": "no-store"
  };
  const requestId = upstream.headers.get("x-request-id");
  if (requestId) responseHeaders["x-upstream-request-id"] = requestId;

  res.writeHead(upstream.status, responseHeaders);
  res.end(responseBody);
}

async function proxyGeminiImages(res, { baseUrl, apiKey, pathname, body }) {
  let payload;
  try {
    payload = JSON.parse(body.toString("utf8"));
  } catch {
    sendJson(res, 400, { error: { source: "proxy", message: "Gemini provider expects a JSON request body." } });
    return;
  }

  const geminiRequest = buildGeminiRequest({ baseUrl, apiKey, pathname, body: payload });
  const requestBody = JSON.stringify(geminiRequest.body);
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
    "cache-control": "no-store"
  };

  if (!upstream.ok) {
    res.writeHead(upstream.status, responseHeaders);
    res.end(JSON.stringify(json));
    return;
  }

  const normalized = normalizeGeminiResponse(json);
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

  try {
    if (req.method === "GET" && url.pathname === "/api/health") {
      sendJson(res, 200, {
        ok: true,
        defaultBaseUrl: DEFAULT_BASE_URL,
        hasDefaultApiKey: Boolean(DEFAULT_API_KEY),
        defaultApiKeyValid: DEFAULT_API_KEY ? !apiKeyIssue(DEFAULT_API_KEY) : null,
        defaultApiKeyIssue: DEFAULT_API_KEY ? apiKeyIssue(DEFAULT_API_KEY) || null : null,
        defaultProvider: DEFAULT_PROVIDER,
        providers: ["openai", "gemini"],
        pageHeadersSupported: true
      });
      return;
    }

    if (
      req.method === "POST"
      && ["/api/images/generations", "/api/images/edits"].includes(url.pathname)
    ) {
      await proxyImages(req, res, url.pathname);
      return;
    }

    if (req.method === "GET") {
      await serveStatic(res, url.pathname);
      return;
    }

    sendJson(res, 405, { error: { message: "Method not allowed" } });
  } catch (error) {
    sendJson(res, 500, { error: { source: "proxy", message: error.message || "Proxy error" } });
  }
});

server.listen(PORT, () => {
  console.log(`AI image tool: http://127.0.0.1:${PORT}/`);
  console.log(`Default proxy upstream: ${DEFAULT_BASE_URL}`);
  console.log(`Default API key loaded: ${DEFAULT_API_KEY ? "yes" : "no"}`);
  console.log(`Default provider: ${DEFAULT_PROVIDER}`);
  console.log("Page-supplied Base URL and API Key are supported.");
  if (DEFAULT_API_KEY && apiKeyIssue(DEFAULT_API_KEY)) console.log(`Default API key issue: ${apiKeyIssue(DEFAULT_API_KEY)}`);
});
