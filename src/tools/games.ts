import { z } from "zod";
import { formatScore, replaySan, START_FEN, whiteWinPercent, type ReplayedPly } from "../chess.js";
import { ToolInputError } from "../errors.js";
import { LICHESS, type LichessAnalysisEntry, type LichessClient, type LichessGame, type LichessPlayerSide } from "../lichess.js";
import { ENGINE_RULE, gameIdSchema, iso, ok, scoreOutput } from "./common.js";
import { sideName, timeControl } from "./recentGames.js";

// ---------------------------------------------------------------------------
// Shared fetch
// ---------------------------------------------------------------------------

export async function fetchGame(client: LichessClient, id: string): Promise<LichessGame> {
  const url = new URL(`${LICHESS}/game/export/${encodeURIComponent(id)}`);
  for (const p of ["evals", "clocks", "opening", "accuracy", "pgnInJson", "division"]) url.searchParams.set(p, "true");
  url.searchParams.set("literate", "false");
  return (await client.getJson<LichessGame>(url.toString(), {
    notFound: `No Lichess game with id '${id}'.`,
    notFoundHint: "Game ids are the 8 characters after lichess.org/ in the game URL. Use recent_games to list a player's games.",
  }))!;
}

export function sanMoves(g: LichessGame): string[] {
  return (g.moves ?? "").split(/\s+/).filter(Boolean);
}

/** Replay the game with chess.js when it is a variant chess.js understands. */
export function replayGame(g: LichessGame): ReplayedPly[] | undefined {
  if (!["standard", "chess960", "fromPosition"].includes(g.variant)) return undefined;
  return replaySan(sanMoves(g), g.initialFen ?? START_FEN);
}

function score(e: LichessAnalysisEntry | undefined) {
  if (!e) return undefined;
  const s = { ...(typeof e.eval === "number" ? { cp: e.eval } : {}), ...(typeof e.mate === "number" ? { mate: e.mate } : {}) };
  if (s.cp === undefined && s.mate === undefined) return undefined;
  return { ...s, display: formatScore(s) };
}

function resultString(g: LichessGame): string {
  if (g.status === "started" || g.status === "created") return "*";
  if (g.winner === "white") return "1-0";
  if (g.winner === "black") return "0-1";
  return "1/2-1/2";
}

/** Drop {comments} (evals, clocks) from Lichess PGN and tidy the move numbers they leave behind. */
export function cleanPgn(pgn: string): string {
  const [headers, ...rest] = pgn.split(/\n\n/);
  const movetext = rest
    .join(" ")
    .replace(/\{[^}]*\}/g, " ")
    .replace(/\b\d+\.\.\.\s*/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return `${headers}\n\n${movetext}\n`;
}

function moveLabel(p: { moveNumber: number; color: "white" | "black"; san: string }): string {
  return `${p.moveNumber}${p.color === "white" ? "." : "..."} ${p.san}`;
}

const playerOut = z.object({
  name: z.string(),
  title: z.string().optional(),
  rating: z.number().optional(),
  rating_change: z.number().optional(),
  accuracy: z.number().optional().describe("Lichess accuracy %, from server analysis."),
  acpl: z.number().optional().describe("Average centipawn loss, from server analysis."),
  inaccuracies: z.number().optional(),
  mistakes: z.number().optional(),
  blunders: z.number().optional(),
});

