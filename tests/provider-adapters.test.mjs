import assert from "node:assert/strict";
import test from "node:test";

import {
  buildGeminiRequest,
  normalizeGeminiResponse
} from "../outputs/provider-adapters.mjs";

test("buildGeminiRequest maps text prompts and output settings to generateContent", () => {
  const request = buildGeminiRequest({
    baseUrl: "https://generativelanguage.googleapis.com/v1",
    apiKey: "test-key",
    pathname: "/api/images/generations",
    body: {
      model: "gemini-3.1-flash-image",
      prompt: "画一张产品海报",
      aspect_ratio: "16:9",
      image_size: "2K"
    }
  });

  assert.equal(
    request.url,
    "https://generativelanguage.googleapis.com/v1/models/gemini-3.1-flash-image:generateContent"
  );
  assert.equal(request.headers["x-goog-api-key"], "test-key");
  assert.equal(request.headers["content-type"], "application/json");
  assert.deepEqual(request.body.contents, [
    {
      parts: [
        { text: "画一张产品海报" }
      ]
    }
  ]);
  assert.deepEqual(request.body.generationConfig, {
    responseModalities: ["IMAGE"],
    responseFormat: {
      image: {
        aspectRatio: "16:9",
        imageSize: "2K"
      }
    }
  });
});

test("buildGeminiRequest maps uploaded reference images to inline_data parts", () => {
  const request = buildGeminiRequest({
    baseUrl: "https://generativelanguage.googleapis.com/v1/",
    apiKey: "test-key",
    pathname: "/api/images/edits",
    body: {
      model: "gemini-2.5-flash-image",
      prompt: "把参考图改成水彩风格",
      input_images: [
        {
          mime_type: "image/png",
          data: "abc123"
        }
      ]
    }
  });

  assert.equal(
    request.url,
    "https://generativelanguage.googleapis.com/v1/models/gemini-2.5-flash-image:generateContent"
  );
  assert.deepEqual(request.body.contents[0].parts, [
    { text: "把参考图改成水彩风格" },
    {
      inline_data: {
        mime_type: "image/png",
        data: "abc123"
      }
    }
  ]);
});

test("buildGeminiRequest adds v1 when Gemini base URL is a service root", () => {
  const request = buildGeminiRequest({
    baseUrl: "https://vip.undyingapi.com",
    apiKey: "test-key",
    pathname: "/api/images/generations",
    body: {
      model: "gemini-2.5-flash-image-preview",
      prompt: "画一张图"
    }
  });

  assert.equal(
    request.url,
    "https://vip.undyingapi.com/v1/models/gemini-2.5-flash-image-preview:generateContent"
  );
});

test("normalizeGeminiResponse returns the first inline image as OpenAI-compatible data", () => {
  const normalized = normalizeGeminiResponse({
    candidates: [
      {
        content: {
          parts: [
            { text: "已完成" },
            {
              inlineData: {
                mimeType: "image/png",
                data: "base64-image"
              }
            }
          ]
        }
      }
    ]
  });

  assert.deepEqual(normalized, {
    data: [
      {
        b64_json: "base64-image",
        mime_type: "image/png",
        revised_prompt: "已完成"
      }
    ]
  });
});

test("normalizeGeminiResponse keeps Gemini no-image diagnostics", () => {
  const normalized = normalizeGeminiResponse({
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
  });

  assert.deepEqual(normalized, {
    data: [],
    text: "无法生成该图片，请调整提示词后重试。",
    finishReasons: ["SAFETY"],
    promptFeedback: {
      blockReason: "SAFETY"
    }
  });
});
