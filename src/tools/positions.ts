import { z } from "zod";
import { formatScore, normalizeFen, pieceCount, sideToMove, uciLineToSan } from "../chess.js";
import { ToolInputError } from "../errors.js";
import { LICHESS, TABLEBASE, type CloudEval, type LichessClient, type TablebaseResponse } from "../lichess.js";
import { ENGINE_RULE, fenSchema, ok, scoreOutput } from "./common.js";

// ---------------------------------------------------------------------------
// evaluate_position (Lichess cloud eval)
// ---------------------------------------------------------------------------

export const evaluatePositionInput = {
  fen: fenSchema,
  multi_pv: z.number().int().min(1).max(3).default(1).describe("How many candidate lines (1-3)."),
};

export const evaluatePositionOutput = {
  fen: z.string(),
  side_to_move: z.enum(["white", "black"]),
  available: z.boolean().describe("False when Lichess has no cached cloud evaluation for this position."),
  source: z.string().optional(),
  depth: z.number().optional(),
  knodes: z.number().optional().describe("Thousands of nodes searched."),
  lines: z.array(
    z.object({
      rank: z.number(),
      eval: scoreOutput,
      best_move: z.object({ san: z.string().optional(), uci: z.string() }),
      line_san: z.array(z.string()).describe("Principal variation in SAN (up to 10 plies)."),
    }),
  ),
  message: z.string(),
};

export async function evaluatePosition(client: LichessClient, args: { fen: string; multi_pv: number }) {
  const fen = normalizeFen(args.fen);
  const url = new URL(`${LICHESS}/api/cloud-eval`);
  url.searchParams.set("fen", fen);
  url.searchParams.set("multiPv", String(args.multi_pv));
  const res = await client.getJson<CloudEval>(url.toString(), { nullOn404: true });
  const stm = sideToMove(fen);

  if (!res) {
    const pieces = pieceCount(fen);
    return ok({
      fen,
      side_to_move: stm,
      available: false,
      lines: [],
      message:
        "Not available: Lichess's cloud cache has no evaluation for this position. The cache holds millions of positions people have analysed, but not every position. " +
        (pieces <= 7
          ? `This position has ${pieces} pieces, so the tablebase tool can give an exact result instead.`
          : `Open ${LICHESS}/analysis/${fen.replace(/ /g, "_")} to run Stockfish in the browser.`) +
        " Do not estimate the evaluation yourself.",
    });
  }

  const lines = res.pvs.map((pv, i) => {
    const uciMoves = pv.moves.trim().split(/\s+/);
    const san = uciLineToSan(fen, uciMoves.slice(0, 10));
    const s = { ...(typeof pv.cp === "number" ? { cp: pv.cp } : {}), ...(typeof pv.mate === "number" ? { mate: pv.mate } : {}) };
    return {
      rank: i + 1,
      eval: { ...s, display: formatScore(s) },
      best_move: { ...(san[0] ? { san: san[0] } : {}), uci: uciMoves[0]! },
      line_san: san,
    };
  });

  return ok({
    fen,
    side_to_move: stm,
    available: true,
    source: "Lichess cloud evaluation (Stockfish)",
    depth: res.depth,
    knodes: res.knodes,
    lines,
    message: `Depth ${res.depth}. Evals are from White's point of view. ${ENGINE_RULE}`,
  });
}

export const evaluatePositionDescription =
  "Get the engine evaluation of a chess position (FEN) from Lichess's cloud cache: score, best move and principal line in SAN, for up to 3 candidate moves. If the position isn't cached, it returns available=false rather than a guess.";

// ---------------------------------------------------------------------------
// tablebase
// ---------------------------------------------------------------------------

export const tablebaseInput = { fen: fenSchema };

const CATEGORY_TEXT: Record<string, string> = {
  win: "wins",
  loss: "loses",
  draw: "draws",
  "cursed-win": "wins on the board but the 50-move rule makes it a draw (cursed win)",
  "blessed-loss": "loses on the board but the 50-move rule saves it (blessed loss)",
  "maybe-win": "probably wins (exact distance unknown because of the 50-move counter)",
  "maybe-loss": "probably loses (exact distance unknown because of the 50-move counter)",
  "syzygy-win": "wins",
  "syzygy-loss": "loses",
  unknown: "is not in the tablebase",
};

