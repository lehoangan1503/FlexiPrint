/**
 * Team-wide settings (migration 020). Today: the image model every AI picture is made with — picked on the home
 * page, applied server-side to every studio run (web app and @flexiprint alike) and to the ảnh tổ hợp library.
 *
 *   GET settings/image-model            → { model, models }
 *   PUT settings/image-model { model }  → { model, models }
 */

import { NextResponse } from "next/server";
import { CT_TABLES } from "../config";
import { CT_DEFAULT_IMAGE_MODEL, CT_IMAGE_MODELS, isImageModel } from "../lib/image-models";
import { ctServiceClient, type CtSession } from "./supabase";

const KEY = "image_model";
/** Read by every run: cached briefly so a burst of runs costs one query; a PUT here refreshes it at once. */
const TTL_MS = 15_000;
let cached: { model: string; at: number } | null = null;

/** The image model to use now (the default when unset or unreadable). */
export async function currentImageModel(): Promise<string> {
  if (cached && Date.now() - cached.at < TTL_MS) return cached.model;
  const db = ctServiceClient();
  let model = CT_DEFAULT_IMAGE_MODEL;
  if (db) {
    const { data } = await db.from(CT_TABLES.settings).select("value").eq("key", KEY).maybeSingle<{ value: unknown }>();
    if (isImageModel(data?.value)) model = data.value;
  }
  cached = { model, at: Date.now() };
  return model;
}

function answer(model: string): NextResponse {
  return NextResponse.json({ model, models: CT_IMAGE_MODELS });
}

/** GET settings/image-model */
export async function getImageModel(): Promise<NextResponse> {
  return answer(await currentImageModel());
}

/** PUT settings/image-model { model } */
export async function setImageModel(s: CtSession, body: { model?: unknown } | null): Promise<NextResponse> {
  const model = body?.model;
  if (!isImageModel(model)) return NextResponse.json({ error: "Model không hợp lệ" }, { status: 400 });
  const { error } = await s.supabase.from(CT_TABLES.settings).upsert({ key: KEY, value: model, updated_by: s.user.id });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  cached = { model, at: Date.now() };
  return answer(model);
}
