/* eslint-disable @next/next/no-img-element -- static screenshots from /public/huong-dan */
/**
 * /huong-dan — the team's guide to Product base · Artwork · Sản phẩm. Pictures first (asked 2026-11-07: "hướng dẫn là
 * 1 route … cho dễ hình dung chứ ghi text không hiểu được"). Rewritten 2026-11-08 (asked: "Trên Teeinblue Cherivia
 * đang làm thế nào (có hình chụp), có gì ổn, có gì chưa ổn. Flexi2 làm lại theo hướng nào, và tại sao"): the base owns
 * the physical piece (khuôn, cut, phôi), the artwork only the design. Screenshots live in public/huong-dan/.
 */

import Link from "next/link";
import { ArrowDown, ArrowRight, BookOpen, Check, ChevronDown, FileImage, Image as ImageIcon, Layers, Printer, Scissors, ShoppingBag, Store, Tag, X } from "lucide-react";

const IMG = "/huong-dan";

const TOC: Array<[string, string]> = [
  ["tom-tat", "1. Tóm tắt"],
  ["teeinblue", "2. Cherivia trên Teeinblue"],
  ["danh-gia", "3. Ổn / chưa ổn"],
  ["cac-ben", "4. Các bên lớn làm sao"],
  ["huong-moi", "5. flexi2 làm lại"],
  ["tai-sao", "6. Vì sao"],
  ["thao-tac", "7. Thao tác từng bước"],
  ["layers", "8. Layers Preview / Print"],
  ["file-in", "9. File in từng loại"],
  ["import", "10. Import & version"],
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

function Verdict({ good, title, children }: { good: boolean; title: string; children: React.ReactNode }) {
  return (
    <div className={`flex gap-3 rounded-xl border p-4 text-sm ${good ? "border-emerald-500/40 bg-emerald-500/5" : "border-destructive/30 bg-destructive/5"}`}>
      {good ? <Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" /> : <X className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />}
      <div>
        <div className="font-semibold">{title}</div>
        <div className="text-muted-foreground">{children}</div>
      </div>
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

const SOURCES: Array<{ who: string; say: string; href: string }> = [
  { who: "Teeinblue (tài liệu chính thức)", say: "Print area của Product base quyết định khổ file gửi xưởng và cách artwork hiện trên mockup. Nên đặt kích thước artwork = print area; lệch thì dùng “Locate artwork”.", href: "https://support.teeinblue.com/en/article/1lf9m49/" },
  { who: "Customily", say: "Product Base giữ thông số sản xuất + ảnh mockup. Design chỉ là thiết kế. Template = ghép Design với Product Base, có cài đặt file in và preview riêng.", href: "https://help.customily.com/articles/7630599580-understanding-templates" },
  { who: "Customall", say: "Silhouette cắt (Shape Cut) là ảnh đen tự sinh, đổi theo option khách chọn — không ai vẽ tay.", href: "https://support.customall.io/en/article/how-to-create-a-shape-cut-layer-in-artwork-1jhmikn" },
  { who: "Printful · Gelato · Printify", say: "Sản phẩm trơn có sẵn template print area + bleed + vùng an toàn; thiết kế làm theo đúng khổ đó.", href: "https://help.printify.com/hc/en-us/articles/4483626015889-What-are-safe-areas-and-bleeds" },
];

const OWNERS: Array<[string, string, string, string]> = [
  ["Print area (px, dpi) = khổ canvas", "✔ giữ", "canvas lấy theo base lúc tạo", ""],
  ["Khuôn in hình cố định (tròn, vuông)", "✔ giữ", "chỉ hiện để căn", "vị trí artwork trong khuôn"],
  ["Cắt theo viền thiết kế (acrylic) + viền mm", "✔ luật cắt", "silhouette tự sinh mỗi version", ""],
  ["Silhouette trong file in (kiểu Merchize)", "✔ bật / tắt", "", ""],
  ["Phôi trơn / ảnh nền xem trước", "✔ giữ", "", ""],
  ["Biến thể + giá (bảng Notion)", "✔ giữ", "", ""],
  ["Layer, option, version, chữ", "", "✔ giữ", "bản chụp của artwork"],
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
            <h2 className="text-3xl font-bold tracking-tight">Base lo phần vật lý, artwork lo phần thiết kế</h2>
            <p className="mt-2 max-w-3xl text-muted-foreground">
              Giống Teeinblue / Customily: Product base · Artwork · Sản phẩm (Campaign). Khác Cherivia đang làm: <b className="text-foreground">khuôn, phôi, cách cắt nằm ở base</b>, artwork chỉ còn
              thiết kế nên dùng lại được cho nhiều loại sản phẩm.
            </p>
            <div className="mt-6 grid items-center gap-3 md:grid-cols-[1fr_auto_1fr_auto_1fr]">
              <div className="space-y-3">
                <Box icon={Tag} title="Product base" sub="sản phẩm trơn" tone="border-amber-500/60 bg-amber-500/5" items={["Loại + biến thể + giá Notion", "Print area (khổ file)", "Khuôn in / cách cắt / silhouette", "Phôi trơn hoặc nền xem trước"]} />
                <Box icon={Layers} title="Artwork" sub="chỉ thiết kế" tone="border-violet-500/60 bg-violet-500/5" items={["Layer, option, version, chữ", "Canvas = print area của base", "Không chứa khuôn, phôi", "Xem trên base nào cũng được"]} />
              </div>
              <ArrowRight className="mx-auto hidden h-8 w-8 text-muted-foreground md:block" />
              <ArrowDown className="mx-auto h-8 w-8 text-muted-foreground md:hidden" />
              <Box icon={ShoppingBag} title="Sản phẩm" sub="= artwork đặt lên base" tone="border-sky-500/60 bg-sky-500/5" items={["Khuôn + phôi của base được ghép vào", "Vị trí artwork trong khuôn", "Tên theo chủ đề, mockup", "Nút Deploy"]} />
              <ArrowRight className="mx-auto hidden h-8 w-8 text-muted-foreground md:block" />
              <ArrowDown className="mx-auto h-8 w-8 text-muted-foreground md:hidden" />
              <Box icon={Store} title="Shopify" tone="border-emerald-500/60 bg-emerald-500/5" items={["Giá + biến thể từ base", "Form personalize từ artwork", "Preview trên phôi của base", "File in đúng khuôn của base"]} />
            </div>
          </section>

          {/* ---------------------------------------------------------------- 2 */}
          <Section id="teeinblue" title="2. Cherivia đang làm trên Teeinblue thế nào" lead="Chụp ngày 2026-11-08 từ 2 campaign acrylic của Cherivia: Gingerbread Train Family và Miles Don't Matter State Map.">
            <Shot src="tb-cherivia-campaign.jpg" caption="Campaign State Map — bước 1: chọn product base, mỗi print area (Front 1000×2000) gắn 1 artwork, có Edit artwork / Locate artwork. Bước 2: preview." tone="tb" />
            <TbCanvasDiagram />
            <div className="grid gap-4 md:grid-cols-2">
              <Shot src="tb-cherivia-artwork.jpg" caption="Artwork Gingerbread Train (#1363274) ở chế độ Edit: nửa trên silhouette đen, nửa dưới cảnh preview" tone="tb" />
              <Shot src="tb-cherivia-live.jpg" caption="Live preview: chỉ còn nhóm Preview — ảnh cảnh + bản sao nhân vật / chữ" tone="tb" />
            </div>
            <Shot src="tb-cherivia-scenes.jpg" caption="3 trong số các “Preview scene”: tàu 2 người, tàu 9 người, vòng State Map — mỗi cái là 1 ảnh riêng đã có viền acrylic + cây thông" tone="tb" />
          </Section>

          {/* ---------------------------------------------------------------- 3 */}
          <Section id="danh-gia" title="3. Cái gì ổn, cái gì chưa ổn">
            <div className="grid gap-3 md:grid-cols-2">
              <div className="space-y-3">
                <h3 className="font-semibold text-emerald-600">Ổn — giữ lại</h3>
                <Verdict good title="Tách 3 thứ">Product base · Artwork · Campaign. Giá + biến thể ở base, không phải nhập lại cho từng sản phẩm.</Verdict>
                <Verdict good title="Print area quyết định khổ file">Base acrylic 1000×2000 → file đúng chuẩn Merchize: silhouette nửa trên, bản màu nửa dưới.</Verdict>
                <Verdict good title="Preview giống thật">Khách thấy sản phẩm treo trên cây thông, viền acrylic rõ — bán hàng tốt hơn thiết kế trơn.</Verdict>
                <Verdict good title="Preview only / Print only">2 nhóm layer xổ / gập, nhìn là biết cái gì khách thấy, cái gì xưởng nhận.</Verdict>
                <Verdict good title="Locate artwork">Gắn artwork vào print area rồi chỉnh vị trí, không sửa artwork.</Verdict>
              </div>
              <div className="space-y-3">
                <h3 className="font-semibold text-destructive">Chưa ổn — không làm theo</h3>
                <Verdict good={false} title="Phôi vẽ tay cho từng version">Tàu 2 → 9 người = 8 ảnh “Preview scene”. Thêm 1 version là phải vẽ thêm 1 ảnh, quên là preview sai.</Verdict>
                <Verdict good={false} title="Mọi thứ có 2 bản">424 layer Print + 466 layer Preview. Bản preview còn đặt lệch bản in (khung 981px ở y 1116 so với 1000px ở y 1000) → preview không chắc đúng file in.</Verdict>
                <Verdict good={false} title="Định dạng xưởng nằm trong artwork">Silhouette nửa trên là của Merchize acrylic nhưng lại vẽ trong artwork → artwork tàu không đem sang áo / sứ được; Cherivia phải làm artwork khác cho Sweatshirt.</Verdict>
                <Verdict good={false} title="Base đặt tên theo thiết kế">Base “Gingerbread Train Family Acrylic Ornament” đang dùng cho cả campaign State Map — tên không nói đúng loại sản phẩm.</Verdict>
                <Verdict good={false} title="Mỗi artwork một kiểu, ít dùng lại">Có cái có cảnh preview, có cái không; sứ / kính làm khác acrylic. Chỉ 2 / 75 artwork nằm ở hơn 1 campaign.</Verdict>
              </div>
            </div>
          </Section>

          {/* ---------------------------------------------------------------- 4 */}
          <Section id="cac-ben" title="4. Các bên custom lớn tổ chức thế nào" lead="Cùng một kết luận: thông số vật lý thuộc về sản phẩm trơn, thiết kế làm theo nó.">
            <div className="grid gap-3 md:grid-cols-2">
              {SOURCES.map((s) => (
                <a key={s.who} href={s.href} target="_blank" rel="noreferrer" className="block rounded-xl border bg-card p-4 text-sm hover:border-foreground/30">
                  <div className="mb-1 flex items-center gap-2 font-semibold">
                    <BookOpen className="h-4 w-4 text-muted-foreground" /> {s.who}
                  </div>
                  <div className="text-muted-foreground">{s.say}</div>
                </a>
              ))}
            </div>
          </Section>

          {/* ---------------------------------------------------------------- 5 */}
          <Section id="huong-moi" title="5. flexi2 làm lại theo hướng nào" lead="Giữ hết cái ổn của Teeinblue, bỏ cái chưa ổn: phôi + khuôn + cách cắt chuyển lên base, artwork chỉ còn thiết kế.">
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
              <Shot src="fx-base-cut.jpg" caption="Trang Product base: mục Cắt + file in và Phôi / nền xem trước (Acrylic: ảnh nền cây thông)" tone="fx" />
              <Shot src="fx-artwork-on-base.jpg" caption="Artwork xem trên base Acrylic: preview = phôi AI của version (acrylic thật, dây treo) + nhân vật / chữ khách chọn đặt lên" tone="fx" />
            </div>
            <Shot src="fx-phoi-ai.jpg" caption="Phôi AI theo version: 8 version tàu, mỗi cái 1 ảnh acrylic thật do AI vẽ từ phần cố định — chỗ nhân vật để trống cho khách chọn" tone="fx" />
            <div className="rounded-2xl border-2 border-sky-500/50 bg-sky-500/5 p-4">
              <div className="mb-3 font-semibold">1 artwork — đổi base là ra loại sản phẩm khác (không sửa thiết kế)</div>
              <Shot src="fx-same-artwork.jpg" caption="Cùng artwork tàu Gingerbread: trên base Acrylic · Ceramic tròn (cắt theo khuôn, phôi sứ) · Poseable Doll (in phẳng)" tone="fx" />
            </div>
            <div className="grid gap-4 md:grid-cols-2">
              <Shot src="fx-filein-stack.jpg" caption="File in trên base Acrylic: silhouette full đen nửa trên + bản in nửa dưới, đúng kiểu Merchize của Cherivia — tự sinh từ hình, không vẽ" tone="fx" />
              <Shot src="fx-product-locate.jpg" caption="Sản phẩm trên base có khuôn: thanh “Vị trí artwork trong khuôn” (như Locate artwork)" tone="fx" />
            </div>
          </Section>

          {/* ---------------------------------------------------------------- 6 */}
          <Section id="tai-sao" title="6. Vì sao nên làm vậy">
            <div className="grid gap-3 md:grid-cols-2">
              {[
                ["Một chỗ sửa, mọi nơi theo", "Đổi khuôn / phôi / viền ở trang base rồi Lưu → mọi artwork xem trên base đó và mọi sản phẩm của nó cập nhật ngay. Teeinblue phải sửa từng artwork."],
                ["Phôi theo version: AI vẽ, không ai vẽ tay", "Bấm “Phôi AI theo version” → AI vẽ phần cố định của từng version thành acrylic thật trên nền của base, tự căn khớp từng px. Teeinblue phải vẽ tay 8 ảnh."],
                ["File in không bao giờ có vật liệu", "Phôi AI chỉ để khách xem. File gửi xưởng (kèm đơn add to cart) là thiết kế gốc + khuôn / silhouette — vật liệu do xưởng quyết định."],
                ["Preview luôn khớp file in", "Không có bản sao Preview / Print: cùng 1 layer ra cả hai, nên không thể lệch nhau."],
                ["Artwork dùng lại được", "Cùng 1 thiết kế đặt lên Acrylic, Ceramic, áo… chỉ bằng cách chọn base. Định dạng file của xưởng nằm ở base."],
                ["Đúng cách cả ngành làm", "Teeinblue (tài liệu), Customily, Customall, Printful / Gelato đều để thông số vật lý ở sản phẩm trơn."],
                ["Đổi xưởng dễ", "Xưởng khác cần silhouette tách file hay không cần: chỉ sửa mục Cắt + file in của base."],
              ].map(([t, d]) => (
                <Verdict key={t} good title={t}>
                  {d}
                </Verdict>
              ))}
            </div>
          </Section>

          {/* ---------------------------------------------------------------- 7 */}
          <Section id="thao-tac" title="7. Thao tác từng bước">
            <Step n={1} title="Kiểm tra Product base" shot="fx-base-cut.jpg">
              <p>
                Tab <b>Product base</b> → bấm 1 base. Kiểm tra <b>Biến thể + giá</b>, <b>Print area</b>, <b>Khuôn in + phôi</b>, rồi 2 mục mới:
              </p>
              <p>
                • <b>Cắt + file in</b>: theo khuôn cố định / cắt theo viền thiết kế (+ mm) / in phẳng; bật <b>silhouette</b>, tai treo.
                <br />• <b>Phôi / nền xem trước</b>: ảnh phôi trơn (sứ, kính) hoặc ảnh nền (acrylic). Kéo 3 thanh để đặt khung thiết kế lên ảnh.
              </p>
              <p>
                Bấm <b>Lưu</b> — mọi sản phẩm trên base tự cập nhật.
              </p>
            </Step>
            <Step n={2} title="Có artwork" shot="fx-create-artwork.jpg">
              <p>
                • <b>Import bộ</b> (tab Artwork): tự gắn base theo vật liệu. · • <b>Tạo artwork</b> từ 1 base: canvas trống đúng khổ của base. · • <b>Canvas trống</b> nhập rộng × cao.
              </p>
            </Step>
            <Step n={3} title="Làm artwork + chọn “Xem trên base”" shot="fx-artwork-on-base.jpg">
              <p>
                <b>Thiết kế</b>: kéo clipart, thêm chữ, ảnh khách. Ô <b>Xem trên base</b> trên thanh đầu trang: đường khuôn + vùng an toàn của base hiện trên canvas.
              </p>
              <p>
                <b>Xem trước</b>: trang bán trên phôi của base. <b>File in</b>: cắt theo khuôn / viền của base, silhouette theo base. Đổi base để thử loại sản phẩm khác.
              </p>
              <p>
                Base acrylic: ở Layers → nhóm Preview bấm <b>Phôi AI theo version</b> → <b>Vẽ N version chưa có</b> (~2 phút, các version vẽ cùng lúc). Xong thì sản phẩm làm từ artwork tự nhận.
              </p>
            </Step>
            <Step n={4} title="Tạo sản phẩm = artwork + product base" shot="fx-create-product.jpg">
              <p>
                Tab <b>Sản phẩm</b> → <b>Tạo sản phẩm</b>: chọn artwork, chọn base, đặt tên theo chủ đề. 1 artwork có thể làm nhiều sản phẩm trên nhiều base.
              </p>
            </Step>
            <Step n={5} title="Vị trí trong khuôn + mockup" shot="fx-product-locate.jpg">
              <p>
                Base có khuôn cố định (sứ, kính): thanh <b>Vị trí artwork trong khuôn</b> — Cỡ, Ngang, Dọc. Trái: <b>Tạo mockup</b> AI hoặc <b>Import mockup</b>. Phải: giá + form như khách thấy.
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
            <div className="rounded-xl bg-muted/60 p-4 text-sm">
              Chuyển layer sang nhóm khác: kéo layer thả lên <b>tiêu đề nhóm</b>, hoặc chọn layer → ô <b>Nhóm</b>. Base thiếu phôi / khuôn → dòng cố định báo{" "}
              <span className="font-semibold text-amber-600">thiếu</span>, bấm vào để mở base và thêm.
            </div>
          </Section>

          {/* ---------------------------------------------------------------- 9 */}
          <Section id="file-in" title="9. File in theo từng loại sản phẩm" lead="Base quyết định; artwork chỉ đưa thiết kế.">
            <div className="grid gap-4 md:grid-cols-3">
              {[
                { icon: Scissors, t: "Acrylic Ornament", d: "Cắt theo viền hình + 2.5 mm, tai treo. Preview: phôi AI theo version (acrylic thật trên nền cây thông), phần khách chọn đặt lên.", s: "1 file cao gấp đôi: silhouette full đen trên, bản in dưới (như Cherivia gửi Merchize)" },
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
              <b>Còn thiếu:</b> khuôn Glass Heart, Ceramic Heart / Star; phôi Poseable Doll; Ceramic 2 mặt — mặt sau đang in cùng artwork mặt trước.
            </div>
          </Section>

          {/* ---------------------------------------------------------------- 10 */}
          <Section id="import" title="10. Bộ import & version" lead="Folder Teeinblue / zip đã đủ layer, option, chữ, vị trí — tức là 1 artwork hoàn chỉnh.">
            <div className="grid items-center gap-3 md:grid-cols-[1fr_auto_1fr]">
              <div className="rounded-xl border bg-card p-4 text-center">
                <FileImage className="mx-auto mb-2 h-8 w-8 text-muted-foreground" />
                <div className="font-semibold">Import bộ (folder / zip)</div>
                <div className="text-xs text-muted-foreground">hoặc Tạo bộ clipart mới (vẽ AI)</div>
              </div>
              <ArrowRight className="mx-auto hidden h-8 w-8 text-muted-foreground md:block" />
              <div className="grid gap-3">
                <div className="rounded-xl border-2 border-violet-500/60 bg-violet-500/5 p-3 text-sm">
                  <b>1 Artwork hoàn chỉnh</b> — xem trên base theo vật liệu. Dùng để tạo sản phẩm.
                </div>
                <div className="rounded-xl border p-3 text-sm">
                  <b>Clipart</b> — Thư viện, để <b>tái sử dụng</b> khi thiết kế thủ công artwork khác.
                </div>
              </div>
            </div>
            <div className="grid gap-4 md:grid-cols-2">
              <div className="rounded-xl border bg-card p-4 text-sm">
                <div className="mb-2 flex items-center gap-2 font-semibold">
                  <span className="rounded bg-blue-600 px-1.5 py-0.5 text-[10px] text-white">Teeinblue</span> 1 canvas gộp mọi version
                </div>
                Mỗi số người là 1 nhóm layer có điều kiện trong cùng 1 danh sách 892 layer.
              </div>
              <div className="rounded-xl border bg-card p-4 text-sm">
                <div className="mb-2 flex items-center gap-2 font-semibold">
                  <span className="rounded bg-emerald-600 px-1.5 py-0.5 text-[10px] text-white">flexi2</span> mỗi version 1 bộ layer
                </div>
                Bấm version nào thấy đúng version đó. Bản chất giống nhau: cùng ra form personalize, preview trên phôi, file in đúng khuôn.
              </div>
            </div>
          </Section>
        </main>
      </div>
    </div>
  );
}