/** A move's category is from the opponent's side after the move; flip it to the mover's. */
const FLIP: Record<string, string> = {
  win: "loss",
  loss: "win",
  draw: "draw",
  "cursed-win": "blessed-loss",
  "blessed-loss": "cursed-win",
  "maybe-win": "maybe-loss",
  "maybe-loss": "maybe-win",
  "syzygy-win": "syzygy-loss",
  "syzygy-loss": "syzygy-win",
  unknown: "unknown",
};

export const tablebaseOutput = {
  fen: z.string(),
  side_to_move: z.enum(["white", "black"]),
  pieces: z.number(),
  result: z.string().describe("For the side to move: win, loss, draw, cursed-win, blessed-loss, maybe-win, maybe-loss, unknown."),
  verdict: z.string().describe("One sentence, built from the tablebase result."),
  dtz: z.number().nullable().describe("Distance to zeroing move (capture or pawn move), in plies."),
  dtm: z.number().nullable().describe("Distance to mate in plies, when known (positive = side to move mates)."),
  checkmate: z.boolean(),
  stalemate: z.boolean(),
  insufficient_material: z.boolean(),
  moves: z.array(
    z.object({
      san: z.string(),
      uci: z.string(),
      result_for_mover: z.string().describe("Result for the side making this move if it is played."),
      dtz_after: z.number().nullable().describe("Plies to the next zeroing move after this move."),
      dtm_after: z.number().nullable().describe("Plies to mate after this move, when known."),
    }),
  ).describe("Legal moves, best first (as Lichess sorts them), up to 8."),
  source: z.string(),
};

export async function tablebase(client: LichessClient, args: { fen: string }) {
  const fen = normalizeFen(args.fen);
  const pieces = pieceCount(fen);
  if (pieces > 7) {
    throw new ToolInputError(`The tablebase covers positions with 7 pieces or fewer (kings included); this one has ${pieces}. Use evaluate_position instead.`);
  }
  const url = new URL(`${TABLEBASE}/standard`);
  url.searchParams.set("fen", fen);
  const tb = (await client.getJson<TablebaseResponse>(url.toString(), { auth: false }))!;
  const stm = sideToMove(fen);
  const Stm = stm === "white" ? "White" : "Black";

  let verdict: string;
  if (tb.checkmate) verdict = `${Stm} is checkmated.`;
  else if (tb.stalemate) verdict = `${Stm} is stalemated: draw.`;
  else if (tb.insufficient_material) verdict = "Draw by insufficient material.";
  else {
    verdict = `${Stm} to move ${CATEGORY_TEXT[tb.category] ?? tb.category}`;
    if (typeof tb.dtm === "number" && tb.dtm !== 0) verdict += ` (mate in ${Math.ceil(Math.abs(tb.dtm) / 2)} moves with best play)`;
    verdict += ".";
  }

  return ok({
    fen,
    side_to_move: stm,
    pieces,
    result: tb.category,
    verdict,
    dtz: tb.dtz ?? null,
    dtm: tb.dtm ?? null,
    checkmate: tb.checkmate,
    stalemate: tb.stalemate,
    insufficient_material: tb.insufficient_material,
    moves: tb.moves.slice(0, 8).map((m) => ({
      san: m.san,
      uci: m.uci,
      result_for_mover: FLIP[m.category] ?? m.category,
      dtz_after: m.dtz === null ? null : Math.abs(m.dtz),
      dtm_after: m.dtm === null ? null : Math.abs(m.dtm),
    })),
    source: "Lichess tablebase (Syzygy 7-piece, with DTM where available)",
  });
}

export const tablebaseDescription =
  "Exact result for an endgame with 7 or fewer pieces from the Lichess tablebase: win/draw/loss for the side to move, distance to mate or zeroing, and every move ranked. This is perfect play, not an estimate.";
