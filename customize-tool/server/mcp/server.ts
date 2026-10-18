/**
 * flexiprint-mcp — the FlexiPrint system as an MCP server (JSON-RPC 2.0 over streamable HTTP, stateless: one POST,
 * one JSON reply). POST /api/customize-tool/mcp.
 *
 *   Bearer CT_AGENT_TOKEN  → "agent": the @flexiprint agent on agent_ide — every tool, tasks included
 *   login cookie           → "user": a signed-in editor (Claude Code on their own machine…) — library reads
 *
 * Tools: server/mcp/tools.ts. Resources (how the system works, the writing rules): server/mcp/guide.ts.
 */

import { timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { ctServiceClient, ctSession } from "../supabase";
import { CT_MCP_RESOURCES } from "./guide";
import { CT_MCP_TOOLS, type CtMcpContext, type CtMcpOutput } from "./tools";

const PROTOCOL_VERSION = "2025-06-18";

const INSTRUCTIONS =
  "FlexiPrint clipart library (read-only) and web-app tasks. Read the resource flexiprint://guide/overview first (no resource support: the read_guide tool). Tasks from the web app (kind content | char): get_task → work → submit_result (or fail_task).";

interface RpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: { name?: string; arguments?: Record<string, unknown>; protocolVersion?: string; uri?: string };
}

interface RpcError {
  code: number;
  message: string;
}

type RpcReply = { jsonrpc: "2.0"; id: string | number | null } & ({ result: unknown } | { error: RpcError });

function bearerIs(req: NextRequest, secret: string | undefined): boolean {
  if (!secret) return false;
  const got = Buffer.from(req.headers.get("authorization") ?? "");
  const want = Buffer.from(`Bearer ${secret}`);
  return got.length === want.length && timingSafeEqual(got, want);
}

/** Who is calling, or null (401). */
export async function mcpContext(req: NextRequest): Promise<CtMcpContext | null> {
  if (bearerIs(req, process.env.CT_AGENT_TOKEN)) {
    const service = ctServiceClient();
    return service ? { db: service, service, caller: "agent" } : null;
  }
  const session = await ctSession();
  return session ? { db: session.supabase, service: null, caller: "user" } : null;
}

function toContent(out: CtMcpOutput): Record<string, unknown> {
  if ("images" in out) {
    return { content: out.images.flatMap((im) => [{ type: "text", text: im.url }, { type: "image", data: im.data, mimeType: im.mimeType }]) };
  }
  return { content: [{ type: "text", text: JSON.stringify(out.json) }] };
}

async function handleRpc(ctx: CtMcpContext, msg: RpcRequest): Promise<RpcReply | null> {
  const id = msg.id ?? null;
  const ok = (result: unknown): RpcReply => ({ jsonrpc: "2.0", id, result });
  const fail = (code: number, message: string): RpcReply => ({ jsonrpc: "2.0", id, error: { code, message } });
  // Notifications (no id) get no reply.
  if (msg.id === undefined) return null;
  const tools = CT_MCP_TOOLS.filter((t) => t.callers.includes(ctx.caller));
  switch (msg.method) {
    case "initialize":
      return ok({
        protocolVersion: msg.params?.protocolVersion ?? PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false }, resources: { listChanged: false } },
        serverInfo: { name: "flexiprint", version: "2.0.0" },
        instructions: INSTRUCTIONS,
      });
    case "ping":
      return ok({});
    case "tools/list":
      return ok({ tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
    case "tools/call": {
      const tool = tools.find((t) => t.name === msg.params?.name);
      if (!tool) return fail(-32602, `Unknown tool: ${msg.params?.name ?? ""}`);
      try {
        return ok(toContent(await tool.run(ctx, msg.params?.arguments ?? {})));
      } catch (e) {
        return ok({ content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }], isError: true });
      }
    }
    case "resources/list":
      return ok({ resources: CT_MCP_RESOURCES.map(({ uri, name, description }) => ({ uri, name, description, mimeType: "text/markdown" })) });
    case "resources/read": {
      const r = CT_MCP_RESOURCES.find((x) => x.uri === msg.params?.uri);
      return r ? ok({ contents: [{ uri: r.uri, mimeType: "text/markdown", text: r.text() }] }) : fail(-32602, `Unknown resource: ${msg.params?.uri ?? ""}`);
    }
    case "resources/templates/list":
      return ok({ resourceTemplates: [] });
    default:
      return fail(-32601, `Method not found: ${msg.method ?? ""}`);
  }
}

/** POST mcp — a JSON-RPC message or batch. GET is not offered (no server-initiated stream). */
export async function mcpEndpoint(req: NextRequest): Promise<NextResponse> {
  if (req.method !== "POST") return NextResponse.json({ error: "MCP: chỉ POST (JSON-RPC)" }, { status: 405 });
  const ctx = await mcpContext(req);
  if (!ctx) return NextResponse.json({ error: "Chưa đăng nhập" }, { status: 401 });
  const body: unknown = await req.json().catch(() => null);
  if (body === null || typeof body !== "object") {
    return NextResponse.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, { status: 400 });
  }
  const batch = Array.isArray(body);
  const msgs = (batch ? body : [body]) as RpcRequest[];
  const replies = (await Promise.all(msgs.map((m) => handleRpc(ctx, m)))).filter((r): r is RpcReply => r !== null);
  if (!replies.length) return new NextResponse(null, { status: 202 });
  return NextResponse.json(batch ? replies : replies[0]);
}
