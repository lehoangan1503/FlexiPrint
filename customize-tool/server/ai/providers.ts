/**
 * Image-generation providers behind one interface.
 *
 *   gemini  Google Generative Language API (Nano Banana family). Best at
 *           keeping a subject consistent across edits → variants. No alpha
 *           output; sub objects come back on white and are cut in the editor.
 *   openai  OpenAI Images API (gpt-image). Can emit a transparent background
 *           directly. OPENAI_BASE_URL lets an OpenAI-compatible proxy stand in.
 *
 * Env:
 *   GEMINI_API_KEY, GEMINI_IMAGE_MODELS (optional, comma list overrides defaults)
 *   OPENAI_API_KEY, OPENAI_BASE_URL (optional), OPENAI_IMAGE_MODELS (optional)
 */

import type { CtAiModelOption, CtAiProviderId, CtAiProviderInfo, CtAspectRatio } from "../../types";

export interface ProviderImage {
  data: Buffer;
  mime: string;
}

export interface ProviderRequest {
  model: string;
  prompt: string;
  references: ProviderImage[];
  aspectRatio: CtAspectRatio;
  count: number;
  transparent: boolean;
}

interface ImageProvider {
  id: CtAiProviderId;
  label: string;
  configured(): boolean;
  models(): CtAiModelOption[];
  generate(req: ProviderRequest): Promise<ProviderImage[]>;
}

function modelsFromEnv(envName: string, fallback: CtAiModelOption[]): CtAiModelOption[] {
  const raw = process.env[envName];
  if (!raw) return fallback;
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((id) => fallback.find((m) => m.id === id) ?? { id, label: id, supportsTransparent: false, maxReferences: 8 });
}

async function readError(res: Response): Promise<string> {
  const text = await res.text().catch(() => "");
  try {
    const parsed: { error?: { message?: string } } = JSON.parse(text);
    return parsed.error?.message ?? text.slice(0, 400);
  } catch {
    return text.slice(0, 400);
  }
}

// ---------------------------------------------------------------------------
// Gemini
// ---------------------------------------------------------------------------

const GEMINI_MODELS: CtAiModelOption[] = [
  { id: "gemini-3.1-flash-image-preview", label: "Nano Banana 2 (Gemini 3.1 Flash Image)", supportsTransparent: false, maxReferences: 14 },
  { id: "gemini-3-pro-image-preview", label: "Nano Banana Pro (Gemini 3 Pro Image)", supportsTransparent: false, maxReferences: 14 },
  { id: "gemini-2.5-flash-image", label: "Nano Banana (Gemini 2.5 Flash Image)", supportsTransparent: false, maxReferences: 3 },
];

interface GeminiPart {
  text?: string;
  inlineData?: { mimeType: string; data: string };
}

interface GeminiResponse {
  candidates?: Array<{ content?: { parts?: GeminiPart[] }; finishReason?: string }>;
  promptFeedback?: { blockReason?: string };
}

