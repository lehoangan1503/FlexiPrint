// FlexiPrint extension for the ComfyUI frontend.
//
//   Simple mode (setting "FlexiPrint.SimpleUI", on by default): ComfyUI's own
//   sidebar tabs, onboarding, template gallery, minimap and non-FlexiPrint
//   nodes are hidden — editors only see the FlexiPrint workspace.
//   Sidebar "FlexiPrint"   1. Bắt đầu: the 4 standard FlexiPrint graphs
//                          2. Thêm node: every FP node, one click
//                          3. Thư viện: categories → cliparts; click = FP Load Clipart
//   Bottom panel "Ngữ cảnh"  what the selected FP node sent to the model last run.
//   FP nodes               show their result text (resolved prompt / report) inline.
//   Deep links             /comfy/?fp_template=02-variant-set&fp_clipart=<id>
//                          (&fp_artwork=<id>, &fp_category=<id>) — the editor's
//                          "Tạo bằng AI" buttons open the right graph pre-filled.
//                          ?fp_draft=<id>: the AI dialog's graph (routes.py /flexi/draft).
//
// Data comes from the node pack's own routes (/flexi/*, routes.py) — same origin,
// no token in the browser.

import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const INFO = new Map(); // node id → last text
const APP_URL_SETTING = "FlexiPrint.AppUrl";
const SIMPLE_SETTING = "FlexiPrint.SimpleUI";

// The four standard jobs (= the app's AI dialog recipes, recipes.py). Main or element is the
// category's usage, so one "clipart gốc" graph covers both (03-element-pack stays as an example).
const TEMPLATES = [
  ["01-origin-set", "Clipart gốc", "Main hoặc Element theo danh mục: mỗi dòng 1 clipart gốc, cùng style + rule"],
  ["02-variant-set", "Biến thể", "1 clipart → nhiều màu / style, giữ nguyên hình (đổi màu không cần AI)"],
  ["04-clipart-material", "Vật liệu", "Acrylic / glitter / gỗ… → bản vật liệu cho clipart"],
  ["05-artwork-mockup", "Mockup", "Tổ hợp đã ghép → vật liệu → ảnh quảng cáo"],
];

const NODES = [
  ["FP_StylePack", "Style Pack", "Ngữ cảnh"],
  ["FP_Category", "Danh mục", "Ngữ cảnh"],
  ["FP_ContextNote", "Ghi chú ngữ cảnh", "Ngữ cảnh"],
  ["FP_Rules", "Ghi đè rule (canvas, fill, neo)", "Ngữ cảnh"],
  ["FP_OriginGenerate", "Tạo clipart gốc", "Tạo"],
  ["FP_VariantSet", "Tạo bộ biến thể", "Tạo"],
  ["FP_Material", "Vật liệu AI", "Tạo"],
  ["FP_MockupScene", "Mockup bối cảnh", "Tạo"],
  ["FP_Cutout", "Tách nền + chuẩn hoá", "Xử lý"],
  ["FP_LoadClipart", "Lấy clipart", "Thư viện"],
  ["FP_LoadArtwork", "Lấy artwork", "Thư viện"],
  ["FP_SaveToLibrary", "Lưu vào thư viện", "Thư viện"],
  ["FP_SaveMockup", "Lưu mockup", "Thư viện"],
];

// Core nodes that stay searchable in simple mode (previews / notes).
const KEEP_CORE = new Set(["PreviewImage", "SaveImage", "LoadImage", "ImageScale", "ImageBatch"]);

function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "style") Object.assign(e.style, v);
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v);
  }
  for (const c of children) e.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return e;
}

async function getJson(path) {
  const r = await api.fetchApi(path);
  const body = await r.json();
  if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
  return body;
}

function setting(id, fallback) {
  try {
    const v = app.extensionManager?.setting?.get(id);
    return v === undefined || v === null ? fallback : v;
  } catch {
    return fallback;
  }
}

function appUrl() {
  return setting(APP_URL_SETTING, "") || "https://flexiprint.next.lc";
}

function simpleMode() {
  return setting(SIMPLE_SETTING, true) !== false;
}

// ------------------------------------------------------------------ graph helpers

