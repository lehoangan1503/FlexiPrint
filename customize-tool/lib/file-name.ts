/** File names of the thư viện ảnh tổ hợp: "Ảnh nền (5)" → "Anh_nen_5" (ASCII, words joined by "_"). Pure. */
export function fileStem(name: string): string {
  const ascii = name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D");
  return ascii.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 80) || "anh";
}

export const IMAGE_EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };

/** The photos a pack_image request sends back (its bases, or the one legacy base). */
export function packBases(p: { bases?: Array<{ id: string; url: string; name: string; note: string }>; baseId: string | null; baseUrl: string } | undefined) {
  if (!p) return [];
  if (p.bases?.length) return p.bases;
  return p.baseId && p.baseUrl ? [{ id: p.baseId, url: p.baseUrl, name: "", note: "" }] : [];
}
