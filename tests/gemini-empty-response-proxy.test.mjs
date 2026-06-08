import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

const ROOT = new URL("../", import.meta.url);

async function listenOnRandomPort(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server.address().port;
}

async function waitForProxy(port) {
  const startedAt = Date.now();
  let lastError;

  while (Date.now() - startedAt < 5000) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (response.ok) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  throw lastError || new Error("Proxy server did not start in time.");
}

test("Gemini proxy returns diagnostics when upstream succeeds without images", async t => {
  const fakeUpstream = createServer((req, res) => {
    assert.equal(req.url, "/v1/models/gemini-test:generateContent");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      promptFeedback: {
        blockReason: "SAFETY"
      },
      candidates: [
        {
          finishReason: "SAFETY",
          content: {
            parts: [
              { text: "无法生成该图片，请调整提示词后重试。" }
            ]
          }
        }
      ]
    }));
  });
  const upstreamPort = await listenOnRandomPort(fakeUpstream);

  const portProbe = createServer();
  const proxyPort = await listenOnRandomPort(portProbe);
  await new Promise(resolve => portProbe.close(resolve));

  const tempDir = await mkdtemp(join(tmpdir(), "ai-image-proxy-test-"));
  const logDir = join(tempDir, "logs");
  const child = spawn(process.execPath, ["outputs/ai-image-proxy-server.mjs"], {
    cwd: new URL(".", ROOT),
    env: {
      ...process.env,
      PORT: String(proxyPort),
      GEMINI_IMAGE_BASE_URL: `http://127.0.0.1:${upstreamPort}`,
      GEMINI_IMAGE_MODEL: "gemini-test",
      AI_IMAGE_LOG_DIR: logDir
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  t.after(async () => {
    child.kill();
    fakeUpstream.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  await waitForProxy(proxyPort);

  const response = await fetch(`http://127.0.0.1:${proxyPort}/api/images/generations`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-ai-image-provider": "gemini",
      "x-ai-image-api-key": "sk-123456789abcdef",
      "x-client-request-id": "empty-image-test"
    },
    body: JSON.stringify({
      prompt: "生成一张测试图片"
    })
  });
  const json = await response.json();

  assert.equal(response.status, 502);
  assert.equal(json.request_id, "empty-image-test");
  assert.match(json.error.message, /没有返回图片/);
  assert.equal(json.error.details.text, "无法生成该图片，请调整提示词后重试。");
  assert.deepEqual(json.error.details.finishReasons, ["SAFETY"]);
  assert.deepEqual(json.error.details.promptFeedback, { blockReason: "SAFETY" });

  const logText = await readFile(join(logDir, `${new Date().toISOString().slice(0, 10)}.log`), "utf8");
  assert.match(logText, /proxy.empty_image_response/);
  assert.match(logText, /empty-image-test/);
});