function canvasCenter() {
  const c = app.canvas;
  const ds = c?.ds;
  if (!ds || !c.canvas) return [100, 100];
  return [-ds.offset[0] + c.canvas.width / 2 / ds.scale - 150, -ds.offset[1] + c.canvas.height / 2 / ds.scale - 100];
}

function addNode(type) {
  const node = LiteGraph.createNode(type);
  if (!node) return null;
  node.pos = canvasCenter();
  app.graph.add(node);
  app.graph.setDirtyCanvas(true, true);
  return node;
}

/** Point a remote dropdown (clipart / artwork / category) at the option whose uuid is `id`. */
async function selectOption(node, widgetName, kind, id) {
  const options = await getJson(`/flexi/options/${kind}`).catch(() => []);
  const value = options.find((o) => o.endsWith(id));
  const w = node?.widgets?.find((x) => x.name === widgetName);
  if (!w || !value) return false;
  if (w.options) w.options.values = options;
  w.value = value;
  w.callback?.(value);
  app.graph.setDirtyCanvas(true, true);
  return true;
}

async function addClipartNode(clipartId) {
  const node = addNode("FP_LoadClipart");
  if (node) await selectOption(node, "clipart", "cliparts", clipartId);
}

async function loadTemplate(name) {
  const wf = await (await api.fetchApi(`/workflow_templates/flexiprint/${name}.json`)).json();
  await app.loadGraphData(wf);
}

// Remote dropdowns a recipe graph fills with a bare uuid → their option route.
const REMOTE_WIDGETS = {
  FP_LoadClipart: ["clipart", "cliparts"],
  FP_LoadArtwork: ["artwork", "artworks"],
  FP_Category: ["category", "categories"],
  FP_StylePack: ["style_pack", "style_pack"],
  FP_Material: ["material", "material"],
  FP_MockupScene: ["scene", "scene"],
};

/** "Mở nâng cao trong Studio" from the app's AI dialog: the exact graph the dialog would run. */
async function openDraft(id) {
  const prompt = await getJson(`/flexi/draft/${encodeURIComponent(id)}`);
  await app.loadApiJson(prompt, "FlexiPrint AI");
  await new Promise((r) => setTimeout(r, 1200));
  for (const n of app.graph._nodes) {
    const spec = REMOTE_WIDGETS[n.type];
    const w = spec && n.widgets?.find((x) => x.name === spec[0]);
    const m = w && /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.exec(String(w.value));
    if (m) await selectOption(n, spec[0], spec[1], m[0]);
  }
  app.graph.arrange?.();
  app.graph.setDirtyCanvas(true, true);
}

/** Deep link from the FlexiPrint editor: template + pre-selected clipart / artwork / category, or a dialog draft. */
async function openFromUrl() {
  const q = new URLSearchParams(location.search);
  const draft = q.get("fp_draft");
  if (draft) {
    await openDraft(draft);
    history.replaceState(null, "", location.pathname);
    return true;
  }
  const template = q.get("fp_template");
  if (!template) return false;
  await loadTemplate(template);
  await new Promise((r) => setTimeout(r, 1200)); // remote dropdowns finish their first fetch
  const nodes = app.graph._nodes;
  const pick = async (type, widget, kind, id) => {
    if (!id) return;
    for (const n of nodes.filter((x) => x.type === type)) await selectOption(n, widget, kind, id);
  };
  await pick("FP_LoadClipart", "clipart", "cliparts", q.get("fp_clipart"));
  await pick("FP_LoadArtwork", "artwork", "artworks", q.get("fp_artwork"));
  await pick("FP_Category", "category", "categories", q.get("fp_category"));
  history.replaceState(null, "", location.pathname);
  return true;
}

