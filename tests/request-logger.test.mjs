import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  createDailyLogger,
  redactLogValue,
  sanitizeLogFields,
  summarizePayload
} from "../outputs/request-logger.mjs";

test("daily logger writes JSON lines and removes older log files", async () => {
  const logDir = await mkdtemp(join(tmpdir(), "image-generator-logs-"));
  await writeFile(join(logDir, "2026-06-04.log"), "old\n");

  const consoleLines = [];
  const logger = createDailyLogger({
    logDir,
    now: () => new Date("2026-06-05T08:12:34.000Z"),
    consoleWriter: line => consoleLines.push(line)
  });

  await logger.info("proxy.request", {
    requestId: "req_1",
    provider: "openai",
    apiKey: "should-not-be-logged"
  });

  const files = await readdir(logDir);
  assert.deepEqual(files, ["2026-06-05.log"]);

  const line = (await readFile(join(logDir, "2026-06-05.log"), "utf8")).trim();
  const entry = JSON.parse(line);
  assert.equal(entry.level, "info");
  assert.equal(entry.event, "proxy.request");
  assert.equal(entry.requestId, "req_1");
  assert.equal(entry.provider, "openai");
  assert.equal(entry.apiKey, "[redacted]");
  assert.equal(consoleLines.length, 1);
});

test("redactLogValue hides secrets and large image payloads", () => {
  assert.equal(redactLogValue("authorization", "Bearer abc"), "[redacted]");
  assert.equal(redactLogValue("x-goog-api-key", "abc"), "[redacted]");
  assert.equal(redactLogValue("hasApiKey", true), true);
  assert.equal(redactLogValue("data", "a".repeat(200)), "[base64:200]");
  assert.equal(redactLogValue("prompt", "hello"), "hello");
});

test("summarizePayload keeps useful request shape without image bytes", () => {
  const summary = summarizePayload({
    prompt: "hello",
    model: "gpt-image-2",
    input_images: [
      { name: "a.png", mime_type: "image/png", data: "abc" },
      { name: "b.jpg", mime_type: "image/jpeg", data: "def" }
    ]
  });

  assert.deepEqual(summary, {
    promptLength: 5,
    model: "gpt-image-2",
    inputImageCount: 2,
    inputImages: [
      { name: "a.png", mimeType: "image/png", data: "[base64:3]" },
      { name: "b.jpg", mimeType: "image/jpeg", data: "[base64:3]" }
    ]
  });
}
);

test("sanitizeLogFields keeps nested error cause details", () => {
  const cause = new Error("Headers Timeout Error");
  cause.code = "UND_ERR_HEADERS_TIMEOUT";
  const error = new Error("fetch failed", { cause });
  error.code = "FETCH_FAILED";

  assert.deepEqual(sanitizeLogFields({ error }), {
    error: {
      name: "Error",
      message: "fetch failed",
      code: "FETCH_FAILED",
      stack: error.stack,
      cause: {
        name: "Error",
        message: "Headers Timeout Error",
        code: "UND_ERR_HEADERS_TIMEOUT",
        stack: cause.stack
      }
    }
  });
});
