import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const html = await readFile(new URL("../outputs/ai-image-generator.html", import.meta.url), "utf8");

test("service panel does not duplicate the generation mode control", () => {
  assert.equal(html.includes('id="mode"'), false);
  assert.equal(html.includes("调用模式"), false);
  assert.equal((html.match(/data-input-mode=/g) || []).length, 2);
});
