const PROVIDER_DEFAULTS = {
  openai: {
    baseUrl: "https://ai98pro.xyz/v1",
    model: "gpt-image-2"
  },
  gemini: {
    baseUrl: "https://generativelanguage.googleapis.com/v1",
    model: "gemini-3.1-flash-image"
  }
};

function cleanBaseUrl(value = "") {
  return String(value).trim().replace(/\/+$/, "");
}

function valueFrom(env, keys, fallback = "") {
  for (const key of keys) {
    if (env[key]) return String(env[key]).trim();
  }
  return fallback;
}

export function normalizeProvider(provider = "openai") {
  const value = String(provider || "openai").trim().toLowerCase();
  if (value === "gpt") return "openai";
  if (value === "nano-banana" || value === "nanobanana") return "gemini";
  return value;
}

export function resolveProviderConfig(provider = "openai", env = process.env) {
  const normalized = normalizeProvider(provider);
  if (!PROVIDER_DEFAULTS[normalized]) {
    return null;
  }

  if (normalized === "gemini") {
    return {
      provider: "gemini",
      baseUrl: cleanBaseUrl(valueFrom(env, ["GEMINI_IMAGE_BASE_URL"], PROVIDER_DEFAULTS.gemini.baseUrl)),
      apiKey: valueFrom(env, ["GEMINI_IMAGE_API_KEY"], ""),
      model: valueFrom(env, ["GEMINI_IMAGE_MODEL"], PROVIDER_DEFAULTS.gemini.model)
    };
  }

  return {
    provider: "openai",
    baseUrl: cleanBaseUrl(valueFrom(env, ["OPENAI_IMAGE_BASE_URL", "AI_IMAGE_BASE_URL"], PROVIDER_DEFAULTS.openai.baseUrl)),
    apiKey: valueFrom(env, ["OPENAI_IMAGE_API_KEY", "AI_IMAGE_API_KEY"], ""),
    model: valueFrom(env, ["OPENAI_IMAGE_MODEL", "AI_IMAGE_MODEL"], PROVIDER_DEFAULTS.openai.model)
  };
}

export function publicProviderSummary(env = process.env) {
  return ["openai", "gemini"].map(provider => {
    const config = resolveProviderConfig(provider, env);
    return {
      provider: config.provider,
      baseUrl: config.baseUrl,
      model: config.model,
      hasApiKey: Boolean(config.apiKey)
    };
  });
}
