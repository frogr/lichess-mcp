/**
 * Chess helpers built on chess.js. These do bookkeeping only (legality,
 * notation, replaying moves). They never judge a position: evaluations come
 * from Lichess (cloud eval, server analysis) or the tablebase.
 */
import { Chess, validateFen, type Square } from "chess.js";
import { ToolInputError } from "./errors.js";

export const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

/**
 * Normalize and validate a FEN. Accepts the Lichess URL form with underscores
 * and fills in missing move counters. Throws ToolInputError with the reason.
 */
export function normalizeFen(input: string): string {
  let fen = input.trim().replace(/_/g, " ").replace(/\s+/g, " ");
  const parts = fen.split(" ");
  if (parts.length === 4) fen = `${fen} 0 1`;
  else if (parts.length === 5) fen = `${fen} 1`;
  const check = validateFen(fen);
  if (!check.ok) throw new ToolInputError(`Invalid FEN: ${check.error ?? "unknown problem"} (got "${input.slice(0, 100)}")`);
  // validateFen checks structure; constructing a game also checks things like kings in check on the wrong side.
  try {
    new Chess(fen);
  } catch (err) {
    throw new ToolInputError(`Invalid FEN: ${err instanceof Error ? err.message : String(err)}`);
  }
  return fen;
}

/** Number of pieces (including kings and pawns) on the board. */
export function pieceCount(fen: string): number {
  const board = fen.split(" ")[0] ?? "";
  return (board.match(/[prnbqk]/gi) ?? []).length;
}

export function sideToMove(fen: string): "white" | "black" {
  return fen.split(" ")[1] === "b" ? "black" : "white";
}

/**
 * Lichess engines write castling as king-takes-rook (e1h1, e8a8).
 * chess.js wants the king's destination (e1g1, e8c8).
 */
export function normalizeCastlingUci(game: Chess, uci: string): string {
  const from = uci.slice(0, 2) as Square;
  const to = uci.slice(2, 4) as Square;
  const piece = game.get(from);
  const target = game.get(to);
  if (piece?.type === "k" && target?.type === "r" && target.color === piece.color) {
    const file = to[0]! > from[0]! ? "g" : "c";
    return `${from}${file}${from[1]}`;
  }
  return uci;
}

/** Play one UCI move on `game` (mutates it) and return its SAN, or undefined if illegal. */
export function playUci(game: Chess, uci: string): string | undefined {
  if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(uci)) return undefined;
  const fixed = normalizeCastlingUci(game, uci);
  try {
    const move = game.move({ from: fixed.slice(0, 2), to: fixed.slice(2, 4), promotion: fixed[4] });
    return move.san;
  } catch {
    return undefined;
  }
}

/** Convert one UCI move to SAN in the given position. */
export function uciToSan(fen: string, uci: string): string | undefined {
  return playUci(new Chess(fen), uci);
}

/**
 * Convert a UCI line (array or space-separated) to SAN, stopping at the first
 * illegal move so a bad engine line can never produce made-up notation.
 */
export function uciLineToSan(fen: string, line: string[] | string): string[] {
  const moves = Array.isArray(line) ? line : line.trim().split(/\s+/).filter(Boolean);
  const game = new Chess(fen);
  const out: string[] = [];
  for (const uci of moves) {
    const san = playUci(game, uci);
    if (!san) break;
    out.push(san);
  }
  return out;
}

export interface ReplayedPly {
  ply: number; // 1-based
  san: string;
  uci: string;
  color: "white" | "black";
  moveNumber: number;
  fenBefore: string;
  fenAfter: string;
}

/** Replay SAN moves from a start position, recording the FEN around every ply. */
export function replaySan(sanMoves: string[], startFen = START_FEN): ReplayedPly[] {
  const game = new Chess(startFen);
  const out: ReplayedPly[] = [];
  for (const san of sanMoves) {
    const fenBefore = game.fen();
    let move;
    try {
      move = game.move(san);
    } catch {
      break; // Should not happen for Lichess games; stop rather than invent positions.
    }
    out.push({
      ply: out.length + 1,
      san: move.san,
      uci: `${move.from}${move.to}${move.promotion ?? ""}`,
      color: move.color === "w" ? "white" : "black",
      moveNumber: Number(fenBefore.split(" ")[5] ?? 1),
      fenBefore,
      fenAfter: game.fen(),
    });
  }
  return out;
}

/**
 * Parse a move list for the opening explorer: SAN ("e4 e5 Nf3", "1. e4 e5 2. Nf3")
 * or UCI ("e2e4 e7e5", "e2e4,e7e5"). Returns UCI moves and SAN, or throws
 * ToolInputError naming the first illegal move.
 */
export function parseMoveList(input: string, startFen = START_FEN): { uci: string[]; san: string[]; fen: string } {
  const tokens = input
    .replace(/,/g, " ")
    .replace(/\{[^}]*\}/g, " ")
    .split(/\s+/)
    .map((t) => t.replace(/^\d+\.(\.\.)?/, "").trim())
    .filter((t) => t && !/^(1-0|0-1|1\/2-1\/2|\*)$/.test(t));
  const game = new Chess(startFen);
  const uci: string[] = [];
  const san: string[] = [];
  for (const tok of tokens) {
    let move;
    if (/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(tok)) {
      const fixed = normalizeCastlingUci(game, tok);
      try {
        move = game.move({ from: fixed.slice(0, 2), to: fixed.slice(2, 4), promotion: fixed[4] });
      } catch {
        move = undefined;
      }
    } else {
      try {
        move = game.move(tok);
      } catch {
        move = undefined;
      }
    }
    if (!move) throw new ToolInputError(`Illegal or unreadable move "${tok}" after ${san.length ? san.join(" ") : "the start position"}.`);
    uci.push(`${move.from}${move.to}${move.promotion ?? ""}`);
    san.push(move.san);
  }
  return { uci, san, fen: game.fen() };
}

// ---- Evaluations (formatting only; values always come from Lichess) ----

export interface EngineScore {
  cp?: number;
  mate?: number;
}

/** "+1.16", "-0.15", "#3", "#-15". White's point of view, like Lichess. */
export function formatScore(s: EngineScore): string | undefined {
  if (typeof s.mate === "number") return `#${s.mate}`;
  if (typeof s.cp === "number") return `${s.cp >= 0 ? "+" : ""}${(s.cp / 100).toFixed(2)}`;
  return undefined;
}

/**
 * Lichess's own centipawn → win-chance curve (lila: WinPercent.scala), from
 * White's point of view, 0-100. Mate scores are treated as ±1000cp the way
 * lila does before applying the curve.
 */
export function whiteWinPercent(s: EngineScore): number | undefined {
  let cp: number;
  if (typeof s.mate === "number") cp = s.mate > 0 ? 1000 : -1000;
  else if (typeof s.cp === "number") cp = Math.max(-1000, Math.min(1000, s.cp));
  else return undefined;
  const winningChances = 2 / (1 + Math.exp(-0.00368208 * cp)) - 1;
  return Math.round((50 + 50 * winningChances) * 10) / 10;
}
