/**
 * Small helpers shared by the server modules that read loose JSON (agent tasks, MCP tools).
 */

import { NextResponse } from "next/server";

export function jsonError(error: string, status: number): NextResponse {
  return NextResponse.json({ error }, { status });
}

export function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

export const record = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});

export const clip = (t: string, n: number) => (t.length > n ? `${t.slice(0, n)}…` : t);
