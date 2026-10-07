// End-to-end through the real MCP protocol layer (in-memory transport):
// tool listing, SDK-side zod validation, outputSchema validation, error mapping.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { createServer } from "../src/server.js";
import { AFTER_E4, KPK, lichessRoutes, mockFetch, testClient } from "./helpers.js";

const TOOLS = [
  "evaluate_position",
  "find_mistakes",
  "get_game",
  "get_player",
  "get_puzzle",
  "opening_stats",
  "puzzle_of_the_day",
  "recent_games",
  "tablebase",
];

async function connect(token?: string) {
  const m = mockFetch(lichessRoutes());
  const server = createServer(testClient(m.fetch, { token }));
  const client = new Client({ name: "test", version: "0.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return { client, calls: m.calls };
}

const text = (r: any) => r.content[0].text as string;

describe("MCP server", () => {
  it("lists nine read-only tools with input and output schemas", async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(TOOLS);
    for (const t of tools) {
      expect(t.description!.length).toBeGreaterThan(60);
      expect(t.inputSchema.type).toBe("object");
      expect(t.outputSchema).toBeDefined();
      expect(t.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, idempotentHint: true });
    }
  });

  it("tells the model not to do the chess itself", async () => {
    const { client } = await connect();
    expect(client.getInstructions()).toMatch(/do not evaluate chess positions or moves yourself/);
  });

  it.each([
    ["get_player", { username: "thibault" }],
    ["recent_games", { username: "thibault", max: 5 }],
    ["get_game", { game_id: "https://lichess.org/bKi4MXMJ/black" }],
    ["find_mistakes", { game_id: "bKi4MXMJ", for_player: "thibault" }],
    ["find_mistakes", { game_id: "suiYKU4c", for_player: "thibault" }],
    ["evaluate_position", { fen: AFTER_E4, multi_pv: 2 }],
    ["evaluate_position", { fen: KPK }],
    ["tablebase", { fen: KPK }],
    ["puzzle_of_the_day", {}],
    ["get_puzzle", { id: "uFTip", reveal_solution: true }],
  ])("%s returns structured content that matches its output schema", async (name, args) => {
    const { client } = await connect();
    // callTool validates structuredContent against the declared outputSchema and throws if it doesn't match.
    const res: any = await client.callTool({ name, arguments: args });
    expect(res.isError, text(res)).toBeFalsy();
    expect(res.structuredContent).toBeDefined();
    expect(JSON.parse(text(res))).toEqual(res.structuredContent);
  });

  it("accepts a lichess.org URL or a 12-character player id as a game id", async () => {
    const { client, calls } = await connect();
    await client.callTool({ name: "get_game", arguments: { game_id: "https://lichess.org/bKi4MXMJ/black" } });
    await client.callTool({ name: "get_game", arguments: { game_id: "bKi4MXMJabcd" } });
    expect(calls.map((c) => c.url.pathname)).toEqual(["/game/export/bKi4MXMJ", "/game/export/bKi4MXMJ"]);
  });

  it("rejects bad input at the schema, before any request", async () => {
    const { client, calls } = await connect();
    const bad: any = await client.callTool({ name: "get_player", arguments: { username: "../../etc" } });
    expect(bad.isError).toBe(true);
    expect(text(bad)).toMatch(/usernames are 2-30 letters/);
    const tooMany: any = await client.callTool({ name: "recent_games", arguments: { username: "thibault", max: 500 } });
    expect(tooMany.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("maps upstream and input errors to readable tool errors", async () => {
    const { client } = await connect();
    const fen: any = await client.callTool({ name: "tablebase", arguments: { fen: "8/8/8/8/8/8/8/8 w - - 0 1" } });
    expect(fen.isError).toBe(true);
    expect(text(fen)).toMatch(/^Invalid input: Invalid FEN/);

    const missing: any = await client.callTool({ name: "get_game", arguments: { game_id: "zzzzzzzz" } });
    expect(missing.isError).toBe(true);
    expect(text(missing)).toMatch(/No Lichess game with id 'zzzzzzzz'. \(HTTP 404\)\nHint:/);

    const explorer: any = await client.callTool({ name: "opening_stats", arguments: { moves: "e4" } });
    expect(explorer.isError).toBe(true);
    expect(text(explorer)).toMatch(/LICHESS_TOKEN/);
  });
});
