import { appendFile, mkdir, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";

const SECRET_KEY_PATTERN = /(api[-_]?key|authorization|cookie|token|secret|password)/i;
const IMAGE_DATA_KEYS = new Set(["data", "b64_json", "image"]);

export function formatLogDate(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function redactLogValue(key, value) {
  const name = String(key || "");
  if (/^has[A-Z_-]/.test(name) || /^has(api|secret|token|password|key)/i.test(name)) return value;
  if (SECRET_KEY_PATTERN.test(name)) return "[redacted]";

  if (typeof value === "string") {
    if (IMAGE_DATA_KEYS.has(name) && value.length > 0) return `[base64:${value.length}]`;
    if (value.length > 1200) return `${value.slice(0, 1200)}...[truncated:${value.length}]`;
  }

  return value;
}

export function sanitizeLogFields(value, key = "") {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack ? redactLogValue("stack", value.stack) : undefined
    };
  }

  if (Array.isArray(value)) {
    return value.map(item => sanitizeLogFields(item, key));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, entryValue]) => [
        entryKey,
        sanitizeLogFields(redactLogValue(entryKey, entryValue), entryKey)
      ])
    );
  }

  return redactLogValue(key, value);
}

export function summarizePayload(payload = {}) {
  const summary = {};
  if (typeof payload.prompt === "string") summary.promptLength = payload.prompt.length;
  if (payload.model) summary.model = payload.model;
  if (payload.size) summary.size = payload.size;
  if (payload.quality) summary.quality = payload.quality;
  if (payload.output_format) summary.outputFormat = payload.output_format;
  if (payload.aspect_ratio) summary.aspectRatio = payload.aspect_ratio;
  if (payload.image_size) summary.imageSize = payload.image_size;
  if (payload.n) summary.count = payload.n;

  if (Array.isArray(payload.input_images)) {
    summary.inputImageCount = payload.input_images.length;
    summary.inputImages = payload.input_images.map(image => ({
      name: image.name,
      mimeType: image.mime_type || image.mimeType,
      data: redactLogValue("data", image.data || "")
    }));
  }

  return summary;
}

export function createDailyLogger({
  logDir = join(process.cwd(), "logs"),
  now = () => new Date(),
  consoleWriter = line => console.log(line)
} = {}) {
  let activeDate = "";
  let pending = Promise.resolve();

  async function prepare(date) {
    if (date === activeDate) return;
    await mkdir(logDir, { recursive: true });
    const files = await readdir(logDir);
    await Promise.all(
      files
        .filter(file => file.endsWith(".log") && file !== `${date}.log`)
        .map(file => unlink(join(logDir, file)).catch(() => {}))
    );
    activeDate = date;
  }

  async function write(level, event, fields = {}) {
    const timestamp = now();
    const date = formatLogDate(timestamp);
    const entry = sanitizeLogFields({
      ts: timestamp.toISOString(),
      level,
      event,
      ...fields
    });
    const line = JSON.stringify(entry);
    consoleWriter(line);
    await prepare(date);
    await appendFile(join(logDir, `${date}.log`), `${line}\n`, "utf8");
  }

  function enqueue(level, event, fields) {
    pending = pending.then(
      () => write(level, event, fields),
      () => write(level, event, fields)
    );
    return pending;
  }

  return {
    logDir,
    info: (event, fields) => enqueue("info", event, fields),
    warn: (event, fields) => enqueue("warn", event, fields),
    error: (event, fields) => enqueue("error", event, fields)
  };
}