function setInfo(node, text) {
  if (!text) return;
  INFO.set(String(node.id), text);
  let w = node.widgets?.find((x) => x.name === "fp_info");
  if (!w && typeof node.addDOMWidget === "function") {
    const pre = el("pre", {
      style: {
        margin: "0",
        padding: "6px",
        font: "11px/1.35 ui-monospace, monospace",
        whiteSpace: "pre-wrap",
        maxHeight: "180px",
        overflow: "auto",
        background: "rgba(0,0,0,.25)",
        borderRadius: "4px",
        color: "var(--input-text, #ddd)",
      },
    });
    w = node.addDOMWidget("fp_info", "fp_info", pre, { serialize: false, hideOnZoom: true, getValue: () => pre.textContent, setValue: () => {} });
    w.fpPre = pre;
  }
  if (w?.fpPre) w.fpPre.textContent = text;
  node.setDirtyCanvas?.(true, true);
}

// ------------------------------------------------------------------ sidebar

const S = {
  input: { width: "100%", padding: "5px 6px", background: "var(--comfy-input-bg,#222)", color: "inherit", border: "1px solid var(--border-color,#444)", borderRadius: "5px", boxSizing: "border-box" },
  h: { fontWeight: "600", margin: "12px 0 6px", fontSize: "12px", textTransform: "uppercase", letterSpacing: ".04em", opacity: ".75" },
  btn: { display: "block", width: "100%", textAlign: "left", padding: "6px 8px", marginBottom: "4px", background: "var(--comfy-menu-secondary-bg, #2a2a2a)", color: "inherit", border: "1px solid var(--border-color,#444)", borderRadius: "6px", cursor: "pointer", font: "inherit" },
};

function section(title, open, ...children) {
  const body = el("div", { style: { display: open ? "block" : "none" } }, ...children);
  const head = el(
    "div",
    { style: { ...S.h, cursor: "pointer", userSelect: "none" }, onclick: () => (body.style.display = body.style.display === "none" ? "block" : "none") },
    title,
  );
  return el("div", {}, head, body);
}

