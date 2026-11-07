/* eslint-disable @next/next/no-img-element -- static screenshots from /public/huong-dan */
/**
 * /huong-dan — the team's guide to Product base · Artwork · Sản phẩm (asked 2026-11-07: "hướng dẫn là 1 route … cho
 * dễ hình dung chứ ghi text không hiểu được"). Pictures first: diagrams drawn in HTML, real screenshots of Teeinblue
 * (Cherivia) and flexi2 side by side, short text. Screenshots live in public/huong-dan/.
 */

import Link from "next/link";
import { ArrowDown, ArrowRight, Check, ChevronDown, FileImage, Image as ImageIcon, Layers, Package, Printer, Scissors, ShoppingBag, Store, Tag, X } from "lucide-react";

const IMG = "/huong-dan";

const TOC: Array<[string, string]> = [
  ["tong-quan", "1. Tổng quan"],
  ["so-sanh", "2. So với Teeinblue"],
  ["artwork", "3. Artwork: Preview / Print"],
  ["chua-chuan", "4. Teeinblue chưa chuẩn ở đâu"],
  ["gop-tach", "5. Gộp 1 canvas vs tách version"],
  ["import", "6. Bộ import & clipart"],
  ["thao-tac", "7. Thao tác từng bước"],
  ["file-in", "8. File in từng loại"],
];

function Section({ id, title, lead, children }: { id: string; title: string; lead?: string; children: React.ReactNode }) {
  return (
    <section id={id} className="scroll-mt-20 border-t pt-10">
      <h2 className="text-2xl font-bold tracking-tight">{title}</h2>
      {lead && <p className="mt-2 max-w-3xl text-muted-foreground">{lead}</p>}
      <div className="mt-6 space-y-6">{children}</div>
    </section>
  );
}

