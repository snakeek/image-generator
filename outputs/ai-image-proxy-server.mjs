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

const ROOT = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8787);
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
  if (!apiKey) return "Missing API key for selected provider. Set OPENAI_IMAGE_API_KEY or GEMINI_IMAGE_API_KEY on the proxy server.";
  if (/[^\x20-\x7e]/.test(apiKey)) {
    return "Backend API key contains non-ASCII characters. Check the selected provider environment variable.";
  }
  if (apiKey.includes("<") || apiKey.includes(">") || /your|placeholder|key/i.test(apiKey)) {
    return "Backend API key looks like a placeholder. Replace the selected provider environment variable with the real key.";
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
  const provider = requestProvider(req);
  const config = resolveProviderConfig(provider);
  const issue = providerIssue(config?.provider || provider)
    || (!config ? `Unsupported provider: ${provider}. Use openai or gemini.` : "")
    || baseUrlIssue(config.baseUrl)
    || apiKeyIssue(config.apiKey);
  if (issue) {
    sendJson(res, 500, { error: { source: "proxy", message: issue } });
    return;
  }

  const body = await readBody(req);

  if (config.provider === "gemini") {
    await proxyGeminiImages(res, { config, pathname, body });
    return;
  }

  await proxyOpenAICompatibleImages(req, res, { config, pathname, body });
}

async function proxyOpenAICompatibleImages(req, res, { config, pathname, body }) {
  const contentType = req.headers["content-type"] || "";
  const headers = {
    authorization: `Bearer ${config.apiKey}`,
    "x-client-request-id": randomUUID()
  };

  let requestBody = body;
  let upstreamPath = pathname.replace(/^\/api/, "");

  if (contentType.includes("application/json")) {
    const payload = JSON.parse(body.toString("utf8"));
    payload.model = config.model;

    if (upstreamPath.endsWith("/edits") && Array.isArray(payload.input_images)) {
      const form = new FormData();
      const imageFieldName = payload.image_field_name || "image[]";
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

  const upstream = await fetch(`${config.baseUrl}${upstreamPath}`, {
    method: "POST",
    headers,
    body: requestBody
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

async function proxyGeminiImages(res, { config, pathname, body }) {
  let payload;
  try {
    payload = JSON.parse(body.toString("utf8"));
  } catch {
    sendJson(res, 400, { error: { source: "proxy", message: "Gemini provider expects a JSON request body." } });
    return;
  }
  payload.model = config.model;

  const geminiRequest = buildGeminiRequest({ baseUrl: config.baseUrl, apiKey: config.apiKey, pathname, body: payload });
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
        defaultProvider: DEFAULT_PROVIDER,
        providers: ["openai", "gemini"],
        providerConfigs: publicProviderSummary(),
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
  console.log(`Default provider: ${DEFAULT_PROVIDER}`);
  console.log("Provider Base URL, API Key and Model are loaded from backend grouped configuration.");
});
