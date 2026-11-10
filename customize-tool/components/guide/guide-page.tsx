/* eslint-disable @next/next/no-img-element -- static screenshots from /public/huong-dan */
/**
 * /huong-dan — the team's guide to Product base · Artwork · Sản phẩm. Pictures first (asked 2026-11-07: "hướng dẫn là
 * 1 route … cho dễ hình dung chứ ghi text không hiểu được"). Rewritten again 2026-11-08 (asked: not a list of what is
 * good / bad on Cherivia — only that Cherivia's way is off Teeinblue's own recommended flow: the artwork follows the
 * base's print area, the base holds khuôn, phôi, print area and the fulfilment settings, the artwork is the finished
 * design laid on a base and reused; with phôi / preview / khuôn inside the artwork it cannot be reused. Plus a
 * Teeinblue ↔ flexi2 table with screenshots of each part). Screenshots live in public/huong-dan/.
 */

import Link from "next/link";
import { ArrowDown, ArrowRight, BookOpen, Check, ChevronDown, FileImage, Image as ImageIcon, Layers, Printer, Scissors, ShoppingBag, Store, Tag } from "lucide-react";

const IMG = "/huong-dan";

const TOC: Array<[string, string]> = [
  ["tom-tat", "1. Tóm tắt"],
  ["de-xuat-tb", "2. Flow Teeinblue đề xuất"],
  ["lech", "3. Cherivia đang lệch ở đâu"],
  ["de-xuat", "4. Đề xuất cho flexi2"],
  ["tuong-duong", "5. Teeinblue ↔ flexi2"],
  ["thao-tac", "6. Thao tác từng bước"],
  ["bo-moi", "7. Bộ mới · Import · MCP"],
  ["layers", "8. Layers Preview / Print"],
  ["file-in", "9. File in từng loại"],
];