function Shot({ src, caption, tone }: { src: string; caption: string; tone?: "tb" | "fx" }) {
  return (
    <figure className="overflow-hidden rounded-xl border bg-card shadow-sm">
      <div className="flex items-center gap-2 border-b px-3 py-1.5 text-xs">
        {tone && (
          <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${tone === "tb" ? "bg-blue-600 text-white" : "bg-emerald-600 text-white"}`}>{tone === "tb" ? "Teeinblue" : "flexi2"}</span>
        )}
        <span className="text-muted-foreground">{caption}</span>
      </div>
      <a href={`${IMG}/${src}`} target="_blank" rel="noreferrer" title="Mở ảnh lớn">
        <img src={`${IMG}/${src}`} alt={caption} className="w-full" loading="lazy" />
      </a>
    </figure>
  );
}

function Box({ icon: Icon, title, tone, items }: { icon: typeof Package; title: string; tone: string; items: string[] }) {
  return (
    <div className={`rounded-2xl border-2 p-4 ${tone}`}>
      <div className="mb-2 flex items-center gap-2 text-lg font-bold">
        <Icon className="h-5 w-5" /> {title}
      </div>
      <ul className="space-y-1 text-sm">
        {items.map((t) => (
          <li key={t} className="flex gap-1.5">
            <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 opacity-70" />
            {t}
          </li>
        ))}
      </ul>
    </div>
  );
}

function Step({ n, title, children, shot }: { n: number; title: string; children: React.ReactNode; shot?: string }) {
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
      <div>
        <div className="flex items-center gap-3">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-foreground text-sm font-bold text-background">{n}</span>
          <h3 className="text-lg font-semibold">{title}</h3>
        </div>
        <div className="mt-3 space-y-2 pl-11 text-sm leading-relaxed text-muted-foreground [&_b]:text-foreground">{children}</div>
      </div>
      {shot && <Shot src={shot} caption={title} tone="fx" />}
    </div>
  );
}

/** A Layers panel drawn in HTML: Teeinblue's two groups, and ours. */
function LayersMock({ kind }: { kind: "tb" | "fx" }) {
  const head = (title: string, dot: string, n: number) => (
    <div className="flex items-center gap-1.5 border-y bg-muted/70 px-2 py-1.5 text-xs font-semibold">
      <ChevronDown className="h-3.5 w-3.5" />
      <span className={`h-2 w-2 rounded-full ${dot}`} />
      <span className="flex-1">{title}</span>
      <span className="text-[10px] font-normal text-muted-foreground">{n}</span>
    </div>
  );
  const row = (label: string, note?: string, warn?: boolean) => (
    <div className="flex items-center gap-2 py-1 pl-6 pr-2 text-xs">
      <span className="h-4 w-4 shrink-0 rounded border bg-muted" />
      <span className="flex-1 truncate">{label}</span>
      {note && <span className={`text-[10px] ${warn ? "font-semibold text-amber-600" : "text-muted-foreground"}`}>{note}</span>}
    </div>
  );
  if (kind === "tb")
    return (
      <div className="overflow-hidden rounded-xl border bg-card">
        <div className="border-b px-3 py-2 text-sm font-semibold">Layers · Teeinblue</div>
        {head("Preview (preview only)", "bg-sky-500", 344)}
        {row("Preview scene (blank)", "phôi")}
        {row("Preview Name 1 · 2 · 3", "chữ bản preview")}
        {row("Preview 18-chau3-toc… (×333)", "ảnh bản preview")}
        {head("Print (Order only)", "bg-orange-500", 340)}
        {row("Print silhouette", "đen")}
        {row("Print Name 1 · 2 · 3", "chữ bản in")}
        {row("02-chau3-than… (×334)", "ảnh bản in")}
        <p className="border-t px-3 py-2 text-[11px] text-muted-foreground">689 layer: mỗi ảnh có 1 bản Print + 1 bản Preview, mỗi option là 1 layer có điều kiện.</p>
      </div>
    );
  return (
    <div className="overflow-hidden rounded-xl border bg-card">
      <div className="border-b px-3 py-2 text-sm font-semibold">Layers · flexi2</div>
      {head("Preview (preview only)", "bg-sky-500", 1)}
      {row("Phôi trơn (blank)", "bấm để đặt phôi")}
      {head("Print (Order only)", "bg-orange-500", 1)}
      {row("Khuôn in · Acrylic cắt viền", "đường cắt")}
      {head("Thiết kế (preview + file in)", "bg-emerald-500", 9)}
      {row("Chữ — Grandma's name")}
      {row("Chọn — Tóc (4 option)")}
      {row("Chọn — Theme (2 option)")}
      {row("Thân")}
      <p className="border-t px-3 py-2 text-[11px] text-muted-foreground">Mỗi layer 1 lần, dùng cho cả preview lẫn file in. Chỉ thứ thật sự khác mới nằm trong Preview / Print.</p>
    </div>
  );
}

export function GuidePage() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="sticky top-0 z-20 border-b bg-card/90 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-3 px-4">
          <Link href="/dashboard" className="text-sm text-muted-foreground hover:text-foreground">
            ← Dashboard
          </Link>
          <h1 className="font-semibold">Hướng dẫn: Product base · Artwork · Sản phẩm</h1>
          <span className="ml-auto hidden text-xs text-muted-foreground sm:inline">cập nhật 2026-11-07</span>
        </div>
      </header>

      <div className="mx-auto grid max-w-6xl gap-10 px-4 py-8 lg:grid-cols-[200px_minmax(0,1fr)]">
        <nav className="hidden lg:block">
          <div className="sticky top-20 space-y-1 text-sm">
            {TOC.map(([id, label]) => (
              <a key={id} href={`#${id}`} className="block rounded px-2 py-1 text-muted-foreground hover:bg-accent hover:text-foreground">
                {label}
              </a>
            ))}
          </div>
        </nav>

        <main className="min-w-0 space-y-10">
          {/* ---------------------------------------------------------------- 1 */}
          <section id="tong-quan" className="scroll-mt-20">
            <h2 className="text-3xl font-bold tracking-tight">3 thứ, ghép lại thành sản phẩm bán</h2>
            <p className="mt-2 max-w-3xl text-muted-foreground">Giống Teeinblue: Product Base · Artwork · Campaign. Mỗi thứ giữ đúng một phần việc.</p>
            <div className="mt-6 grid items-center gap-3 md:grid-cols-[1fr_auto_1fr_auto_1fr]">
              <div className="space-y-3">
                <Box icon={Tag} title="Product base" tone="border-amber-500/60 bg-amber-500/5" items={["Loại sản phẩm (Acrylic 1 side…)", "Biến thể size × pack", "Giá (bảng Notion)", "Khuôn in + phôi trơn của loại", "Xưởng, print area"]} />
                <Box icon={Layers} title="Artwork" tone="border-violet-500/60 bg-violet-500/5" items={["Mọi layer, clipart, version", "Option khách chọn (personalize)", "Phôi trơn → Preview", "Khuôn in → File in", "Không có giá"]} />
              </div>
              <ArrowRight className="mx-auto hidden h-8 w-8 text-muted-foreground md:block" />
              <ArrowDown className="mx-auto h-8 w-8 text-muted-foreground md:hidden" />
              <Box icon={ShoppingBag} title="Sản phẩm" tone="border-sky-500/60 bg-sky-500/5" items={["= Artwork + Product base", "Tên theo chủ đề", "Mockup (AI hoặc import tay)", "Trái: mockup · Phải: giá + form", "Nút Deploy"]} />
              <ArrowRight className="mx-auto hidden h-8 w-8 text-muted-foreground md:block" />
              <ArrowDown className="mx-auto h-8 w-8 text-muted-foreground md:hidden" />
              <Box icon={Store} title="Shopify" tone="border-emerald-500/60 bg-emerald-500/5" items={["Trang sản phẩm Cherivia", "Biến thể + giá từ base", "Form personalize từ artwork", "Khách đặt → file in đúng khuôn"]} />
            </div>
            <div className="mt-6 grid gap-3 text-sm sm:grid-cols-3">
              <div className="rounded-lg bg-muted/60 p-3">
                <b>Artwork</b> lo <b>personalize + file in</b>.
              </div>
              <div className="rounded-lg bg-muted/60 p-3">
                <b>Product base</b> lo <b>giá + size / biến thể</b>.
              </div>
              <div className="rounded-lg bg-muted/60 p-3">
                <b>Sản phẩm</b> = ghép 2 cái, thêm <b>mockup</b> rồi deploy.
              </div>
            </div>
            <div className="mt-6">
              <Shot src="fx-products.jpg" caption="Dashboard: 4 tab Sản phẩm · Artwork · Product base · Thư viện" tone="fx" />
            </div>
          </section>

          {/* ---------------------------------------------------------------- 2 */}
          <Section id="so-sanh" title="2. So với Teeinblue — từng màn hình" lead="Bên trái Teeinblue (store Cherivia), bên phải flexi2. Cùng một ý, cách trình bày gọn hơn.">
            <h3 className="text-lg font-semibold">Product base</h3>
            <div className="grid gap-4 md:grid-cols-2">
              <Shot src="tb-base-variants.jpg" caption="Print area + bảng variants (size, giá, giá gạch)" tone="tb" />
              <Shot src="fx-base-detail.jpg" caption="Thông tin, print area, biến thể + giá Notion, khuôn + phôi, mockup gom từ sản phẩm" tone="fx" />
            </div>
            <h3 className="text-lg font-semibold">Artwork</h3>
            <div className="grid gap-4 md:grid-cols-2">
              <Shot src="tb-artwork.jpg" caption="1 canvas 1000×2000: nửa trên silhouette + preview, nửa dưới bản in" tone="tb" />
              <Shot src="fx-editor.jpg" caption="Canvas thiết kế + Layers chia nhóm Preview / Print / Thiết kế" tone="fx" />
            </div>
            <h3 className="text-lg font-semibold">Campaign ↔ Sản phẩm</h3>
            <div className="grid gap-4 md:grid-cols-2">
              <Shot src="tb-campaign.jpg" caption="Chọn base + artwork, trái mockup, phải giá + form" tone="tb" />
              <Shot src="fx-product.jpg" caption="Trái mockup (AI / import), phải trang bán: giá + biến thể + form" tone="fx" />
            </div>
            <div className="overflow-x-auto rounded-xl border">
              <table className="w-full text-sm">
                <thead className="bg-muted text-left">
                  <tr>
                    <th className="p-2">Việc</th>
                    <th className="p-2">Teeinblue</th>
                    <th className="p-2">flexi2</th>
                  </tr>
                </thead>
                <tbody className="[&_td]:border-t [&_td]:p-2 [&_td]:align-top">
                  <tr>
                    <td>Giá, size</td>
                    <td>Bảng variants của Product Base</td>
                    <td>Bảng giá Notion gắn vào Product base</td>
                  </tr>
                  <tr>
                    <td>Preview only / Print only</td>
                    <td>2 nhóm layer có nút xổ</td>
                    <td>3 nhóm có nút xổ: Preview · Print · Thiết kế (dùng chung)</td>
                  </tr>
                  <tr>
                    <td>Silhouette acrylic</td>
                    <td>Khối đen nửa trên file</td>
                    <td>Như vậy (công tắc Silhouette ở File in) + file silhouette full đen</td>
                  </tr>
                  <tr>
                    <td>Mockup</td>
                    <td>Upload / Import, gán theo biến thể</td>
                    <td>AI từ phôi + thiết kế, hoặc Import mockup</td>
                  </tr>
                  <tr>
                    <td>Sửa artwork sau khi bán</td>
                    <td>Phải bấm “Update campaign”</td>
                    <td>Sản phẩm giữ bản cũ, hiện badge “Có bản artwork mới” → bấm cập nhật</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </Section>

          {/* ---------------------------------------------------------------- 3 */}
          <Section
            id="artwork"
            title="3. Artwork: Preview only · Print only"
            lead="Cột Layers của artwork có 3 nhóm, bấm mũi tên để xổ / gập — đúng như 2 nhóm của Teeinblue, cộng 1 nhóm dùng chung."
          >
            <div className="grid gap-4 md:grid-cols-2">
              <LayersMock kind="tb" />
              <LayersMock kind="fx" />
            </div>
            <div className="grid gap-3 md:grid-cols-3">
              <div className="rounded-xl border-l-4 border-sky-500 bg-card p-4 text-sm">
                <div className="mb-1 font-semibold">Preview (preview only)</div>
                Thứ chỉ khách thấy: <b>phôi trơn</b> (luôn có 1 dòng cố định — bấm để upload / đặt thiết kế lên phôi), bóng đổ, chữ mẫu.
                <div className="mt-2 text-xs text-muted-foreground">Không bao giờ vào file in.</div>
              </div>
              <div className="rounded-xl border-l-4 border-orange-500 bg-card p-4 text-sm">
                <div className="mb-1 font-semibold">Print (Order only)</div>
                Thứ chỉ xưởng nhận: <b>khuôn in</b> (đường cắt, lỗ treo), nền mà ảnh option đã có sẵn.
                <div className="mt-2 text-xs text-muted-foreground">Không bao giờ hiện trên preview / mockup.</div>
              </div>
              <div className="rounded-xl border-l-4 border-emerald-500 bg-card p-4 text-sm">
                <div className="mb-1 font-semibold">Thiết kế (preview + file in)</div>
                Mọi layer còn lại: nhân vật, option, chữ khách nhập. <b>Làm 1 lần</b>, dùng cho cả hai.
                <div className="mt-2 text-xs text-muted-foreground">Teeinblue phải làm 2 bản Print + Preview.</div>
              </div>
            </div>
            <div className="rounded-xl bg-muted/60 p-4 text-sm">
              <b>Chuyển layer sang nhóm khác:</b> kéo layer, thả lên <b>tiêu đề nhóm</b> (viền xanh hiện ra). Hoặc chọn layer → ô <b>Nhóm</b> ở cột thuộc tính.
              Nhóm nào thiếu phôi / khuôn thì dòng cố định báo <span className="font-semibold text-amber-600">thiếu</span>.
            </div>
            <div className="grid items-center gap-3 md:grid-cols-[1fr_auto_1fr_auto_1fr]">
              <div className="rounded-xl border p-3 text-center text-sm">
                <div className="mb-2 font-semibold">Preview</div>
                <div className="flex justify-center gap-1 text-xs">
                  <span className="rounded bg-sky-500/15 px-2 py-1">Phôi</span>+<span className="rounded bg-emerald-500/15 px-2 py-1">Thiết kế</span>
                </div>
              </div>
              <span className="hidden text-muted-foreground md:block">·</span>
              <div className="rounded-xl border p-3 text-center text-sm">
                <div className="mb-2 font-semibold">File in</div>
                <div className="flex justify-center gap-1 text-xs">
                  <span className="rounded bg-emerald-500/15 px-2 py-1">Thiết kế</span>✂<span className="rounded bg-orange-500/15 px-2 py-1">Khuôn</span>
                </div>
              </div>
              <span className="hidden text-muted-foreground md:block">·</span>
              <div className="rounded-xl border p-3 text-center text-sm">
                <div className="mb-2 font-semibold">Silhouette</div>
                <div className="mx-auto flex w-24 justify-center rounded-md p-2" style={{ backgroundColor: "#fff", backgroundImage: "repeating-conic-gradient(#0000001a 0% 25%, transparent 0% 50%)", backgroundSize: "10px 10px" }}>
                  <div className="h-8 w-14 rounded-t-full bg-black" />
                </div>
                <div className="mt-1 text-xs text-muted-foreground">khối khuôn full đen</div>
              </div>
            </div>
            <div className="grid gap-4 md:grid-cols-2">
              <Shot src="fx-phoi.jpg" caption="Bấm dòng Phôi trơn: đổi ảnh phôi, kéo khung thiết kế cho khớp phôi" tone="fx" />
              <Shot src="fx-filein.jpg" caption="File in: thiết kế trong khuôn + silhouette full đen, cùng kích thước px" tone="fx" />
            </div>
          </Section>

          {/* ---------------------------------------------------------------- 4 */}
          <Section id="chua-chuan" title="4. Lưu ý: artwork trên Teeinblue hiện chưa nhất quán, chưa chuẩn" lead="Xem lại store Cherivia ngày 2026-11-07. Đừng copy y nguyên cách làm cũ.">
            <div className="grid gap-3 md:grid-cols-2">
              {[
                ["Mỗi loại làm một kiểu", "Acrylic: silhouette nửa trên + bản in nửa dưới. Sứ / kính: 1 mặt in, có cái có “Print guide template” (ẩn), có cái không."],
                ["Thiếu phôi trơn / khuôn in", "Một số artwork không có layer phôi để preview, không có khuôn làm chuẩn → preview và file in dựa vào người làm tự căn."],
                ["Product base lộn xộn", "Base có 5 print area cùng tên “Front”; base gỗ có print area 7500×1500; SKU ceramic 2 mặt còn ghi “CHƯA XÁC NHẬN”; nhiều campaign tên “test”."],
                ["Nhân đôi bằng tay", "Mỗi ảnh / chữ có 1 bản Print + 1 bản Preview (chữ 31px dưới, 28px trên) — sửa bản này dễ quên bản kia."],
              ].map(([t, d]) => (
                <div key={t} className="flex gap-3 rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm">
                  <X className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
                  <div>
                    <div className="font-semibold">{t}</div>
                    <div className="text-muted-foreground">{d}</div>
                  </div>
                </div>
              ))}
            </div>
            <div className="rounded-2xl border-2 border-emerald-500/60 bg-emerald-500/5 p-5">
              <div className="text-lg font-bold">Quy tắc flexi2</div>
              <p className="mt-1 text-sm">
                Artwork chỉ hoàn chỉnh khi có <b>khuôn in</b> và <b>phôi trơn</b> rõ ràng. Có đủ 2 thứ đó, ghép với <b>product base</b> mới ra được <b>file in chuẩn</b> và preview
                đúng. Thiếu → nhóm Preview / Print báo <span className="font-semibold text-amber-600">thiếu</span>, bổ sung trước khi tạo sản phẩm.
              </p>
            </div>
          </Section>

          {/* ---------------------------------------------------------------- 5 */}
          <Section
            id="gop-tach"
            title="5. Teeinblue gộp 1 canvas — flexi2 tách version. Bản chất giống nhau."
            lead="Cùng một sản phẩm “No Place Like Grandma’s — 1 đến 3 cháu”."
          >
            <div className="grid gap-4 md:grid-cols-2">
              <div className="rounded-xl border bg-card p-4">
                <div className="mb-3 flex items-center gap-2 font-semibold">
                  <span className="rounded bg-blue-600 px-1.5 py-0.5 text-[10px] text-white">Teeinblue</span> 1 artwork / 1 canvas
                </div>
                <div className="grid h-48 grid-rows-2 overflow-hidden rounded-lg border text-xs">
                  <div className="flex items-center justify-center bg-neutral-900 text-white">nửa trên: silhouette + preview</div>
                  <div className="flex items-center justify-center bg-muted">nửa dưới: bản in</div>
                </div>
                <ul className="mt-3 space-y-1 text-sm text-muted-foreground">
                  <li>• 689 layer trong 1 danh sách</li>
                  <li>• Da 1 × áo bánh gừng, da 1 × áo cây thông… = mỗi tổ hợp 1 layer có điều kiện</li>
                  <li>• Mọi thứ nhân 2 (Print + Preview)</li>
                </ul>
              </div>
              <div className="rounded-xl border bg-card p-4">
                <div className="mb-3 flex items-center gap-2 font-semibold">
                  <span className="rounded bg-emerald-600 px-1.5 py-0.5 text-[10px] text-white">flexi2</span> 1 artwork / nhiều version
                </div>
                <div className="grid h-48 grid-cols-3 gap-2 text-xs">
                  {["1 cháu", "2 cháu", "3 cháu"].map((v) => (
                    <div key={v} className="flex flex-col overflow-hidden rounded-lg border">
                      <div className="border-b bg-muted px-2 py-1 font-semibold">Version {v}</div>
                      <div className="flex-1 space-y-1 p-2 text-[10px] text-muted-foreground">
                        <div>Chọn — Áo (12)</div>
                        <div>Chọn — Tóc (24)</div>
                        <div>↳ Đầu theo da</div>
                        <div>Chữ — Tên</div>
                      </div>
                    </div>
                  ))}
                </div>
                <ul className="mt-3 space-y-1 text-sm text-muted-foreground">
                  <li>• Bấm version nào thấy đúng version đó</li>
                  <li>• 1 layer chứa mọi option (áo, tóc…); layer “↳” tự đi theo layer khác</li>
                  <li>• Không nhân đôi Print / Preview</li>
                </ul>
              </div>
            </div>
            <div className="flex flex-wrap items-center justify-center gap-2 rounded-xl bg-muted/60 p-4 text-sm">
              Cả hai đều ra cùng 3 thứ:
              <span className="rounded-full bg-background px-3 py-1">form personalize</span>
              <span className="rounded-full bg-background px-3 py-1">preview trên phôi</span>
              <span className="rounded-full bg-background px-3 py-1">file in đúng khuôn</span>
            </div>
          </Section>

          {/* ---------------------------------------------------------------- 6 */}
          <Section id="import" title="6. Bộ import bản chất đã là artwork" lead="Folder Teeinblue / zip đã đủ layer, option, chữ, vị trí — tức là 1 artwork hoàn chỉnh.">
            <div className="grid items-center gap-3 md:grid-cols-[1fr_auto_1fr]">
              <div className="rounded-xl border bg-card p-4 text-center">
                <FileImage className="mx-auto mb-2 h-8 w-8 text-muted-foreground" />
                <div className="font-semibold">Import bộ (folder / zip)</div>
                <div className="text-xs text-muted-foreground">hoặc Tạo bộ clipart mới (vẽ AI)</div>
              </div>
              <ArrowRight className="mx-auto hidden h-8 w-8 text-muted-foreground md:block" />
              <div className="grid gap-3">
                <div className="rounded-xl border-2 border-violet-500/60 bg-violet-500/5 p-3 text-sm">
                  <b>1 Artwork hoàn chỉnh</b> — tab Artwork. Dùng để tạo sản phẩm.
                </div>
                <div className="rounded-xl border p-3 text-sm">
                  <b>Clipart</b> — Thư viện. Để <b>tái sử dụng</b>: kéo vào artwork khác khi thiết kế thủ công (dùng lại nhân vật cho thảm, túi…).
                </div>
              </div>
            </div>
            <p className="text-sm text-muted-foreground">Import xong không tự tạo sản phẩm, không tự lên Shopify. Muốn bán → Tạo sản phẩm (bước 4 dưới).</p>
          </Section>

          {/* ---------------------------------------------------------------- 7 */}
          <Section id="thao-tac" title="7. Thao tác từng bước">
            <Step n={1} title="Kiểm tra Product base" shot="fx-bases.jpg">
              <p>
                Tab <b>Product base</b>: 4 loại theo bảng giá Notion. Bấm 1 base để sửa giá (<b>Sửa bảng giá</b>), khuôn + phôi (<b>Quản lý khuôn</b>, <b>Upload phôi</b>), print area,
                Shopify product type.
              </p>
              <p>Không tạo bảng giá riêng cho từng sản phẩm.</p>
            </Step>
            <Step n={2} title="Có artwork" shot="fx-create-artwork.jpg">
              <p>3 cách:</p>
              <p>
                • <b>Import bộ clipart</b> (tab Artwork) · • <b>Tạo bộ clipart mới</b> (Thư viện) · • <b>Tạo artwork</b> thủ công: chọn 1 product base (canvas = khuôn của loại đó)
                hoặc <b>Canvas trống</b> rồi nhập rộng × cao.
              </p>
            </Step>
            <Step n={3} title="Làm artwork: Thiết kế · Xem trước · File in" shot="fx-editor.jpg">
              <p>
                <b>Thiết kế</b>: kéo bộ clipart từ tab Thư viện bên trái, thêm chữ (T), ảnh khách (U). Cột Layers: 3 nhóm Preview / Print / Thiết kế — đủ <b>phôi trơn</b> và{" "}
                <b>khuôn in</b>.
              </p>
              <p>
                <b>Xem trước</b>: trang bán như khách thấy. <b>File in</b>: thiết kế trong khuôn + silhouette full đen; <b>Tải gói file in</b> (zip) cho xưởng.
              </p>
              <p>
                <b>Lưu artwork</b> (⌘S).
              </p>
            </Step>
            <Step n={4} title="Tạo sản phẩm = artwork + product base" shot="fx-create-product.jpg">
              <p>
                Tab <b>Sản phẩm</b> → <b>Tạo sản phẩm</b>: chọn artwork, chọn product base, đặt tên theo chủ đề. Hoặc trên thẻ artwork bấm nút túi xách.
              </p>
            </Step>
            <Step n={5} title="Mockup + kiểm tra trang bán" shot="fx-product.jpg">
              <p>
                Trái: <b>Tạo mockup</b> bằng AI (mỗi dòng 1 bối cảnh) hoặc <b>Import mockup</b> ảnh có sẵn. Phải: giá + size + pack của base, form personalize — thử chọn như khách.
              </p>
            </Step>
            <Step n={6} title="Deploy">
              <p>
                Nút <b>Deploy</b> trên trang sản phẩm: tiêu đề, mô tả, ảnh, collection. Giá tự lấy theo product base. Artwork không deploy được — phải tạo sản phẩm trước.
              </p>
            </Step>
            <Step n={7} title="Sửa artwork khi đã bán">
              <p>
                Sửa + lưu artwork → sản phẩm giữ thiết kế cũ, hiện <b>Có bản artwork mới</b>. Bấm <b>Cập nhật</b> trên trang sản phẩm (hoặc chọn nhiều trong editor artwork → <b>Sản phẩm từ
                artwork</b>), rồi Deploy lại.
              </p>
            </Step>
          </Section>

          {/* ---------------------------------------------------------------- 8 */}
          <Section id="file-in" title="8. File in theo từng loại sản phẩm">
            <div className="grid gap-4 md:grid-cols-3">
              {[
                { icon: Printer, t: "Áo · quần · túi · thảm", d: "In phẳng: file thiết kế đúng khổ. Preview = thiết kế đặt trên phôi.", s: "Silhouette: không cần" },
                { icon: Scissors, t: "Acrylic ornament", d: "Cắt theo viền hình (alpha) + lỗ treo.", s: "Silhouette: BẬT — khối full đen nửa trên, bản in nửa dưới" },
                { icon: ImageIcon, t: "Ornament sứ / kính tròn", d: "Cắt theo khuôn tròn (xưởng đưa hoặc khuôn của ta), chừa lỗ treo.", s: "Gói file in luôn có silhouette khuôn" },
              ].map(({ icon: Icon, t, d, s }) => (
                <div key={t} className="rounded-xl border bg-card p-4">
                  <Icon className="mb-2 h-6 w-6 text-muted-foreground" />
                  <div className="font-semibold">{t}</div>
                  <p className="mt-1 text-sm text-muted-foreground">{d}</p>
                  <p className="mt-2 text-xs font-medium">{s}</p>
                </div>
              ))}
            </div>
            <div className="rounded-xl border p-4 text-sm">
              <div className="mb-2 font-semibold">Gói file in (zip) gồm</div>
              <div className="flex flex-wrap gap-2 text-xs">
                {["print.png", "thiet-ke-tren-khuon.png", "silhouette-khuon.png (full đen)", "cut.svg (khuôn vector)", "print-khong-silhouette.png (khi bật silhouette)"].map((f) => (
                  <code key={f} className="rounded bg-muted px-2 py-1">
                    {f}
                  </code>
                ))}
              </div>
            </div>
            <div className="rounded-xl bg-amber-500/10 p-4 text-sm">
              <b>Còn thiếu:</b> khuôn Glass Heart, Ceramic Heart / Star; khuôn + phôi Poseable Doll; Ceramic 2 mặt — mặt sau đang in cùng artwork mặt trước.
            </div>
          </Section>
        </main>
      </div>
    </div>
  );
}
