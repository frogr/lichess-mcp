import { readFileSync } from "node:fs";
import { LichessClient, type LichessClientOptions } from "../src/lichess.js";

export function fixtureText(name: string): string {
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
}

export function fixture<T = unknown>(name: string): T {
  return JSON.parse(fixtureText(name)) as T;
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/** A response whose body arrives in the given chunks, like a slow NDJSON stream. */
export function streamed(chunks: string[], status = 200): Response {
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
  return new Response(body, { status, headers: { "content-type": "application/x-ndjson" } });
}

type Route = { match: (url: URL) => boolean; respond: (url: URL) => Response | Promise<Response> };

/**
 * A fetch stand-in that routes by URL and records every call.
 * Unmatched requests fail loudly so tests can never hit the network.
 */
export function mockFetch(routes: Route[]) {
  const calls: Array<{ url: URL; headers: Record<string, string> }> = [];
  const fn = async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
    const route = routes.find((r) => r.match(url));
    if (!route) throw new Error(`Unmocked request: ${url.toString()}`);
    return route.respond(url);
  };
  return { fetch: fn, calls };
}

/** Path matcher. Case-insensitive, like Lichess usernames. */
export const path = (p: string | RegExp) => (url: URL) => {
  const got = url.pathname.toLowerCase();
  return typeof p === "string" ? got === p.toLowerCase() : p.test(got);
};

/** Routes for every recorded fixture, keyed the way the tools call Lichess. */
export function lichessRoutes(): Route[] {
  return [
    { match: path("/api/user/thibault"), respond: () => json(fixtureText("user-thibault.json")) },
    { match: path("/api/user/drnykterstein"), respond: () => json(fixtureText("user-drnykterstein.json")) },
    { match: path(/^\/api\/user\//), respond: () => json(fixtureText("user-missing.json"), 404) },
    { match: path("/api/games/user/thibault"), respond: () => streamed([fixtureText("games-thibault.ndjson")]) },
    { match: path("/game/export/bKi4MXMJ"), respond: () => json(fixtureText("game-analysed.json")) },
    { match: path("/game/export/suiYKU4c"), respond: () => json(fixtureText("game-unanalysed.json")) },
    { match: path(/^\/game\/export\//), respond: () => json(fixtureText("game-missing.txt"), 404) },
    { match: path("/api/puzzle/daily"), respond: () => json(fixtureText("puzzle-daily.json")) },
    { match: path("/api/puzzle/uFTip"), respond: () => json(fixtureText("puzzle-uFTip.json")) },
    { match: path(/^\/api\/puzzle\//), respond: () => json({ error: "Not found" }, 404) },
    {
      match: (u) => u.pathname === "/api/cloud-eval" && u.searchParams.get("fen")!.startsWith("rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b"),
      respond: () => json(fixtureText("cloud-eval-e4.json")),
    },
    { match: path("/api/cloud-eval"), respond: () => json(fixtureText("cloud-eval-miss.json"), 404) },
    { match: (u) => u.host === "tablebase.lichess.org", respond: () => json(fixtureText("tablebase-kpk.json")) },
    {
      match: (u) => u.host === "explorer.lichess.org",
      respond: () => new Response(fixtureText("explorer-401.html"), { status: 401, headers: { "content-type": "text/html" } }),
    },
  ];
}

export function testClient(fetch: ReturnType<typeof mockFetch>["fetch"], extra: Partial<LichessClientOptions> = {}) {
  return new LichessClient({ fetch, cacheTtlMs: 0, sleep: async () => {}, ...extra });
}

/** Pull the structured payload out of a tool result. */
export function data<T = any>(result: { structuredContent?: unknown }): T {
  return result.structuredContent as T;
}

export const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
export const AFTER_E4 = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1";
export const KPK = "4k3/8/4K3/4P3/8/8/8/8 w - - 0 1";
