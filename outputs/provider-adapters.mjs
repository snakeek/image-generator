export function cleanBaseUrl(value = "") {
  return String(value).trim().replace(/\/+$/, "");
}

function geminiApiRoot(baseUrl) {
  const cleaned = cleanBaseUrl(baseUrl);
  try {
    const url = new URL(cleaned);
    if (url.pathname === "" || url.pathname === "/") {
      return `${url.origin}/v1`;
    }
  } catch {
    return cleaned;
  }
  return cleaned;
}

export function buildGeminiRequest({ baseUrl, apiKey, body }) {
  const model = body.model || "gemini-2.5-flash-image-preview";
  const parts = [];

  if (body.prompt) {
    parts.push({ text: body.prompt });
  }

  for (const image of body.input_images || []) {
    if (!image?.data) continue;
    parts.push({
      inline_data: {
        mime_type: image.mime_type || image.mimeType || "image/png",
        data: image.data
      }
    });
  }

  const generationConfig = {
    responseModalities: ["IMAGE"]
  };

  if (body.aspect_ratio || body.image_size) {
    generationConfig.responseFormat = {
      image: {}
    };
    if (body.aspect_ratio) generationConfig.responseFormat.image.aspectRatio = body.aspect_ratio;
    if (body.image_size) generationConfig.responseFormat.image.imageSize = body.image_size;
  }

  return {
    url: `${geminiApiRoot(baseUrl)}/models/${encodeURIComponent(model)}:generateContent`,
    headers: {
      "x-goog-api-key": apiKey,
      "content-type": "application/json"
    },
    body: {
      contents: [
        {
          parts
        }
      ],
      generationConfig
    }
  };
}

export function normalizeGeminiResponse(json) {
  const textParts = [];
  const images = [];

  for (const candidate of json?.candidates || []) {
    for (const part of candidate?.content?.parts || []) {
      if (part.text) {
        textParts.push(part.text);
      }

      const inlineData = part.inlineData || part.inline_data;
      if (inlineData?.data) {
        images.push({
          b64_json: inlineData.data,
          mime_type: inlineData.mimeType || inlineData.mime_type || "image/png"
        });
      }
    }
  }

  const revisedPrompt = textParts.join("\n").trim();
  return {
    data: images.map(image => ({
      ...image,
      ...(revisedPrompt ? { revised_prompt: revisedPrompt } : {})
    }))
  };
}
