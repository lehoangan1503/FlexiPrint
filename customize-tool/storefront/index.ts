/**
 * Shopify storefront entry for `shopify/sections/main-product.liquid`.
 *
 * Bundled to `shopify/assets/ct-customizer.js` (scripts/build-storefront.mjs).
 * Boots every [data-ct-product] section: gallery + variant picker for any
 * product, and the customizer (storefront/customizer.ts) when the section
 * carries a template URL. The editor's "Xem trước" tab mounts the same
 * Customizer class on the draft design.
 */

import { drawComposite } from "../lib/compositor";
import { Customizer, initGallery, initVariants } from "./customizer";

function boot(): void {
  for (const root of Array.from(document.querySelectorAll<HTMLElement>("[data-ct-product]"))) {
    if (root.dataset.ctBooted) continue;
    root.dataset.ctBooted = "1";
    const form = root.querySelector<HTMLFormElement>("form[data-ct-form]");
    const { showMedia } = initGallery(root);
    if (!form) continue;
    initVariants(root, form, showMedia);
    const templateUrl = root.dataset.ctTemplateUrl;
    const uploadUrl = root.dataset.ctUploadUrl;
    // Themes published before photo styles lack data-ct-photo-url; it sits next to the upload endpoint.
    const photoUrl = root.dataset.ctPhotoUrl ?? uploadUrl?.replace("/public/uploads/", "/public/photo/");
    if (templateUrl && uploadUrl && photoUrl) void new Customizer(root, form, { template: templateUrl, uploadUrl, photoUrl }).start();
  }
}

// drawComposite is re-exported for themes that want to render elsewhere (e.g. a cart drawer).
const api = { boot, drawComposite };
declare global {
  interface Window {
    CtCustomizer?: typeof api;
  }
}
window.CtCustomizer = api;

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
else boot();
// Theme editor re-renders sections in place.
document.addEventListener("shopify:section:load", boot);
