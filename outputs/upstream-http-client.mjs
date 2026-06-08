import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

export class UpstreamRequestError extends Error {
  constructor(message, { code = "UPSTREAM_REQUEST_FAILED", statusCode = 502, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "UpstreamRequestError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

function responseHeadersFrom(rawHeaders = {}) {
  const headers = new Headers();
  for (const [key, value] of Object.entries(rawHeaders)) {
    if (Array.isArray(value)) {
      value.forEach(item => headers.append(key, item));
    } else if (value !== undefined) {
      headers.set(key, String(value));
    }
  }
  return headers;
}

function responseFrom(status, rawHeaders, buffer) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: responseHeadersFrom(rawHeaders),
    arrayBuffer: async () => buffer.buffer.slice(
      buffer.byteOffset,
      buffer.byteOffset + buffer.byteLength
    ),
    text: async () => buffer.toString("utf8")
  };
}

export function postBuffered(url, { headers = {}, body = "", timeoutMs = 600000 } = {}) {
  const target = new URL(url);
  const request = target.protocol === "http:" ? httpRequest : httpsRequest;

  return new Promise((resolve, reject) => {
    let settled = false;
    const req = request(target, {
      method: "POST",
      headers
    }, res => {
      const chunks = [];
      res.on("data", chunk => chunks.push(chunk));
      res.on("end", () => {
        settled = true;
        resolve(responseFrom(res.statusCode || 0, res.headers, Buffer.concat(chunks)));
      });
    });

    req.setTimeout(timeoutMs, () => {
      req.destroy(new UpstreamRequestError(`Upstream request timed out after ${timeoutMs}ms.`, {
        code: "UPSTREAM_TIMEOUT",
        statusCode: 504
      }));
    });

    req.on("error", error => {
      if (settled) return;
      if (error instanceof UpstreamRequestError) {
        reject(error);
        return;
      }
      reject(new UpstreamRequestError(error.message || "Upstream request failed.", {
        code: error.code || "UPSTREAM_REQUEST_FAILED",
        statusCode: 502,
        cause: error
      }));
    });

    if (body) req.write(body);
    req.end();
  });
}
