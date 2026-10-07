import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { LichessError, ToolInputError } from "../errors.js";

/** Successful result: JSON text for any client + structuredContent for clients that use outputSchema. */
export function ok<T extends Record<string, unknown>>(data: T): CallToolResult & { structuredContent: T } {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    structuredContent: data,
  };
}

/** Error result the model can read and act on, instead of a protocol-level failure. */
export function fail(err: unknown): CallToolResult {
  let text: string;
  if (err instanceof LichessError) text = err.toToolMessage();
  else if (err instanceof ToolInputError) text = `Invalid input: ${err.message}`;
  else text = `Unexpected error: ${err instanceof Error ? err.message : String(err)}`;
  return { isError: true, content: [{ type: "text", text }] };
}

/** Wrap a handler so every thrown error becomes a readable tool error. */
export function safe<A>(handler: (args: A) => Promise<CallToolResult>) {
  return async (args: A): Promise<CallToolResult> => {
    try {
      return await handler(args);
    } catch (err) {
      return fail(err);
    }
  };
}

export const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

// ---- Shared input schemas ----

export const usernameSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{1,29}$/, "Lichess usernames are 2-30 letters, digits, _ or -.")
  .describe('Lichess username, e.g. "thibault". Case does not matter.');

/** Accepts an 8-char game id, a 12-char player-specific id, or a lichess.org game URL. */
export const gameIdSchema = z
  .string()
  .trim()
  .transform((s) => {
    const fromUrl = s.match(/lichess\.org\/([A-Za-z0-9]{8})/);
    const id = fromUrl ? fromUrl[1]! : s;
    return /^[A-Za-z0-9]{12}$/.test(id) ? id.slice(0, 8) : id;
  })
  .pipe(z.string().regex(/^[A-Za-z0-9]{8}$/, "Game ids are 8 letters/digits, e.g. bKi4MXMJ (a lichess.org game URL also works)."))
  .describe('Lichess game id (8 characters, e.g. "bKi4MXMJ") or a lichess.org game URL.');

export const fenSchema = z
  .string()
  .trim()
  .min(15)
  .max(100)
  .describe('Position in FEN, e.g. "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1". Move counters may be omitted.');

// ---- Shared output pieces ----

export const scoreOutput = z.object({
  cp: z.number().optional().describe("Centipawns from White's point of view (100 = about one pawn)."),
  mate: z.number().optional().describe("Mate in N moves; positive means White mates, negative means Black mates."),
  display: z.string().optional().describe('Human form, e.g. "+0.22" or "#-3".'),
});

export function iso(ms: number | undefined): string | undefined {
  return typeof ms === "number" ? new Date(ms).toISOString() : undefined;
}

export function truncate(text: string | undefined | null, max: number): string | undefined {
  if (!text) return undefined;
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

/** The rule this server is built around, repeated where the model reads it. */
export const ENGINE_RULE =
  "Evaluations here come from Lichess's engines or the tablebase, never from a guess. If a tool says an evaluation is not available, do not estimate one yourself.";
