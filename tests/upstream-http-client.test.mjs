import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";

import {
  postBuffered
} from "../outputs/upstream-http-client.mjs";

async function listenOnRandomPort(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server.address().port;
}

test("postBuffered waits for a delayed upstream response", async () => {
  const server = createServer((req, res) => {
    assert.equal(req.method, "POST");
    assert.equal(req.url, "/images/generations");
    setTimeout(() => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ url: "https://example.com/image.png" }] }));
    }, 120);
  });
  const port = await listenOnRandomPort(server);

  try {
    const response = await postBuffered(`http://127.0.0.1:${port}/images/generations`, {
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({ prompt: "test" }),
      timeoutMs: 1000
    });

    assert.equal(response.status, 200);
    assert.equal(response.ok, true);
    assert.equal(response.headers.get("content-type"), "application/json");
    assert.match(await response.text(), /example\.com/);
  } finally {
    server.close();
  }
});

test("postBuffered reports a clear upstream timeout error", async () => {
  const server = createServer(() => {});
  const port = await listenOnRandomPort(server);

  try {
    await assert.rejects(
      postBuffered(`http://127.0.0.1:${port}/images/generations`, {
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({ prompt: "test" }),
        timeoutMs: 20
      }),
      error => {
        assert.equal(error.name, "UpstreamRequestError");
        assert.equal(error.message, "Upstream request timed out after 20ms.");
        assert.equal(error.code, "UPSTREAM_TIMEOUT");
        assert.equal(error.statusCode, 504);
        return true;
      }
    );
  } finally {
    server.close();
  }
});