function renderSidebar(root) {
  root.innerHTML = "";
  root.style.cssText = "display:flex;flex-direction:column;height:100%;font:12px system-ui,sans-serif;color:var(--fg-color,#ddd);overflow-y:auto;padding:8px;box-sizing:border-box";

  // 1. Start from a FlexiPrint graph
  const start = TEMPLATES.map(([id, name, hint]) =>
    el("button", { style: S.btn, title: hint, onclick: () => loadTemplate(id) }, el("div", { style: { fontWeight: "600" } }, name), el("div", { style: { opacity: ".65", fontSize: "11px" } }, hint)),
  );

  // 2. Add a node
  const groups = {};
  for (const [type, name, group] of NODES) (groups[group] ??= []).push([type, name]);
  const add = Object.entries(groups).map(([group, list]) =>
    el(
      "div",
      { style: { marginBottom: "6px" } },
      el("div", { style: { opacity: ".6", fontSize: "11px", margin: "4px 0" } }, group),
      el(
        "div",
        { style: { display: "flex", flexWrap: "wrap", gap: "4px" } },
        ...list.map(([type, name]) => el("button", { style: { ...S.btn, display: "inline-block", width: "auto", marginBottom: "0", padding: "4px 7px" }, onclick: () => addNode(type) }, `+ ${name}`)),
      ),
    ),
  );

  // 3. Library
  const select = el("select", { style: S.input });
  const search = el("input", { placeholder: "Tìm clipart…", style: { ...S.input, marginTop: "6px" } });
  const status = el("div", { style: { opacity: ".7", margin: "6px 0" } }, "Đang tải…");
  const grid = el("div", { style: { display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "6px", alignContent: "start", alignItems: "start" } });
  const links = el(
    "div",
    { style: { display: "flex", gap: "10px", marginTop: "6px" } },
    el("a", { href: "#", onclick: (e) => (e.preventDefault(), window.open(`${appUrl()}/library`, "_blank")), style: { color: "#6cf" } }, "Quản lý thư viện ↗"),
    el("a", { href: "#", onclick: (e) => (e.preventDefault(), load()), style: { color: "#6cf" } }, "Tải lại"),
  );

  root.append(
    el("div", { style: { fontWeight: "700", fontSize: "14px" } }, "FlexiPrint Studio"),
    el("div", { style: { opacity: ".65", marginTop: "2px" } }, "Chọn 1 graph mẫu → chọn danh mục / clipart → Run. Kết quả tự vào thư viện."),
    section("1 · Bắt đầu", true, ...start),
    section("2 · Thêm node", false, ...add),
    section("3 · Thư viện", true, select, search, links, status, grid),
  );

  let cliparts = [];
  let categories = [];

  function draw() {
    const q = search.value.trim().toLowerCase();
    const origins = cliparts.filter((a) => !a.parent_id && (!q || a.name.toLowerCase().includes(q) || (a.spec || "").toLowerCase().includes(q)));
    grid.innerHTML = "";
    status.textContent = `${origins.length} clipart gốc · bấm ảnh = thêm node "Lấy clipart"`;
    for (const a of origins) {
      const members = cliparts.filter((m) => m.parent_id === a.id && m.role !== "rendition");
      grid.append(
        el(
          "div",
          {
            title: `${a.name}\n${a.role} ${a.width}×${a.height}\n${members.length} biến thể${a.spec ? `\n${a.spec}` : ""}`,
            style: { cursor: "pointer", border: "1px solid var(--border-color,#444)", borderRadius: "6px", padding: "3px", background: "#eee" },
            onclick: () => addClipartNode(a.id),
          },
          el("img", { src: a.url, loading: "lazy", style: { width: "100%", aspectRatio: "1", objectFit: "contain", display: "block" } }),
          el("div", { style: { color: "#222", fontSize: "10px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } }, `${a.name}${members.length ? ` (+${members.length})` : ""}`),
        ),
      );
      for (const m of members.slice(0, 11)) {
        grid.append(
          el(
            "div",
            { title: `${a.name} / ${m.name}`, style: { cursor: "pointer", borderRadius: "6px", padding: "2px", background: "#f6f6f6" }, onclick: () => addClipartNode(m.id) },
            el("img", { src: m.url, loading: "lazy", style: { width: "100%", aspectRatio: "1", objectFit: "contain", display: "block" } }),
          ),
        );
      }
    }
  }

  async function load() {
    status.textContent = "Đang tải…";
    try {
      const cat = select.value || "";
      const data = await getJson(`/flexi/library${cat ? `?category=${encodeURIComponent(cat)}` : ""}`);
      if (!categories.length) {
        categories = data.categories;
        select.innerHTML = "";
        select.append(el("option", { value: "" }, "Tất cả danh mục"));
        for (const c of categories) select.append(el("option", { value: c.id }, `${c.name} · ${c.usage === "main" ? "main" : "element"}`));
        select.append(el("option", { value: "none" }, "Chưa phân loại"));
      }
      cliparts = data.cliparts;
      draw();
    } catch (e) {
      status.textContent = `Lỗi: ${e.message}`;
    }
  }

  select.addEventListener("change", load);
  search.addEventListener("input", draw);
  load();
}

// ------------------------------------------------------------------ bottom panel

function renderContextPanel(root) {
  root.innerHTML = "";
  const pre = el("pre", { style: { margin: "0", padding: "8px 12px", font: "12px/1.45 ui-monospace, monospace", whiteSpace: "pre-wrap", height: "100%", overflow: "auto" } });
  root.append(pre);
  let last = "";
  const tick = () => {
    if (!root.isConnected) return;
    const node = Object.values(app.canvas?.selected_nodes || {})[0];
    let text;
    if (!node) text = "Chọn 1 node FlexiPrint để xem ngữ cảnh / prompt nó đã gửi cho AI ở lần chạy gần nhất.";
    else if (!String(node.type || "").startsWith("FP_")) text = `${node.title}: không phải node FlexiPrint.`;
    else text = `${node.title}\n${"─".repeat(40)}\n${INFO.get(String(node.id)) || "(chưa chạy — bấm Run để xem prompt đã ghép)"}`;
    if (text !== last) pre.textContent = last = text;
    setTimeout(tick, 400);
  };
  tick();
}

// ------------------------------------------------------------------ simple mode

const HIDDEN_TABS = ["assets", "node-library", "model-library", "workflows", "apps", "queue", "model-library-v2"];

function applySimpleMode() {
  const em = app.extensionManager;
  for (const id of HIDDEN_TABS) {
    try {
      em.unregisterSidebarTab?.(id);
    } catch {
      // tab not present in this frontend version
    }
  }
  const css = el(
    "style",
    { id: "fp-simple-ui" },
    // Rail buttons that aren't tabs: template gallery, help, shortcuts. Settings stays (Ctrl+,).
    `button[aria-label^="Templates"], button[aria-label^="Help Center"], button[aria-label^="Keyboard Shortcuts"] { display: none !important; }`,
  );
  document.head.append(css);
  const set = (id, v) => {
    try {
      if (em.setting.get(id) !== v) em.setting.set(id, v);
    } catch {
      // unknown setting in this version
    }
  };
  set("Comfy.TutorialCompleted", true);
  set("Comfy.Minimap.Visible", false);
  set("Comfy.Node.ShowDeprecated", false);
  // One graph at a time: workflow tabs go to the (removed) workflows sidebar.
  set("Comfy.Workflow.WorkflowTabsPosition", "Sidebar");
  // Open on the FlexiPrint tab.
  setTimeout(() => {
    try {
      if (em.sidebarTab?.activeSidebarTabId !== "flexiprint-library") em.sidebarTab?.toggleSidebarTab?.("flexiprint-library");
    } catch {
      // older frontend
    }
  }, 300);
}

// ------------------------------------------------------------------ register

app.registerExtension({
  name: "FlexiPrint.Studio",
  settings: [
    { id: APP_URL_SETTING, name: "FlexiPrint app URL", type: "text", defaultValue: "https://flexiprint.next.lc", category: ["FlexiPrint", "App", "URL"] },
    {
      id: SIMPLE_SETTING,
      name: "Giao diện gọn (chỉ FlexiPrint) — tải lại trang sau khi đổi",
      type: "boolean",
      defaultValue: true,
      category: ["FlexiPrint", "App", "Simple"],
    },
  ],
  // Simple mode: only FlexiPrint nodes (+ a few previews) in search / node library.
  async addCustomNodeDefs(defs) {
    if (!simpleMode()) return;
    for (const [name, def] of Object.entries(defs)) {
      if (!name.startsWith("FP_") && !KEEP_CORE.has(name)) def.deprecated = true;
    }
  },
  async setup() {
    app.extensionManager.registerSidebarTab({
      id: "flexiprint-library",
      icon: "pi pi-images",
      title: "FlexiPrint",
      tooltip: "FlexiPrint Studio: graph mẫu, node, thư viện clipart",
      type: "custom",
      render: renderSidebar,
    });
    if (simpleMode()) applySimpleMode();

    // Editor deep link wins; otherwise a first visit (or ComfyUI's stock graph) gets the starter.
    setTimeout(async () => {
      try {
        if (await openFromUrl()) return;
      } catch (e) {
        console.warn("[flexiprint] deep link", e);
      }
      let first = false;
      try {
        first = !localStorage.getItem("fp-starter-loaded");
        localStorage.setItem("fp-starter-loaded", "1");
      } catch {
        // storage blocked: fall back to the graph check below
      }
      const nodes = app.graph?._nodes ?? [];
      const hasFp = nodes.some((n) => String(n.type).startsWith("FP_"));
      const stock = nodes.length === 0 || nodes.some((n) => ["KSampler", "CheckpointLoaderSimple", "UNETLoader"].includes(n.type));
      if (hasFp || !(first || stock)) return;
      try {
        document.querySelectorAll('.p-dialog-close-button, [aria-label="Close"]').forEach((b) => b.closest(".p-dialog, [role=dialog]") && b.click());
        await loadTemplate("01-origin-set");
      } catch (e) {
        console.warn("[flexiprint] starter template", e);
      }
    }, 1500);

    api.addEventListener("executed", ({ detail }) => {
      const text = detail?.output?.text?.join?.("\n");
      if (!text) return;
      const node = app.graph?.getNodeById?.(Number(detail.node)) || app.graph?.getNodeById?.(detail.node);
      if (node) setInfo(node, text);
      else INFO.set(String(detail.node), text);
    });
  },
  bottomPanelTabs: [
    {
      id: "flexiprint-context",
      title: "Ngữ cảnh",
      type: "custom",
      render: renderContextPanel,
    },
  ],
});
