import { z } from "zod";
import { LICHESS, type LichessClient, type LichessGame, type LichessPlayerSide } from "../lichess.js";
import { iso, ok, usernameSchema } from "./common.js";

export const PERF_TYPES = [
  "ultraBullet",
  "bullet",
  "blitz",
  "rapid",
  "classical",
  "correspondence",
  "chess960",
  "crazyhouse",
  "antichess",
  "atomic",
  "horde",
  "kingOfTheHill",
  "racingKings",
  "threeCheck",
] as const;

export const recentGamesInput = {
  username: usernameSchema,
  max: z.number().int().min(1).max(20).default(10).describe("How many games (1-20, default 10). Most recent first."),
  perf_type: z.enum(PERF_TYPES).optional().describe("Only this speed or variant, e.g. blitz."),
  rated: z.boolean().optional().describe("true for rated only, false for casual only. Omit for both."),
};

const sideOut = z.object({
  name: z.string(),
  title: z.string().optional(),
  rating: z.number().optional(),
});

export const recentGameItem = z.object({
  id: z.string(),
  url: z.string(),
  date: z.string().optional().describe("Start time, ISO 8601 UTC."),
  speed: z.string(),
  variant: z.string(),
  rated: z.boolean(),
  time_control: z.string().optional().describe('"300+3" style, or "correspondence".'),
  color: z.enum(["white", "black"]).describe("Color the requested player had."),
  opponent: sideOut,
  player_rating: z.number().optional(),
  rating_change: z.number().optional(),
  result: z.enum(["win", "loss", "draw", "ongoing"]),
  status: z.string().describe("How it ended: mate, resign, outoftime, draw, stalemate, ..."),
  opening: z.object({ eco: z.string(), name: z.string() }).optional(),
  accuracy: z
    .object({ player: z.number(), opponent: z.number().optional() })
    .optional()
    .describe("Lichess accuracy % from its server analysis. Absent when the game was never analysed."),
  has_analysis: z.boolean().describe("True when Lichess has a computer analysis, so find_mistakes will work."),
});

export const recentGamesOutput = {
  username: z.string(),
  returned: z.number(),
  games: z.array(recentGameItem),
  note: z.string().optional(),
};

type Args = { username: string; max: number; perf_type?: (typeof PERF_TYPES)[number]; rated?: boolean };

export function sideName(side: LichessPlayerSide): string {
  if (side.user) return side.user.name;
  if (side.aiLevel) return `Stockfish level ${side.aiLevel}`;
  return "Anonymous";
}

export function timeControl(g: LichessGame): string | undefined {
  if (g.clock) return `${g.clock.initial}+${g.clock.increment}`;
  if (g.speed === "correspondence") return g.daysPerTurn ? `${g.daysPerTurn} day(s) per move` : "correspondence";
  return undefined;
}

export function resultFor(g: LichessGame, color: "white" | "black"): "win" | "loss" | "draw" | "ongoing" {
  if (g.status === "started" || g.status === "created") return "ongoing";
  if (!g.winner) return "draw";
  return g.winner === color ? "win" : "loss";
}

export async function recentGames(client: LichessClient, args: Args) {
  const url = new URL(`${LICHESS}/api/games/user/${encodeURIComponent(args.username)}`);
  url.searchParams.set("max", String(args.max));
  url.searchParams.set("moves", "false");
  url.searchParams.set("tags", "false");
  url.searchParams.set("opening", "true");
  url.searchParams.set("accuracy", "true");
  url.searchParams.set("finished", "true");
  if (args.perf_type) url.searchParams.set("perfType", args.perf_type);
  if (args.rated !== undefined) url.searchParams.set("rated", String(args.rated));

  const raw = await client.getNdjson<LichessGame>(url.toString(), args.max, {
    notFound: `No Lichess player named '${args.username}'.`,
    notFoundHint: "Check the spelling with get_player.",
  });

  const me = args.username.toLowerCase();
  const games = raw.map((g) => {
    const color: "white" | "black" = g.players.black.user?.id === me ? "black" : "white";
    const mine = g.players[color];
    const theirs = g.players[color === "white" ? "black" : "white"];
    const myAcc = mine.analysis?.accuracy;
    return {
      id: g.id,
      url: `${LICHESS}/${g.id}${color === "black" ? "/black" : ""}`,
      date: iso(g.createdAt),
      speed: g.speed,
      variant: g.variant,
      rated: g.rated,
      time_control: timeControl(g),
      color,
      opponent: {
        name: sideName(theirs),
        ...(theirs.user?.title ? { title: theirs.user.title } : {}),
        ...(typeof theirs.rating === "number" ? { rating: theirs.rating } : {}),
      },
      player_rating: mine.rating,
      rating_change: mine.ratingDiff,
      result: resultFor(g, color),
      status: g.status,
      ...(g.opening ? { opening: { eco: g.opening.eco, name: g.opening.name } } : {}),
      ...(typeof myAcc === "number" ? { accuracy: { player: myAcc, opponent: theirs.analysis?.accuracy } } : {}),
      has_analysis: Boolean(mine.analysis),
    };
  });

  return ok({
    username: args.username,
    returned: games.length,
    games,
    ...(games.length === 0 ? { note: "No finished games matched these filters." } : {}),
  });
}

export const recentGamesDescription =
  "List a Lichess player's most recent finished games (up to 20): id, date, speed, opponent and rating, result, opening name, and accuracy when Lichess has analysed the game. Use has_analysis to pick games that find_mistakes can review.";