function playerSummary(side: LichessPlayerSide) {
  const a = side.analysis;
  return {
    name: sideName(side),
    ...(side.user?.title ? { title: side.user.title } : {}),
    ...(typeof side.rating === "number" ? { rating: side.rating } : {}),
    ...(typeof side.ratingDiff === "number" ? { rating_change: side.ratingDiff } : {}),
    ...(a
      ? {
          ...(typeof a.accuracy === "number" ? { accuracy: a.accuracy } : {}),
          acpl: a.acpl,
          inaccuracies: a.inaccuracy,
          mistakes: a.mistake,
          blunders: a.blunder,
        }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// get_game
// ---------------------------------------------------------------------------

export const getGameInput = {
  game_id: gameIdSchema,
  include_pgn: z.boolean().default(true).describe("Include the PGN text (headers + moves, no comments)."),
};

export const getGameOutput = {
  id: z.string(),
  url: z.string(),
  date: z.string().optional(),
  speed: z.string(),
  variant: z.string(),
  rated: z.boolean(),
  time_control: z.string().optional(),
  status: z.string(),
  result: z.string().describe('"1-0", "0-1", "1/2-1/2", or "*" if unfinished.'),
  winner: z.enum(["white", "black"]).optional(),
  players: z.object({ white: playerOut, black: playerOut }),
  opening: z.object({ eco: z.string(), name: z.string() }).optional(),
  has_analysis: z.boolean(),
  phases: z
    .object({ middlegame_starts_at_ply: z.number().optional(), endgame_starts_at_ply: z.number().optional() })
    .optional(),
  moves: z.array(
    z.object({
      ply: z.number(),
      move: z.string().describe('Numbered SAN, e.g. "12... Qe7".'),
      san: z.string(),
      uci: z.string().optional(),
      clock_seconds: z.number().optional().describe("Mover's clock after the move."),
      eval: scoreOutput.optional().describe("Lichess server-analysis evaluation after this move (White's view)."),
      judgment: z.enum(["inaccuracy", "mistake", "blunder"]).optional(),
    }),
  ),
  pgn: z.string().optional(),
  note: z.string(),
};

export async function getGame(client: LichessClient, args: { game_id: string; include_pgn: boolean }) {
  const g = await fetchGame(client, args.game_id);
  const sans = sanMoves(g);
  const replay = replayGame(g);
  const analysis = g.analysis;

  const moves = sans.map((san, i) => {
    const r = replay?.[i];
    const color: "white" | "black" = r?.color ?? (i % 2 === 0 ? "white" : "black");
    const moveNumber = r?.moveNumber ?? Math.floor(i / 2) + 1;
    const a = analysis?.[i];
    const sc = score(a);
    const clock = g.clocks?.[i];
    return {
      ply: i + 1,
      move: moveLabel({ moveNumber, color, san }),
      san,
      ...(r ? { uci: r.uci } : {}),
      ...(typeof clock === "number" ? { clock_seconds: Math.round(clock) / 100 } : {}),
      ...(sc ? { eval: sc } : {}),
      ...(a?.judgment ? { judgment: a.judgment.name.toLowerCase() as "inaccuracy" | "mistake" | "blunder" } : {}),
    };
  });

  return ok({
    id: g.id,
    url: `${LICHESS}/${g.id}`,
    date: iso(g.createdAt),
    speed: g.speed,
    variant: g.variant,
    rated: g.rated,
    time_control: timeControl(g),
    status: g.status,
    result: resultString(g),
    ...(g.winner ? { winner: g.winner } : {}),
    players: { white: playerSummary(g.players.white), black: playerSummary(g.players.black) },
    ...(g.opening ? { opening: { eco: g.opening.eco, name: g.opening.name } } : {}),
    has_analysis: Boolean(analysis?.length),
    ...(g.division && (g.division.middle || g.division.end)
      ? { phases: { middlegame_starts_at_ply: g.division.middle, endgame_starts_at_ply: g.division.end } }
      : {}),
    moves,
    ...(args.include_pgn && g.pgn ? { pgn: cleanPgn(g.pgn) } : {}),
    note: analysis?.length
      ? "Per-move evals come from Lichess's server analysis (Stockfish). Use find_mistakes for the flagged moves with best alternatives."
      : `This game has no Lichess computer analysis, so there are no per-move evals. ${ENGINE_RULE}`,
  });
}

export const getGameDescription =
  "Fetch one Lichess game: players, ratings, result, opening, time control, every move in SAN with clock times, and per-move engine evals and judgments when Lichess has analysed the game. Includes clean PGN.";

// ---------------------------------------------------------------------------
// find_mistakes
// ---------------------------------------------------------------------------

const SEVERITY = { inaccuracy: 1, mistake: 2, blunder: 3 } as const;

export const findMistakesInput = {
  game_id: gameIdSchema,
  for_player: z
    .string()
    .trim()
    .min(1)
    .max(30)
    .describe('Whose mistakes to list: a username in the game, or "white" / "black".'),
  min_severity: z
    .enum(["inaccuracy", "mistake", "blunder"])
    .default("inaccuracy")
    .describe("Smallest judgment to include (default inaccuracy = everything Lichess flagged)."),
};

const mistakeOut = z.object({
  ply: z.number(),
  move: z.string().describe('Numbered SAN of the move played, e.g. "28... Nxe5".'),
  judgment: z.enum(["inaccuracy", "mistake", "blunder"]),
  played: z.object({ san: z.string(), uci: z.string().optional() }),
  best: z.object({ san: z.string().optional(), uci: z.string().optional() }).describe("Lichess's engine choice in that position."),
  best_line: z.array(z.string()).describe("Engine line starting with the best move, SAN, up to 8 plies."),
  eval_before: scoreOutput.optional(),
  eval_after: scoreOutput.optional(),
  win_chance_before: z.number().optional().describe("Player's winning chances % before the move (Lichess formula on the engine eval)."),
  win_chance_after: z.number().optional(),
  win_chance_lost: z.number().optional(),
  fen_before: z.string().optional().describe("Position before the mistake; pass to evaluate_position to dig deeper."),
  lichess_comment: z.string(),
});

export const findMistakesOutput = {
  game_id: z.string(),
  url: z.string(),
  player: z.object({ name: z.string(), color: z.enum(["white", "black"]) }),
  analysis_available: z.boolean(),
  summary: z
    .object({
      accuracy: z.number().optional(),
      acpl: z.number().optional(),
      inaccuracies: z.number(),
      mistakes: z.number(),
      blunders: z.number(),
    })
    .optional(),
  mistakes: z.array(mistakeOut),
  message: z.string(),
};

type FindArgs = { game_id: string; for_player: string; min_severity: keyof typeof SEVERITY };

export function resolveColor(g: LichessGame, who: string): "white" | "black" {
  const w = who.toLowerCase();
  if (w === "white" || w === "black") return w;
  if (g.players.white.user?.id === w) return "white";
  if (g.players.black.user?.id === w) return "black";
  throw new ToolInputError(
    `'${who}' did not play in game ${g.id}. Players: ${sideName(g.players.white)} (white), ${sideName(g.players.black)} (black). Pass one of those names, or "white"/"black".`,
  );
}

export async function findMistakes(client: LichessClient, args: FindArgs) {
  const g = await fetchGame(client, args.game_id);
  const color = resolveColor(g, args.for_player);
  const side = g.players[color];
  const base = {
    game_id: g.id,
    url: `${LICHESS}/${g.id}${color === "black" ? "/black" : ""}`,
    player: { name: sideName(side), color },
  };

  if (!g.analysis?.length) {
    return ok({
      ...base,
      analysis_available: false,
      mistakes: [],
      message:
        `Lichess has no computer analysis for this game, so there is no engine judgment of the moves. ` +
        `Anyone signed in to Lichess can request a free server analysis at ${LICHESS}/${g.id} ("Request a computer analysis"), then call find_mistakes again. ` +
        `Do not guess which moves were mistakes: language models are unreliable at this.`,
    });
  }

  const replay = replayGame(g);
  const sans = sanMoves(g);
  const analysis = g.analysis;
  const min = SEVERITY[args.min_severity];
  const pov = (w: number | undefined) => (w === undefined ? undefined : color === "white" ? w : Math.round((100 - w) * 10) / 10);

  const mistakes = [];
  for (let i = 0; i < analysis.length; i++) {
    const a = analysis[i]!;
    if (!a.judgment) continue;
    const moverColor: "white" | "black" = replay?.[i]?.color ?? (i % 2 === 0 ? "white" : "black");
    if (moverColor !== color) continue;
    const judgment = a.judgment.name.toLowerCase() as keyof typeof SEVERITY;
    if (SEVERITY[judgment] < min) continue;

    const r = replay?.[i];
    const before = score(analysis[i - 1]);
    const after = score(a);
    const wBefore = pov(before ? whiteWinPercent(before) : undefined);
    const wAfter = pov(after ? whiteWinPercent(after) : undefined);
    const line = (a.variation ?? "").split(/\s+/).filter(Boolean);
    const san = sans[i] ?? "?";

    mistakes.push({
      ply: i + 1,
      move: moveLabel({ moveNumber: r?.moveNumber ?? Math.floor(i / 2) + 1, color: moverColor, san }),
      judgment,
      played: { san, ...(r ? { uci: r.uci } : {}) },
      best: { ...(line[0] ? { san: line[0] } : {}), ...(a.best ? { uci: a.best } : {}) },
      best_line: line.slice(0, 8),
      ...(before ? { eval_before: before } : {}),
      ...(after ? { eval_after: after } : {}),
      ...(wBefore !== undefined ? { win_chance_before: wBefore } : {}),
      ...(wAfter !== undefined ? { win_chance_after: wAfter } : {}),
      ...(wBefore !== undefined && wAfter !== undefined ? { win_chance_lost: Math.round((wBefore - wAfter) * 10) / 10 } : {}),
      ...(r ? { fen_before: r.fenBefore } : {}),
      lichess_comment: a.judgment.comment,
    });
  }

  const s = side.analysis;
  return ok({
    ...base,
    analysis_available: true,
    ...(s
      ? {
          summary: {
            ...(typeof s.accuracy === "number" ? { accuracy: s.accuracy } : {}),
            acpl: s.acpl,
            inaccuracies: s.inaccuracy,
            mistakes: s.mistake,
            blunders: s.blunder,
          },
        }
      : {}),
    mistakes,
    message:
      mistakes.length === 0
        ? `Lichess's analysis flagged no ${args.min_severity === "inaccuracy" ? "inaccuracies, mistakes or blunders" : `${args.min_severity}s or worse`} for ${base.player.name}.`
        : `${mistakes.length} move(s) flagged by Lichess's server analysis (Stockfish). Evals are White's view; win chances are ${base.player.name}'s. ${ENGINE_RULE}`,
  });
}

export const findMistakesDescription =
  "List one player's inaccuracies, mistakes and blunders in a Lichess game, straight from Lichess's server analysis: the move played, the engine's best move and line, evals before/after and winning chances lost. If the game was never analysed, it says so instead of guessing.";
