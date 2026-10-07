import { z } from "zod";
import { normalizeFen, replaySan, sideToMove, uciLineToSan, uciToSan } from "../chess.js";
import { LICHESS, type LichessClient, type LichessPuzzle } from "../lichess.js";
import { ok } from "./common.js";

export const puzzleOfTheDayInput = {
  reveal_solution: z
    .boolean()
    .default(false)
    .describe("Include the solution moves. Leave false to coach: let the player try first, then call again with true."),
};

export const getPuzzleInput = {
  id: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9]{5}$/, "Puzzle ids are 5 letters/digits, e.g. uFTip.")
    .describe('Lichess puzzle id (5 characters, e.g. "uFTip"), as in lichess.org/training/uFTip.'),
  ...puzzleOfTheDayInput,
};

export const puzzleOutput = {
  id: z.string(),
  url: z.string(),
  rating: z.number(),
  plays: z.number(),
  themes: z.array(z.string()).describe('Lichess theme tags, e.g. "fork", "mateIn2", "endgame".'),
  fen: z.string().describe("The position the solver faces (after the opponent's last move)."),
  solver_color: z.enum(["white", "black"]),
  last_move: z.object({ san: z.string().optional(), uci: z.string() }).optional().describe("The opponent's move that set up the puzzle."),
  solver_moves: z.number().describe("How many moves the solver must find."),
  solution_revealed: z.boolean(),
  hint: z.string().optional().describe("A small nudge (which piece moves first) for when the player is stuck. Present only while the solution is hidden."),
  solution: z
    .object({
      uci: z.array(z.string()),
      san: z.array(z.string()),
      numbered: z.string().describe('e.g. "27... e4 28. Nf6+ Qxf6"'),
    })
    .optional()
    .describe("Full forced line, solver and opponent moves alternating. Only present when reveal_solution is true."),
  source_game: z.object({
    id: z.string(),
    url: z.string(),
    speed: z.string().optional(),
    white: z.string().optional(),
    black: z.string().optional(),
  }),
  message: z.string(),
};

export function shapePuzzle(p: LichessPuzzle, reveal: boolean) {
  const { puzzle, game } = p;
  // Replay the source game to the puzzle start. The replayed FEN has real move
  // numbers and castling rights; the API's own fen (when present) resets them
  // to "- - 0 1". Use the replay when both agree on the board and side to move.
  const sans = game.pgn.split(/\s+/).filter(Boolean);
  const replay = replaySan(sans);
  const last = replay.length === sans.length ? replay.at(-1) : undefined;
  const samePosition = (a: string, b: string) => a.split(" ").slice(0, 2).join(" ") === b.split(" ").slice(0, 2).join(" ");
  const fen = normalizeFen(last && (!puzzle.fen || samePosition(last.fenAfter, puzzle.fen)) ? last.fenAfter : (puzzle.fen ?? ""));
  const solver = sideToMove(fen);
  const lastMoveUci = puzzle.lastMove ?? last?.uci;
  const lastMoveSan = last && last.uci === lastMoveUci ? last.san : undefined;

  const san = uciLineToSan(fen, puzzle.solution);
  const startNumber = Number(fen.split(" ")[5] ?? 1);
  const numbered = san
    .map((m, i) => {
      const white = (solver === "white") === (i % 2 === 0);
      const n = startNumber + Math.floor((i + (solver === "black" ? 1 : 0)) / 2);
      if (white) return `${n}. ${m}`;
      return i === 0 ? `${n}... ${m}` : m;
    })
    .join(" ");

  const white = game.players?.find((x) => x.color === "white");
  const black = game.players?.find((x) => x.color === "black");
  const solverMoves = Math.ceil(puzzle.solution.length / 2);
  const firstPiece = firstMovePiece(fen, puzzle.solution[0]);

  return {
    id: puzzle.id,
    url: `${LICHESS}/training/${puzzle.id}`,
    rating: puzzle.rating,
    plays: puzzle.plays,
    themes: puzzle.themes,
    fen,
    solver_color: solver,
    ...(lastMoveUci ? { last_move: { ...(lastMoveSan ? { san: lastMoveSan } : {}), uci: lastMoveUci } } : {}),
    solver_moves: solverMoves,
    solution_revealed: reveal,
    ...(!reveal && firstPiece ? { hint: `The first move is a ${firstPiece} move.` } : {}),
    ...(reveal ? { solution: { uci: puzzle.solution, san, numbered } } : {}),
    source_game: {
      id: game.id,
      url: `${LICHESS}/${game.id}`,
      speed: game.perf?.name,
      white: white ? `${white.name}${white.rating ? ` (${white.rating})` : ""}` : undefined,
      black: black ? `${black.name}${black.rating ? ` (${black.rating})` : ""}` : undefined,
    },
    message: reveal
      ? "Solution from Lichess. The solver's moves are the 1st, 3rd, 5th... moves of the line; the others are the opponent's forced replies."
      : `${solver === "white" ? "White" : "Black"} to move and find ${solverMoves} move(s). Solution hidden: ask the player for a move first, use the themes and then the hint if they are stuck, and call again with reveal_solution=true to check their answer. Do not work out the solution yourself.`,
  };
}

function firstMovePiece(fen: string, uci: string | undefined): string | undefined {
  if (!uci) return undefined;
  const san = uciToSan(fen, uci);
  if (!san) return undefined;
  if (san.startsWith("O-O")) return "king";
  return { K: "king", Q: "queen", R: "rook", B: "bishop", N: "knight" }[san[0]!] ?? "pawn";
}

export async function puzzleOfTheDay(client: LichessClient, args: { reveal_solution: boolean }) {
  const p = (await client.getJson<LichessPuzzle>(`${LICHESS}/api/puzzle/daily`))!;
  return ok(shapePuzzle(p, args.reveal_solution));
}

export async function getPuzzle(client: LichessClient, args: { id: string; reveal_solution: boolean }) {
  const p = (await client.getJson<LichessPuzzle>(`${LICHESS}/api/puzzle/${encodeURIComponent(args.id)}`, {
    notFound: `No Lichess puzzle with id '${args.id}'.`,
    notFoundHint: "Puzzle ids are the 5 characters after lichess.org/training/.",
  }))!;
  return ok(shapePuzzle(p, args.reveal_solution));
}

export const puzzleOfTheDayDescription =
  "Today's Lichess daily puzzle: position (FEN), side to move, rating, themes and the source game. The solution stays hidden unless reveal_solution=true, so a coach can let the player try first.";

export const getPuzzleDescription =
  "Fetch a Lichess puzzle by id: position (FEN), side to move, rating, themes and source game. The solution stays hidden unless reveal_solution=true.";
