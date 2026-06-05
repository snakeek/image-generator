import assert from "node:assert/strict";
import test from "node:test";

import {
  publicProviderSummary,
  resolveProviderConfig
} from "../outputs/provider-config.mjs";

test("resolveProviderConfig reads OpenAI-compatible group from backend env", () => {
  const config = resolveProviderConfig("openai", {
    OPENAI_IMAGE_BASE_URL: "https://openai.example/v1",
    OPENAI_IMAGE_API_KEY: "openai-secret",
    OPENAI_IMAGE_MODEL: "gpt-image-2-custom"
  });

  assert.deepEqual(config, {
    provider: "openai",
    baseUrl: "https://openai.example/v1",
    apiKey: "openai-secret",
    model: "gpt-image-2-custom"
  });
});

test("resolveProviderConfig reads Gemini group from backend env", () => {
  const config = resolveProviderConfig("gemini", {
    GEMINI_IMAGE_BASE_URL: "https://gemini.example/v1",
    GEMINI_IMAGE_API_KEY: "gemini-secret",
    GEMINI_IMAGE_MODEL: "gemini-3-pro-image"
  });

  assert.deepEqual(config, {
    provider: "gemini",
    baseUrl: "https://gemini.example/v1",
    apiKey: "gemini-secret",
    model: "gemini-3-pro-image"
  });
});

test("publicProviderSummary exposes only non-secret provider status", () => {
  const summary = publicProviderSummary({
    OPENAI_IMAGE_BASE_URL: "https://openai.example/v1",
    OPENAI_IMAGE_API_KEY: "openai-secret",
    OPENAI_IMAGE_MODEL: "gpt-image-2-custom",
    GEMINI_IMAGE_BASE_URL: "https://gemini.example/v1",
    GEMINI_IMAGE_MODEL: "gemini-3-pro-image"
  });

  assert.deepEqual(summary, [
    {
      provider: "openai",
      baseUrl: "https://openai.example/v1",
      model: "gpt-image-2-custom",
      hasApiKey: true
    },
    {
      provider: "gemini",
      baseUrl: "https://gemini.example/v1",
      model: "gemini-3-pro-image",
      hasApiKey: false
    }
  ]);
});