const gemini: ImageProvider = {
  id: "gemini",
  label: "Google Gemini (Nano Banana)",
  configured: () => Boolean(process.env.GEMINI_API_KEY),
  models: () => modelsFromEnv("GEMINI_IMAGE_MODELS", GEMINI_MODELS),
  async generate(req) {
    const key = process.env.GEMINI_API_KEY;
    if (!key) throw new Error("Chưa cấu hình GEMINI_API_KEY");
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(req.model)}:generateContent`;

    const parts: GeminiPart[] = [
      ...req.references.map((r) => ({ inlineData: { mimeType: r.mime, data: r.data.toString("base64") } })),
      { text: req.prompt },
    ];
    // imageSize is only understood by the Gemini 3 image models.
    const imageConfig: Record<string, string> = { aspectRatio: req.aspectRatio };
    if (req.model.startsWith("gemini-3")) imageConfig.imageSize = "2K";

    const one = async (): Promise<ProviderImage> => {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify({
          contents: [{ role: "user", parts }],
          generationConfig: { responseModalities: ["IMAGE"], imageConfig },
        }),
      });
      if (!res.ok) throw new Error(`Gemini ${res.status}: ${await readError(res)}`);
      const json: GeminiResponse = await res.json();
      if (json.promptFeedback?.blockReason) throw new Error(`Gemini chặn prompt: ${json.promptFeedback.blockReason}`);
      const img = json.candidates?.[0]?.content?.parts?.find((p) => p.inlineData)?.inlineData;
      if (!img) {
        const reason = json.candidates?.[0]?.finishReason ?? "không có ảnh";
        throw new Error(`Gemini không trả ảnh (${reason})`);
      }
      return { data: Buffer.from(img.data, "base64"), mime: img.mimeType };
    };

    // One image per call — fan out for count > 1.
    return Promise.all(Array.from({ length: req.count }, one));
  },
};

// ---------------------------------------------------------------------------
// OpenAI
// ---------------------------------------------------------------------------

const OPENAI_MODELS: CtAiModelOption[] = [
  { id: "gpt-image-1.5", label: "GPT Image 1.5", supportsTransparent: true, maxReferences: 16 },
  { id: "gpt-image-1", label: "GPT Image 1", supportsTransparent: true, maxReferences: 16 },
];

const OPENAI_SIZES: Record<CtAspectRatio, string> = {
  "1:1": "1024x1024",
  "3:4": "1024x1536",
  "9:16": "1024x1536",
  "4:3": "1536x1024",
  "16:9": "1536x1024",
};

interface OpenAiImagesResponse {
  data?: Array<{ b64_json?: string }>;
}

const openai: ImageProvider = {
  id: "openai",
  label: "OpenAI (GPT Image)",
  configured: () => Boolean(process.env.OPENAI_API_KEY),
  models: () => modelsFromEnv("OPENAI_IMAGE_MODELS", OPENAI_MODELS),
  async generate(req) {
    const key = process.env.OPENAI_API_KEY;
    if (!key) throw new Error("Chưa cấu hình OPENAI_API_KEY");
    const base = (process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1").replace(/\/$/, "");
    const size = OPENAI_SIZES[req.aspectRatio];
    const background = req.transparent ? "transparent" : "opaque";

    let res: Response;
    if (req.references.length === 0) {
      res = await fetch(`${base}/images/generations`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model: req.model,
          prompt: req.prompt,
          n: req.count,
          size,
          quality: "high",
          background,
          output_format: "png",
        }),
      });
    } else {
      const form = new FormData();
      form.append("model", req.model);
      form.append("prompt", req.prompt);
      form.append("n", String(req.count));
      form.append("size", size);
      form.append("quality", "high");
      form.append("background", background);
      form.append("output_format", "png");
      req.references.forEach((r, i) => {
        const ext = r.mime.split("/")[1] ?? "png";
        form.append("image[]", new Blob([new Uint8Array(r.data)], { type: r.mime }), `ref-${i}.${ext}`);
      });
      res = await fetch(`${base}/images/edits`, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}` },
        body: form,
      });
    }
    if (!res.ok) throw new Error(`OpenAI ${res.status}: ${await readError(res)}`);
    const json: OpenAiImagesResponse = await res.json();
    const images = (json.data ?? []).filter((d): d is { b64_json: string } => Boolean(d.b64_json));
    if (images.length === 0) throw new Error("OpenAI không trả ảnh");
    return images.map((d) => ({ data: Buffer.from(d.b64_json, "base64"), mime: "image/png" }));
  },
};

// ---------------------------------------------------------------------------

const PROVIDERS: Record<CtAiProviderId, ImageProvider> = { gemini, openai };

export function getProvider(id: CtAiProviderId): ImageProvider | null {
  return PROVIDERS[id] ?? null;
}

export function listProviders(): CtAiProviderInfo[] {
  return Object.values(PROVIDERS).map((p) => ({
    id: p.id,
    label: p.label,
    configured: p.configured(),
    models: p.models(),
  }));
}