function Section({ id, title, lead, children }: { id: string; title: string; lead?: React.ReactNode; children: React.ReactNode }) {
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
          <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold ${tone === "tb" ? "bg-blue-600 text-white" : "bg-emerald-600 text-white"}`}>{tone === "tb" ? "Teeinblue" : "flexi2"}</span>
        )}
        <span className="text-muted-foreground">{caption}</span>
      </div>
      <a href={`${IMG}/${src}`} target="_blank" rel="noreferrer" title="Mở ảnh lớn">
        <img src={`${IMG}/${src}`} alt={caption} className="w-full" loading="lazy" />
      </a>
    </figure>
  );
}

function Box({ icon: Icon, title, sub, tone, items }: { icon: typeof Tag; title: string; sub?: string; tone: string; items: string[] }) {
  return (
    <div className={`rounded-2xl border-2 p-4 ${tone}`}>
      <div className="flex items-center gap-2 text-lg font-bold">
        <Icon className="h-5 w-5" /> {title}
      </div>
      {sub && <div className="mb-2 text-xs font-medium opacity-70">{sub}</div>}
      <ul className="mt-2 space-y-1 text-sm">
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

/** One place where Cherivia's way is off Teeinblue's flow: what they do, what the flow says, and its picture. */
function Gap({ n, title, now, flow, shot, caption }: { n: number; title: string; now: React.ReactNode; flow: React.ReactNode; shot?: string; caption?: string }) {
  return (
    <div className="grid gap-4 rounded-2xl border bg-card p-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
      <div className="space-y-3 text-sm">
        <div className="flex items-center gap-2 text-base font-semibold">
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-amber-500 text-xs font-bold text-white">{n}</span>
          {title}
        </div>
        <div className="rounded-lg border-l-4 border-amber-500 bg-amber-500/5 p-3">
          <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-400">Cherivia đang làm</div>
          {now}
        </div>
        <div className="rounded-lg border-l-4 border-blue-600 bg-blue-600/5 p-3">
          <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-blue-700 dark:text-blue-400">Flow Teeinblue đề xuất</div>
          {flow}
        </div>
      </div>
      {shot && <Shot src={shot} caption={caption ?? title} tone="tb" />}
    </div>
  );
}

/** A small clickable screenshot in the Teeinblue ↔ flexi2 table. */
function Thumb({ src, alt }: { src: string; alt: string }) {
  return (
    <a href={`${IMG}/${src}`} target="_blank" rel="noreferrer" title="Mở ảnh lớn" className="mt-2 block overflow-hidden rounded-lg border bg-muted/40 hover:border-foreground/40">
      <img src={`${IMG}/${src}`} alt={alt} className="aspect-[16/10] w-full object-cover object-top" loading="lazy" />
    </a>
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

/** Cherivia's acrylic artwork drawn as a diagram: one 1000×2000 canvas, what each half holds. */
function TbCanvasDiagram() {
  return (
    <div className="grid gap-4 md:grid-cols-[220px_minmax(0,1fr)]">
      <div className="mx-auto w-48 overflow-hidden rounded-lg border-2 text-[11px]">
        <div className="flex h-44 flex-col items-center justify-center gap-1 bg-neutral-900 p-2 text-center text-white">
          <div className="h-10 w-24 rounded-t-full bg-black ring-1 ring-white/30" />
          <b>0 → 1000</b> Print: silhouette đen
          <span className="opacity-70">(1 ảnh cho mỗi số người)</span>
        </div>
        <div className="flex h-44 flex-col items-center justify-center gap-1 bg-gradient-to-b from-emerald-900 to-amber-900 p-2 text-center text-white">
          <b>1000 → 2000</b>
          <span>Print: thiết kế (bản in)</span>
          <span className="rounded bg-sky-500/80 px-1">+ Preview: ảnh cảnh + bản sao</span>
        </div>
      </div>
      <div className="space-y-2 text-sm">
        <p>
          <b>Product base</b> “Gingerbread Train Family Acrylic Ornament” có 1 print area <code className="rounded bg-muted px-1">Front 1000×2000</code> → mọi artwork acrylic của Cherivia
          đều cao 1000×2000 để khớp file của Merchize.
        </p>
        <ul className="space-y-1 text-muted-foreground">
          <li>
            • <b className="text-foreground">Nhóm Print (Order only)</b>: nửa trên là <b className="text-foreground">silhouette đen</b> (mỗi số người 1 ảnh “Silhouette 2…9”), nửa dưới là bản in
            (khung tàu, nhân vật, chữ).
          </li>
          <li>
            • <b className="text-foreground">Nhóm Preview (preview only)</b>: “Preview scene 2…9” — <b className="text-foreground">mỗi version 1 ảnh</b> khung tàu trống đã có viền acrylic, treo trên
            cây thông — rồi <b className="text-foreground">bản sao</b> của mọi nhân vật / chữ đặt lên.
          </li>
          <li>• Khách chỉ thấy nhóm Preview. Xưởng chỉ nhận nhóm Print.</li>
        </ul>
        <div className="grid grid-cols-2 gap-2 text-center text-xs">
          <div className="rounded-lg bg-muted/60 p-2">
            Gingerbread Train <b className="block text-lg text-foreground">892 layer</b> 424 Print + 466 Preview
          </div>
          <div className="rounded-lg bg-muted/60 p-2">
            State Map <b className="block text-lg text-foreground">324 layer</b> 147 Print + 175 Preview
          </div>
        </div>
      </div>
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
  const row = (label: string, note?: string) => (
    <div className="flex items-center gap-2 py-1 pl-6 pr-2 text-xs">
      <span className="h-4 w-4 shrink-0 rounded border bg-muted" />
      <span className="flex-1 truncate">{label}</span>
      {note && <span className="text-[10px] text-muted-foreground">{note}</span>}
    </div>
  );
  if (kind === "tb")
    return (
      <div className="overflow-hidden rounded-xl border bg-card">
        <div className="border-b px-3 py-2 text-sm font-semibold">Layers · Teeinblue (Gingerbread Train)</div>
        {head("Preview (preview only)", "bg-sky-500", 466)}
        {row("Preview scene 2 … 9", "8 ảnh phôi vẽ tay")}
        {row("2p Person 1 … 9p Person 9", "bản sao nhân vật")}
        {row("Sign text / Name … (×404)", "bản sao chữ")}
        {head("Print (Order only)", "bg-orange-500", 424)}
        {row("Silhouette 2 … 9", "đen, nửa trên")}
        {row("Print 2p Person 1 …", "nhân vật bản in")}
        {row("Name … (×356)", "chữ bản in")}
        <p className="border-t px-3 py-2 text-[11px] text-muted-foreground">Mọi nhân vật, mọi chữ có 2 bản. Sửa 1 bản phải nhớ sửa bản kia.</p>
      </div>
    );
  return (
    <div className="overflow-hidden rounded-xl border bg-card">
      <div className="border-b px-3 py-2 text-sm font-semibold">Layers · flexi2</div>
      {head("Preview (preview only)", "bg-sky-500", 1)}
      {row("Phôi trơn · từ base Acrylic Ornament 1 side", "bấm → mở base")}
      {head("Print (Order only)", "bg-orange-500", 1)}
      {row("Khuôn in · cắt theo viền + 2.5 mm · từ base", "bấm → mở base")}
      {head("Thiết kế (preview + file in)", "bg-emerald-500", 6)}
      {row("Chọn — Nhân vật 1 (8 option)")}
      {row("Chữ — Name of member 1")}
      {row("Chữ — Sign text")}
      {row("Khung tàu")}
      <p className="border-t px-3 py-2 text-[11px] text-muted-foreground">Mỗi layer 1 lần, dùng cho cả preview lẫn file in. Phôi + khuôn không nằm trong artwork — lấy từ base.</p>
    </div>
  );
}

/** One row of the Teeinblue ↔ flexi2 table: the same part on both, with a screenshot each. */
interface CtGuideMatch {
  part: string;
  tb: string;
  tbShot?: string;
  fx: string;
  fxShot?: string;
}

const MATCHES: CtGuideMatch[] = [
  { part: "Sản phẩm trơn", tb: "Product base → Edit product: tên, Fulfillment provider (Merchize), catalog ID, mô tả, ảnh mockup", tbShot: "tb-base.jpg", fx: "Tab Product base → 1 base: tên = loại sản phẩm, chất liệu, product type, ghi chú xưởng", fxShot: "fx-bases.jpg" },
  { part: "Print area", tb: "Printareas: Front 1000 × 2000 px, 300 DPI — khổ file gửi xưởng", tbShot: "tb-base-variants.jpg", fx: "Base → Print area (px, dpi). Artwork tạo cho base nào thì canvas = print area của base đó", fxShot: "fx-base-detail.jpg" },
  { part: "Biến thể + giá", tb: "Variants: SKU, size 4in / 4.5in / 5.5in, giá, compare at", tbShot: "tb-base-variants.jpg", fx: "Base → bảng giá Notion (size × pack). Sản phẩm + deploy lấy giá từ base", fxShot: "fx-base-detail.jpg" },
  { part: "Khuôn / cách cắt", tb: "Không có ở base — silhouette đen vẽ trong artwork (nửa trên tờ 1000 × 2000)", tbShot: "tb-cherivia-artwork.jpg", fx: "Base → Cắt + file in: khuôn cố định / cắt theo viền + mm / in phẳng, silhouette, tai treo", fxShot: "fx-base-cut.jpg" },
  { part: "Phôi / cảnh preview", tb: "“Preview scene 2…9” — mỗi version 1 ảnh, là layer trong artwork", tbShot: "tb-cherivia-scenes.jpg", fx: "Base → Phôi / nền xem trước. Acrylic: phôi theo version (AI vẽ, hoặc lấy từ folder import nếu có sẵn)", fxShot: "fx-phoi-ai.jpg" },
  { part: "Artwork editor", tb: "Artwork: 1 canvas = print area, cây layer, form personalize bên phải", tbShot: "tb-artwork.jpg", fx: "Artwork: Thiết kế · Xem trước · File in; ô “Xem trên base” lấy khuôn + vùng an toàn của base", fxShot: "fx-editor.jpg" },
  { part: "Preview only / Print only", tb: "2 nhóm layer: Preview (preview only) · Print (Order only), mọi thứ 2 bản", tbShot: "tb-cherivia-artwork.jpg", fx: "3 nhóm: Preview · Print · Thiết kế (dùng chung). Phôi + khuôn là 2 dòng lấy từ base", fxShot: "fx-artwork-on-base.jpg" },
  { part: "Ghép artwork vào sản phẩm", tb: "Campaign bước 1: chọn product base, gán 1 artwork cho mỗi print area, Locate artwork", tbShot: "tb-cherivia-campaign.jpg", fx: "Tab Sản phẩm → Tạo sản phẩm: chọn artwork + base. Base có khuôn: “Vị trí artwork trong khuôn”", fxShot: "fx-create-product.jpg" },
  { part: "Mockup", tb: "Assign mockups: chọn ảnh mockup của base cho từng biến thể", tbShot: "tb-assign.jpg", fx: "Trang sản phẩm (trái): Tạo mockup AI hoặc Import mockup", fxShot: "fx-product.jpg" },
  { part: "Xem như khách", tb: "Campaign bước 2 / Live preview: giá, form, ảnh trên phôi", tbShot: "tb-campaign.jpg", fx: "Trang sản phẩm (phải): giá của base + form + preview trên phôi", fxShot: "fx-product-locate.jpg" },
  { part: "File gửi xưởng", tb: "Generate test design / lúc có đơn: nhóm Print xuất ra 1 file", tbShot: "tb-cherivia-live.jpg", fx: "Tab File in: thiết kế + khuôn / silhouette của base, tải gói zip; đơn hàng tự gửi file", fxShot: "fx-filein-stack.jpg" },
  { part: "Lên Shopify", tb: "Campaign → Update / Push to Shopify", tbShot: "tb-campaign.jpg", fx: "Nút Deploy trên trang sản phẩm (artwork không deploy được)", fxShot: "fx-products.jpg" },
];

const OWNERS: Array<[string, string, string, string]> = [
  ["Print area (px, dpi) = khổ canvas artwork", "✔ giữ", "canvas lấy theo base", ""],
  ["Khuôn in hình cố định (tròn, vuông)", "✔ giữ", "chỉ hiện để căn", "vị trí artwork trong khuôn"],
  ["Cắt theo viền thiết kế (acrylic) + viền mm", "✔ luật cắt", "silhouette tự sinh mỗi version", ""],
  ["Silhouette trong file in (kiểu Merchize)", "✔ luôn có", "", ""],
  ["Phôi trơn / ảnh nền xem trước", "✔ giữ", "", ""],
  ["Thông số fulfillment (xưởng, SKU, ghi chú)", "✔ giữ", "", ""],
  ["Biến thể + giá (bảng Notion)", "✔ giữ", "", ""],
  ["Layer, option, version, chữ", "", "✔ giữ", "bản chụp của artwork"],
  ["Phôi theo version (acrylic)", "nền", "✔ theo từng base", "tự nhận"],
  ["Tên theo chủ đề, mockup, Shopify", "", "", "✔ giữ"],
];

export function GuidePage() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="sticky top-0 z-20 border-b bg-card/90 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-3 px-4">
          <Link href="/dashboard" className="text-sm text-muted-foreground hover:text-foreground">
            ← Dashboard
          </Link>
          <h1 className="truncate font-semibold">Hướng dẫn: Product base · Artwork · Sản phẩm</h1>
          <span className="ml-auto hidden text-xs text-muted-foreground sm:inline">cập nhật 2026-11-08</span>
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
          <section id="tom-tat" className="scroll-mt-20">
            <h2 className="text-3xl font-bold tracking-tight">Artwork theo print area của base, base giữ phần vật lý</h2>
            <p className="mt-2 max-w-3xl text-muted-foreground">
              Teeinblue đề xuất: <b className="text-foreground">product base</b> giữ print area, khuôn / phôi và thông số gửi xưởng; <b className="text-foreground">artwork</b> làm đúng khổ print area, chỉ là
              bản thiết kế hoàn chỉnh đặt lên base, nên <b className="text-foreground">dùng lại được</b>. Cherivia đang để phôi, preview, khuôn (silhouette) nằm trong artwork — vì vậy artwork không dùng lại được.
              flexi2 làm theo đúng flow Teeinblue đề xuất.
            </p>
            <div className="mt-6 grid items-center gap-3 md:grid-cols-[1fr_auto_1fr_auto_1fr]">
              <div className="space-y-3">
                <Box icon={Tag} title="Product base" sub="sản phẩm trơn" tone="border-amber-500/60 bg-amber-500/5" items={["Print area (khổ file)", "Khuôn in / cách cắt / silhouette", "Phôi trơn hoặc nền preview", "Biến thể + giá, thông số xưởng"]} />
                <Box icon={Layers} title="Artwork" sub="chỉ thiết kế" tone="border-violet-500/60 bg-violet-500/5" items={["Canvas = print area của base", "Layer, option, version, chữ", "Không chứa khuôn, phôi", "Đặt lên base nào cũng được"]} />
              </div>
              <ArrowRight className="mx-auto hidden h-8 w-8 text-muted-foreground md:block" />
              <ArrowDown className="mx-auto h-8 w-8 text-muted-foreground md:hidden" />
              <Box icon={ShoppingBag} title="Sản phẩm" sub="= artwork đặt lên base (Campaign)" tone="border-sky-500/60 bg-sky-500/5" items={["Khuôn + phôi của base ghép vào", "Vị trí artwork trong khuôn", "Tên theo chủ đề, mockup", "Nút Deploy"]} />
              <ArrowRight className="mx-auto hidden h-8 w-8 text-muted-foreground md:block" />
              <ArrowDown className="mx-auto h-8 w-8 text-muted-foreground md:hidden" />
              <Box icon={Store} title="Shopify" tone="border-emerald-500/60 bg-emerald-500/5" items={["Giá + biến thể từ base", "Form personalize từ artwork", "Preview trên phôi của base", "File in đúng khuôn của base"]} />
            </div>
          </section>

          {/* ---------------------------------------------------------------- 2 */}
          <Section id="de-xuat-tb" title="2. Flow Teeinblue đề xuất" lead="Theo tài liệu của chính Teeinblue: thông số vật lý thuộc product base, artwork làm theo khổ của nó.">
            <div className="grid gap-3 md:grid-cols-3">
              {[
                ["Product base", "Sản phẩm trơn: fulfiller, print area (tên + px + dpi), biến thể, mockup. Print area quyết định khổ file gửi xưởng và vị trí thiết kế trên mockup."],
                ["Artwork", "Đặt kích thước artwork bằng print area. Artwork là thiết kế + form personalize, không gắn với 1 loại sản phẩm."],
                ["Campaign", "= product base + 1 artwork cho mỗi print area. Artwork lệch khổ thì dùng “Locate artwork” để đặt lại, không sửa artwork."],
              ].map(([t, d]) => (
                <div key={t} className="rounded-xl border-t-4 border-blue-600 bg-card p-4 text-sm">
                  <div className="mb-1 font-semibold">{t}</div>
                  <div className="text-muted-foreground">{d}</div>
                </div>
              ))}
            </div>
            <div className="grid gap-4 md:grid-cols-2">
              <Shot src="tb-base-variants.jpg" caption="Product base: Printareas (Front 1000×2000, 300 DPI) + Variants — phần vật lý nằm ở đây" tone="tb" />
              <Shot src="tb-cherivia-campaign.jpg" caption="Campaign: chọn base, gán artwork cho print area Front, Edit artwork / Locate artwork" tone="tb" />
            </div>
            <a href="https://support.teeinblue.com/en/article/1lf9m49/" target="_blank" rel="noreferrer" className="flex items-center gap-2 rounded-xl border bg-card p-3 text-sm hover:border-foreground/30">
              <BookOpen className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span>
                Teeinblue: “Print area của Product base quyết định khổ file gửi xưởng và cách artwork hiện trên mockup — nên đặt kích thước artwork = print area; lệch thì dùng Locate artwork.”
              </span>
            </a>
          </Section>

          {/* ---------------------------------------------------------------- 3 */}
          <Section id="lech" title="3. Cherivia đang lệch flow đó ở đâu" lead="Chụp 2026-11-08 từ 2 campaign acrylic của Cherivia (Gingerbread Train Family, Miles Don't Matter State Map).">
            <TbCanvasDiagram />
            <Gap
              n={1}
              title="Khuôn (silhouette) vẽ trong artwork"
              now={<>Nửa trên artwork 1000×2000 là “Silhouette 2…9” đen — hình cắt của xưởng Merchize — vẽ thành layer của artwork.</>}
              flow={<>Cách cắt + định dạng file là của sản phẩm trơn (product base). Artwork chỉ có thiết kế.</>}
              shot="tb-cherivia-artwork.jpg"
              caption="Artwork Gingerbread Train: nửa trên silhouette đen, nửa dưới cảnh preview — tất cả trong 1 artwork"
            />
            <Gap
              n={2}
              title="Phôi / preview nằm trong artwork"
              now={<>Mỗi version 1 ảnh “Preview scene” (acrylic trống treo cây thông) là layer preview-only của artwork, rồi bản sao nhân vật / chữ đặt lên.</>}
              flow={<>Phôi + mockup thuộc product base; artwork đặt lên base nào thì hiện trên phôi của base đó.</>}
              shot="tb-cherivia-scenes.jpg"
              caption="3 trong số các Preview scene: tàu 2 người, tàu 9 người, vòng State Map — ảnh riêng trong từng artwork"
            />
            <Gap
              n={3}
              title="Base đặt theo thiết kế, không theo loại sản phẩm"
              now={<>Base “Gingerbread Train Family Acrylic Ornament” đang dùng cho cả campaign State Map.</>}
              flow={<>Base = 1 loại sản phẩm trơn (Acrylic Ornament 1 mặt), dùng cho mọi thiết kế cùng loại.</>}
              shot="tb-base.jpg"
              caption="Product base mang tên thiết kế Gingerbread Train"
            />
            <div className="rounded-2xl border-2 border-amber-500/50 bg-amber-500/5 p-4 text-sm">
              <div className="mb-1 font-semibold">Hệ quả: artwork không dùng lại được</div>
              Vì khuôn + phôi nằm trong artwork, artwork tàu chỉ chạy đúng trên acrylic Merchize. Muốn bán cùng thiết kế trên sứ / kính / áo phải làm artwork khác — chỉ 2 / 75 artwork của Cherivia nằm ở
              hơn 1 campaign.
            </div>
          </Section>

          {/* ---------------------------------------------------------------- 4 */}
          <Section id="de-xuat" title="4. Đề xuất cho flexi2 (đã làm)" lead="Đúng flow Teeinblue đề xuất: base giữ phần vật lý + thông số xưởng, artwork là bản thiết kế hoàn chỉnh theo print area của base, dùng lại cho nhiều base.">
            <div className="overflow-x-auto rounded-xl border">
              <table className="w-full text-sm">
                <thead className="bg-muted text-left">
                  <tr>
                    <th className="p-2">Thứ</th>
                    <th className="p-2 text-amber-600">Product base</th>
                    <th className="p-2 text-violet-600">Artwork</th>
                    <th className="p-2 text-sky-600">Sản phẩm</th>
                  </tr>
                </thead>
                <tbody className="[&_td]:border-t [&_td]:p-2 [&_td]:align-top">
                  {OWNERS.map(([what, base, art, prod]) => (
                    <tr key={what}>
                      <td className="font-medium">{what}</td>
                      <td>{base}</td>
                      <td className="text-muted-foreground">{art}</td>
                      <td className="text-muted-foreground">{prod}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="grid gap-4 md:grid-cols-2">
              <Shot src="fx-base-cut.jpg" caption="Product base: Cắt + file in, Phôi / nền xem trước — sửa 1 chỗ, mọi artwork xem trên base và mọi sản phẩm của base theo" tone="fx" />
              <Shot src="fx-artwork-on-base.jpg" caption="Artwork xem trên base Acrylic: khuôn, vùng an toàn, phôi đều lấy từ base, không lưu vào artwork" tone="fx" />
            </div>
            <div className="rounded-2xl border-2 border-sky-500/50 bg-sky-500/5 p-4">
              <div className="mb-3 font-semibold">1 artwork — đổi base là ra loại sản phẩm khác (không sửa thiết kế)</div>
              <Shot src="fx-same-artwork.jpg" caption="Cùng artwork tàu Gingerbread: trên base Acrylic · Ceramic tròn (cắt theo khuôn, phôi sứ) · Poseable Doll (in phẳng)" tone="fx" />
            </div>
            <div className="grid gap-3 text-sm md:grid-cols-3">
              <div className="rounded-xl border bg-card p-4">
                <div className="mb-1 font-semibold">Phôi theo version: không ai vẽ tay</div>
                Acrylic: AI vẽ phần cố định của từng version thành tấm acrylic thật trên nền của base. Bộ import có sẵn preview thì lấy luôn, không vẽ lại.
              </div>
              <div className="rounded-xl border bg-card p-4">
                <div className="mb-1 font-semibold">File in không có vật liệu</div>
                Phôi chỉ để khách xem. File gửi xưởng = thiết kế gốc + khuôn / silhouette của base.
              </div>
              <div className="rounded-xl border bg-card p-4">
                <div className="mb-1 font-semibold">Preview luôn khớp file in</div>
                Không có bản sao Preview / Print: cùng 1 layer ra cả hai.
              </div>
            </div>
          </Section>

          {/* ---------------------------------------------------------------- 5 */}
          <Section id="tuong-duong" title="5. Bảng tương đương Teeinblue ↔ flexi2" lead="Cùng một phần, mỗi bên nằm ở đâu. Bấm ảnh để xem lớn.">
            <div className="hidden grid-cols-[150px_minmax(0,1fr)_minmax(0,1fr)] gap-3 px-1 text-xs font-semibold text-muted-foreground md:grid">
              <span>Phần</span>
              <span className="text-blue-600">Teeinblue</span>
              <span className="text-emerald-600">flexi2</span>
            </div>
            <div className="space-y-3">
              {MATCHES.map((m) => (
                <div key={m.part} className="grid gap-3 rounded-xl border bg-card p-3 md:grid-cols-[150px_minmax(0,1fr)_minmax(0,1fr)]">
                  <div className="font-semibold">{m.part}</div>
                  <div className="text-sm">
                    <span className="mr-1 rounded bg-blue-600 px-1.5 py-0.5 text-[10px] font-semibold text-white md:hidden">Teeinblue</span>
                    {m.tb}
                    {m.tbShot && <Thumb src={m.tbShot} alt={`Teeinblue — ${m.part}`} />}
                  </div>
                  <div className="text-sm">
                    <span className="mr-1 rounded bg-emerald-600 px-1.5 py-0.5 text-[10px] font-semibold text-white md:hidden">flexi2</span>
                    {m.fx}
                    {m.fxShot && <Thumb src={m.fxShot} alt={`flexi2 — ${m.part}`} />}
                  </div>
                </div>
              ))}
            </div>
          </Section>

          {/* ---------------------------------------------------------------- 6 */}
          <Section id="thao-tac" title="6. Thao tác từng bước">
            <Step n={1} title="Kiểm tra Product base" shot="fx-base-cut.jpg">
              <p>
                Tab <b>Product base</b> → bấm 1 base. Kiểm tra <b>Biến thể + giá</b>, <b>Print area</b>, <b>Khuôn in + phôi</b>, rồi:
              </p>
              <p>
                • <b>Cắt + file in</b>: theo khuôn in (nét liền = cắt, nét đứt = vùng an toàn) / cắt theo viền thiết kế (+ mm) / in phẳng; file in luôn có <b>silhouette</b>, tai treo.
                <br />• <b>Phôi / nền xem trước</b>: ảnh phôi trơn (sứ, kính) hoặc ảnh nền (acrylic). Kéo 3 thanh để đặt khung thiết kế lên ảnh.
              </p>
              <p>
                Bấm <b>Lưu</b> — mọi sản phẩm trên base tự cập nhật.
              </p>
            </Step>
            <Step n={2} title="Có artwork" shot="fx-create-artwork.jpg">
              <p>
                • <b>Import bộ</b> (tab Artwork): tự gắn base theo vật liệu. · • <b>Tạo artwork</b> từ 1 base: canvas trống đúng <b>print area</b> của base. · • <b>Bộ clipart mới</b> (vẽ AI):
                chọn base trong brief, canvas = print area của base.
              </p>
            </Step>
            <Step n={3} title="Làm artwork + chọn “Xem trên base”" shot="fx-safe-ok.jpg">
              <p>
                <b>Thiết kế</b>: kéo clipart, thêm chữ, ảnh khách. Ô <b>Xem trên base</b>: đường khuôn + vùng an toàn của base hiện trên canvas. Cảnh báo <b>ngoài vùng an toàn</b> xét theo pixel thật của
                clipart, không theo khung — clipart khung to bằng canvas nhưng hình nằm trong vùng an toàn thì không báo.
              </p>
              <p>
                Base acrylic: Layers → nhóm Preview → <b>Phôi AI theo version</b> → <b>Vẽ N version chưa có</b> (~2 phút, các version vẽ cùng lúc). Bộ import đã có preview thì phôi có sẵn.
              </p>
            </Step>
            <Step n={4} title="Tạo sản phẩm = artwork + product base" shot="fx-create-product.jpg">
              <p>
                Tab <b>Sản phẩm</b> → <b>Tạo sản phẩm</b>: chọn artwork, chọn base, đặt tên theo chủ đề. 1 artwork làm được nhiều sản phẩm trên nhiều base.
              </p>
            </Step>
            <Step n={5} title="Mockup" shot="fx-product-locate.jpg">
              <p>
                Sản phẩm không chỉnh gì: artwork đặt đúng vào khuôn của base. Trái: <b>Tạo mockup</b> AI hoặc <b>Import mockup</b>. Phải: giá + form như khách thấy.
              </p>
            </Step>
            <Step n={6} title="Deploy">
              <p>
                Nút <b>Deploy</b> trên trang sản phẩm. Giá, biến thể, product type lấy theo base. Artwork không deploy được.
              </p>
            </Step>
            <Step n={7} title="Sửa sau khi bán">
              <p>
                Sửa <b>artwork</b> → sản phẩm hiện <b>Có bản artwork mới</b>, bấm Cập nhật rồi Deploy lại. Sửa <b>base</b> (khuôn, phôi, cắt) → Lưu là sản phẩm cập nhật luôn.
              </p>
            </Step>
          </Section>

          {/* ---------------------------------------------------------------- 7 */}
          <Section id="bo-moi" title="7. Bộ clipart mới · Import bộ · MCP" lead="Cả 3 đường đều ra 1 artwork gắn base — không còn khuôn hay phôi nằm trong artwork.">
            <div className="grid items-center gap-3 md:grid-cols-[1fr_auto_1fr_auto_1fr]">
              <div className="space-y-2">
                {["Bộ clipart mới (vẽ AI) — brief chọn base", "Import bộ (folder / zip) — base theo vật liệu", "@flexiprint qua MCP"].map((t) => (
                  <div key={t} className="rounded-xl border bg-card p-3 text-sm">
                    <FileImage className="mr-1 inline h-4 w-4 text-muted-foreground" /> {t}
                  </div>
                ))}
              </div>
              <ArrowRight className="mx-auto hidden h-8 w-8 text-muted-foreground md:block" />
              <ArrowDown className="mx-auto h-8 w-8 text-muted-foreground md:hidden" />
              <div className="rounded-xl border-2 border-violet-500/60 bg-violet-500/5 p-4 text-sm">
                <b>1 Artwork</b> — canvas = print area của base, xem trên base, clipart vào Thư viện để tái sử dụng.
              </div>
              <ArrowRight className="mx-auto hidden h-8 w-8 text-muted-foreground md:block" />
              <ArrowDown className="mx-auto h-8 w-8 text-muted-foreground md:hidden" />
              <div className="rounded-xl border-2 border-sky-500/60 bg-sky-500/5 p-4 text-sm">
                <b>Sản phẩm</b> — tạo từ artwork + base, mockup, deploy.
              </div>
            </div>
            <div className="rounded-2xl border bg-card p-4 text-sm">
              <div className="mb-2 font-semibold">Phôi preview của bộ import: có sẵn thì dùng, chưa có mới vẽ AI</div>
              <div className="grid gap-3 md:grid-cols-3">
                <div className="rounded-lg bg-emerald-500/10 p-3">
                  <b>Folder có ảnh phôi từng version</b> (“Preview scene N”, “phoi-preview-c2”) → dùng nguyên ảnh làm phôi của version đó.
                </div>
                <div className="rounded-lg bg-emerald-500/10 p-3">
                  <b>Folder có ảnh nền preview</b> (“nen-preview”) → phần cố định của từng version in lên nền, vị trí lấy từ bảng vị trí (bang-vi-tri-*.csv) — giống hệt preview của folder.
                </div>
                <div className="rounded-lg bg-sky-500/10 p-3">
                  <b>Folder không có preview</b> → base cắt theo viền (acrylic): AI vẽ phôi cho mọi version ngay sau khi dựng. Base có khuôn (sứ, kính): dùng phôi của khuôn.
                </div>
              </div>
              <p className="mt-3 text-xs text-muted-foreground">Trang Import hiện 1 dòng “Phôi preview: …” cho biết đã lấy từ đâu.</p>
            </div>
            <div className="grid gap-4 md:grid-cols-2">
              <Shot src="fx-phoi-ai.jpg" caption="Phôi theo version của artwork tàu trên base Acrylic: 8 version, chỗ nhân vật để trống cho khách chọn" tone="fx" />
              <div className="rounded-xl border bg-card p-4 text-sm">
                <div className="mb-2 font-semibold">Tool MCP cho @flexiprint (flow mới)</div>
                <ul className="space-y-1 text-muted-foreground [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:text-foreground">
                  <li>
                    <code>list_base_products</code> — print area, khuôn, cách cắt, phôi, giá
                  </li>
                  <li>
                    <code>char_update_brief {"{product: {baseId}}"}</code> — bộ mới làm cho base nào
                  </li>
                  <li>
                    <code>create_artwork_product {"{base_product_id}"}</code> — artwork từ clipart thư viện
                  </li>
                  <li>
                    <code>set_artwork_base</code> — đổi base để xem / kiểm tra
                  </li>
                  <li>
                    <code>render_artwork</code> · <code>check_artwork</code> — vẽ / kiểm tra trên khuôn của base (theo pixel thật)
                  </li>
                  <li>
                    <code>make_version_phoi</code> · <code>version_phoi_status</code> — phôi preview theo version
                  </li>
                  <li>
                    <code>make_product_from_artwork</code> → <code>make_product_mockups</code> → <code>deploy_product</code> (trên sản phẩm)
                  </li>
                  <li>
                    <code>list_artwork_products</code> — sản phẩm của 1 artwork, cái nào cũ
                  </li>
                </ul>
              </div>
            </div>
          </Section>

          {/* ---------------------------------------------------------------- 8 */}
          <Section id="layers" title="8. Layers: Preview only · Print only" lead="Vẫn 2 nhóm như Teeinblue, cộng 1 nhóm dùng chung. Phôi + khuôn là 2 dòng cố định lấy từ base.">
            <div className="grid gap-4 md:grid-cols-2">
              <LayersMock kind="tb" />
              <LayersMock kind="fx" />
            </div>
            <div className="grid gap-3 md:grid-cols-3">
              <div className="rounded-xl border-l-4 border-sky-500 bg-card p-4 text-sm">
                <div className="mb-1 font-semibold">Preview (preview only)</div>
                Dòng <b>Phôi trơn</b> (từ base) + thứ chỉ khách thấy: chữ mẫu, đồ trang trí.
                <div className="mt-2 text-xs text-muted-foreground">Không bao giờ vào file in.</div>
              </div>
              <div className="rounded-xl border-l-4 border-orange-500 bg-card p-4 text-sm">
                <div className="mb-1 font-semibold">Print (Order only)</div>
                Dòng <b>Khuôn in</b> (từ base) + thứ chỉ xưởng nhận: nền mà ảnh option đã có sẵn.
                <div className="mt-2 text-xs text-muted-foreground">Không bao giờ hiện trên preview.</div>
              </div>
              <div className="rounded-xl border-l-4 border-emerald-500 bg-card p-4 text-sm">
                <div className="mb-1 font-semibold">Thiết kế (preview + file in)</div>
                Mọi layer còn lại. <b>Làm 1 lần</b>, dùng cho cả hai.
                <div className="mt-2 text-xs text-muted-foreground">Teeinblue phải làm 2 bản.</div>
              </div>
            </div>
          </Section>

          {/* ---------------------------------------------------------------- 9 */}
          <Section id="file-in" title="9. File in theo từng loại sản phẩm" lead="Base quyết định; artwork chỉ đưa thiết kế.">
            <div className="grid gap-4 md:grid-cols-3">
              {[
                { icon: Scissors, t: "Acrylic Ornament", d: "Cắt theo viền hình + 2.5 mm, tai treo. Preview: phôi theo version (AI hoặc từ folder import), phần khách chọn đặt lên.", s: "1 file cao gấp đôi: silhouette full đen trên, bản in dưới (như Cherivia gửi Merchize)" },
                { icon: ImageIcon, t: "Ornament sứ / kính tròn", d: "Đặt artwork vào khuôn tròn của base, chỉnh cỡ / vị trí ở sản phẩm. Preview: phôi sứ / kính của khuôn.", s: "File in cắt theo khuôn + cut.svg; gói zip có silhouette khuôn" },
                { icon: Printer, t: "Poseable Doll · áo · thảm", d: "In phẳng nguyên canvas, không cắt.", s: "Không silhouette" },
              ].map(({ icon: Icon, t, d, s }) => (
                <div key={t} className="rounded-xl border bg-card p-4">
                  <Icon className="mb-2 h-6 w-6 text-muted-foreground" />
                  <div className="font-semibold">{t}</div>
                  <p className="mt-1 text-sm text-muted-foreground">{d}</p>
                  <p className="mt-2 text-xs font-medium">{s}</p>
                </div>
              ))}
            </div>
            <Shot src="fx-filein-stack.jpg" caption="File in trên base Acrylic: silhouette full đen nửa trên + bản in nửa dưới — tự sinh từ hình theo cách cắt của base" tone="fx" />
            <div className="rounded-xl bg-amber-500/10 p-4 text-sm">
              <b>Còn thiếu:</b> khuôn Glass Heart, Ceramic Heart / Star; phôi Poseable Doll; Ceramic 2 mặt — mặt sau đang in cùng artwork mặt trước.
            </div>
          </Section>
        </main>
      </div>
    </div>
  );
}
