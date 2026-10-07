---
name: flexiprint-layer-rules
description: Use when building or changing anything in FlexiPrint that composes a design from swappable layers (character parts, hair back/front, linked options, clipart import/fit, region items) — strict pixel-registration rules that code and data must never break.
---

# Layered art — pixel-registration rules (mandatory)

Source of truth: `customize-tool/server/mcp/layer-rules.ts` (served to agents as `flexiprint://guide/layer-rules`).
Read it before touching layered-art code. Code consequences:

- Never auto-trim, auto-fit, re-centre or rescale a clipart by its alpha when it goes into a layer slot. Items of a
  slot share the slot's box; a per-item transform breaks registration.
- Files of one slot must have identical pixel size — validate on import and say which file differs.
- A part both behind and in front (hair) = two slots, same box; the back slot is LINKED to the front slot (follows
  its choice by group name + index), never a customer choice.
- Fixed z-order per product; an option never changes depth.
- Point / polygon outlines are for the product shape (khuôn vật liệu, cut lines) only — never for cutting character
  parts.
- AI-made parts: in-place edit on the master canvas, extract on that canvas; never generate standalone and scale in.

Background: research of macorner's dress-up products (2026-10-07). Every option file is the full master canvas;
hair = full "back" layer + "front" layer with the face/neck erased, the back one following the front choice.
