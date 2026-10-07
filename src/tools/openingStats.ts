import { z } from "zod";
import { normalizeFen, parseMoveList, START_FEN } from "../chess.js";
import { LichessError, ToolInputError } from "../errors.js";
import { EXPLORER, type ExplorerResponse, type LichessClient } from "../lichess.js";
import { ok } from "./common.js";

export const openingStatsInput = {
  moves: z
    .string()
    .trim()
    .max(1000)
    .optional()
    .describe('Moves from the start (or from fen): SAN like "1. e4 c5 2. Nf3" or UCI like "e2e4 c7c5". Gives the opening name too.'),
  fen: z.string().trim().max(100).optional().describe("Start position in FEN. Omit for the normal starting position."),
  database: z
    .enum(["lichess", "masters"])
    .default("lichess")
    .describe("lichess = all rated Lichess games; masters = over-the-board games between 2200+ FIDE players."),
  speeds: z
    .array(z.enum(["ultraBullet", "bullet", "blitz", "rapid", "classical", "correspondence"]))
    .max(6)
    .optional()
    .describe("lichess database only: limit to these speeds."),
  ratings: z
    .array(z.union([z.literal(0), z.literal(1000), z.literal(1200), z.literal(1400), z.literal(1600), z.literal(1800), z.literal(2000), z.literal(2200), z.literal(2500)]))
    .max(9)
    .optional()
    .describe("lichess database only: rating buckets, e.g. [1600, 1800] for 1600-1999."),
};

const pct = z.number().describe("Percent of games.");

export const openingStatsOutput = {
  fen: z.string(),
  moves_san: z.array(z.string()),
  database: z.string(),
  opening: z.object({ eco: z.string(), name: z.string() }).optional(),
  total_games: z.number(),
  white_wins_pct: pct,
  draws_pct: pct,
  black_wins_pct: pct,
  next_moves: z.array(
    z.object({
      san: z.string(),
      uci: z.string(),
      games: z.number(),
      share_pct: pct.describe("Share of games in this position that continued with this move."),
      white_wins_pct: pct,
      draws_pct: pct,
      black_wins_pct: pct,
      average_rating: z.number().optional(),
      opening: z.string().optional(),
    }),
  ),
  message: z.string(),
};

type Args = {
  moves?: string;
  fen?: string;
  database: "lichess" | "masters";
  speeds?: string[];
  ratings?: number[];
};

const p = (n: number, total: number) => (total ? Math.round((n / total) * 1000) / 10 : 0);

export async function openingStats(client: LichessClient, args: Args) {
  if (!client.hasToken) {
    throw new LichessError(
      "The Lichess opening explorer now requires a signed-in token, and this server has no LICHESS_TOKEN set.",
      401,
      "The server operator can create a personal token (no scopes needed) at https://lichess.org/account/oauth/token and set it as LICHESS_TOKEN. Other tools work without it.",
    );
  }
  const startFen = args.fen ? normalizeFen(args.fen) : START_FEN;
  const parsed = args.moves ? parseMoveList(args.moves, startFen) : { uci: [], san: [], fen: startFen };
  if (parsed.uci.length > 60) throw new ToolInputError("At most 60 moves; the explorer has few games that deep anyway.");

  const url = new URL(`${EXPLORER}/${args.database}`);
  url.searchParams.set("fen", startFen);
  if (parsed.uci.length) url.searchParams.set("play", parsed.uci.join(","));
  url.searchParams.set("moves", "12");
  url.searchParams.set("topGames", "0");
  if (args.database === "lichess") {
    url.searchParams.set("recentGames", "0");
    if (args.speeds?.length) url.searchParams.set("speeds", args.speeds.join(","));
    if (args.ratings?.length) url.searchParams.set("ratings", args.ratings.join(","));
  }

  const res = (await client.getJson<ExplorerResponse>(url.toString()))!;
  const total = res.white + res.draws + res.black;
  const next = res.moves.map((m) => {
    const games = m.white + m.draws + m.black;
    return {
      san: m.san,
      uci: m.uci,
      games,
      share_pct: p(games, total),
      white_wins_pct: p(m.white, games),
      draws_pct: p(m.draws, games),
      black_wins_pct: p(m.black, games),
      ...(m.averageRating ? { average_rating: m.averageRating } : {}),
      ...(m.opening ? { opening: `${m.opening.eco} ${m.opening.name}` } : {}),
    };
  });

  return ok({
    fen: parsed.fen,
    moves_san: parsed.san,
    database: args.database,
    ...(res.opening ? { opening: { eco: res.opening.eco, name: res.opening.name } } : {}),
    total_games: total,
    white_wins_pct: p(res.white, total),
    draws_pct: p(res.draws, total),
    black_wins_pct: p(res.black, total),
    next_moves: next,
    message:
      total === 0
        ? "No games in this database reached this position."
        : "Statistics describe what people played and scored, not what is objectively best. Use evaluate_position for an engine view.",
  });
}

export const openingStatsDescription =
  "Opening explorer statistics for a position from the Lichess or Masters database: opening name, how often each next move was played, and White/draw/Black results. Takes a move list or FEN. Needs LICHESS_TOKEN on the server (Lichess now requires sign-in for the explorer).";
