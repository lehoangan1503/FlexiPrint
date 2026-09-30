// FlexiPrint extension for the ComfyUI frontend.
//
//   Sidebar "FlexiPrint"   browse the clipart library (categories → cliparts);
//                          click a clipart to drop an FP Load Clipart node for it.
//   Bottom panel "Ngữ cảnh"  what the selected FP node sent to the model last run
//                          (style pack → category spec + rules → notes → instruction).
//   FP nodes               show their result text (resolved prompt / report) inline.
//
// Data comes from the node pack's own routes (/flexi/*, routes.py) — same origin,
// no token in the browser.

import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const INFO = new Map(); // node id → last text
const APP_URL_SETTING = "FlexiPrint.AppUrl";

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

function appUrl() {
  return app.extensionManager?.setting?.get(APP_URL_SETTING) || "https://flexiprint.next.lc";
}

// ------------------------------------------------------------------ node helpers

function canvasCenter() {
  const c = app.canvas;
  const ds = c?.ds;
  if (!ds || !c.canvas) return [100, 100];
  return [(-ds.offset[0] + c.canvas.width / 2 / ds.scale) - 150, (-ds.offset[1] + c.canvas.height / 2 / ds.scale) - 100];
}

async function addClipartNode(clipartId) {
  const node = LiteGraph.createNode("FP_LoadClipart");
  if (!node) return;
  node.pos = canvasCenter();
  app.graph.add(node);
  const options = await getJson("/flexi/options/cliparts").catch(() => []);
  const value = options.find((o) => o.endsWith(clipartId));
  const w = node.widgets?.find((x) => x.name === "clipart");
  if (w && value) {
    if (w.options) w.options.values = options;
    w.value = value;
  }
  app.graph.setDirtyCanvas(true, true);
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

function renderSidebar(root) {
  root.innerHTML = "";
  root.style.cssText = "display:flex;flex-direction:column;height:100%;font:12px system-ui,sans-serif;color:var(--fg-color,#ddd)";
  const select = el("select", { style: { width: "100%", padding: "4px", background: "var(--comfy-input-bg,#222)", color: "inherit", border: "1px solid var(--border-color,#444)", borderRadius: "4px" } });
  const search = el("input", { placeholder: "Tìm clipart…", style: { width: "100%", padding: "4px", marginTop: "6px", background: "var(--comfy-input-bg,#222)", color: "inherit", border: "1px solid var(--border-color,#444)", borderRadius: "4px" } });
  const status = el("div", { style: { opacity: ".7", margin: "6px 0" } }, "Đang tải…");
  const grid = el("div", { style: { display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "6px", overflowY: "auto", flex: "1", alignContent: "start", alignItems: "start" } });
  const links = el(
    "div",
    { style: { display: "flex", gap: "8px", marginTop: "6px" } },
    el("a", { href: "#", onclick: (e) => (e.preventDefault(), window.open(`${appUrl()}/library`, "_blank")), style: { color: "#6cf" } }, "Quản lý thư viện ↗"),
    el("a", { href: "#", onclick: (e) => (e.preventDefault(), load()), style: { color: "#6cf" } }, "Tải lại"),
  );
  root.append(el("div", { style: { padding: "8px" } }, el("div", { style: { fontWeight: "600", marginBottom: "6px" } }, "Thư viện FlexiPrint"), select, search, links, status), el("div", { style: { padding: "0 8px 8px", flex: "1", display: "flex", minHeight: "0" } }, grid));

  let cliparts = [];
  let categories = [];

  function draw() {
    const q = search.value.trim().toLowerCase();
    const origins = cliparts.filter((a) => !a.parent_id && (!q || a.name.toLowerCase().includes(q) || (a.spec || "").toLowerCase().includes(q)));
    grid.innerHTML = "";
    status.textContent = `${origins.length} clipart gốc · bấm ảnh để thêm node FP Load Clipart`;
    for (const a of origins) {
      const members = cliparts.filter((m) => m.parent_id === a.id && m.role !== "rendition");
      const card = el(
        "div",
        { title: `${a.name}\n${a.role} ${a.width}×${a.height}\n${members.length} biến thể${a.spec ? `\n${a.spec}` : ""}`, style: { cursor: "pointer", border: "1px solid var(--border-color,#444)", borderRadius: "6px", padding: "3px", background: "#eee" }, onclick: () => addClipartNode(a.id) },
        el("img", { src: a.url, loading: "lazy", style: { width: "100%", aspectRatio: "1", objectFit: "contain", display: "block" } }),
        el("div", { style: { color: "#222", fontSize: "10px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } }, `${a.name}${members.length ? ` (+${members.length})` : ""}`),
      );
      grid.append(card);
      for (const m of members.slice(0, 11)) {
        grid.append(
          el(
            "div",
            { title: `${a.name} / ${m.name}`, style: { cursor: "pointer", borderRadius: "6px", padding: "2px", background: "#f6f6f6", opacity: ".9" }, onclick: () => addClipartNode(m.id) },
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
    const sel = Object.values(app.canvas?.selected_nodes || {});
    const node = sel[0];
    let text;
    if (!node) text = "Chọn 1 node FlexiPrint để xem ngữ cảnh / prompt nó đã gửi cho model ở lần chạy gần nhất.";
    else if (!String(node.type || "").startsWith("FP_")) text = `${node.title}: không phải node FlexiPrint.`;
    else text = `${node.title}\n${"─".repeat(40)}\n${INFO.get(String(node.id)) || "(chưa chạy — Queue để xem prompt đã ghép)"}`;
    if (text !== last) pre.textContent = last = text;
    setTimeout(tick, 400);
  };
  tick();
}

// ------------------------------------------------------------------ register

app.registerExtension({
  name: "FlexiPrint.Studio",
  settings: [
    { id: APP_URL_SETTING, name: "FlexiPrint app URL", type: "text", defaultValue: "https://flexiprint.next.lc", category: ["FlexiPrint", "App", "URL"] },
  ],
  async setup() {
    app.extensionManager.registerSidebarTab({
      id: "flexiprint-library",
      icon: "pi pi-images",
      title: "FlexiPrint",
      tooltip: "Thư viện clipart FlexiPrint",
      type: "custom",
      render: renderSidebar,
    });
    // The stock default graph needs local diffusion models this studio doesn't have:
    // replace it with the FlexiPrint starter template (a saved / opened workflow is left alone).
    setTimeout(async () => {
      const nodes = app.graph?._nodes ?? [];
      const stock = nodes.some((n) => ["KSampler", "CheckpointLoaderSimple", "UNETLoader"].includes(n.type)) && !nodes.some((n) => String(n.type).startsWith("FP_"));
      if (!stock) return;
      try {
        const wf = await (await api.fetchApi("/workflow_templates/flexiprint/01-origin-set.json")).json();
        await app.loadGraphData(wf);
      } catch (e) {
        console.warn("[flexiprint] starter template", e);
      }
    }, 1200);
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
