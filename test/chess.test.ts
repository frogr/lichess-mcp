import { describe, expect, it } from "vitest";
import {
  formatScore,
  normalizeFen,
  parseMoveList,
  pieceCount,
  replaySan,
  sideToMove,
  uciLineToSan,
  uciToSan,
  whiteWinPercent,
} from "../src/chess.js";
import { ToolInputError } from "../src/errors.js";
import { AFTER_E4, KPK, START } from "./helpers.js";

describe("FEN validation", () => {
  it("accepts a full FEN unchanged", () => {
    expect(normalizeFen(START)).toBe(START);
  });

  it("accepts the lichess.org URL form and fills in missing move counters", () => {
    expect(normalizeFen("rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR_b_KQkq_-")).toBe(AFTER_E4);
    expect(normalizeFen("  4k3/8/4K3/4P3/8/8/8/8   w - - 0  ")).toBe(KPK);
  });

  it.each([
    ["not a fen", /Invalid FEN/],
    ["rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP w KQkq - 0 1", /Invalid FEN/], // 7 ranks
    ["rnbqkbnr/pppppppp/9/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1", /Invalid FEN/], // 9 squares
    ["rnbqqbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1", /Invalid FEN/], // no black king
    ["rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR x KQkq - 0 1", /Invalid FEN/], // bad side to move
  ])("rejects %s", (fen, msg) => {
    expect(() => normalizeFen(fen)).toThrow(ToolInputError);
    expect(() => normalizeFen(fen)).toThrow(msg);
  });

  it("counts pieces and reads the side to move", () => {
    expect(pieceCount(START)).toBe(32);
    expect(pieceCount(KPK)).toBe(3);
    expect(sideToMove(AFTER_E4)).toBe("black");
    expect(sideToMove(KPK)).toBe("white");
  });
});

describe("UCI to SAN", () => {
  it("converts single moves, captures, checks and promotions", () => {
    expect(uciToSan(START, "g1f3")).toBe("Nf3");
    expect(uciToSan("4k3/8/8/3p4/4P3/8/8/4K3 w - - 0 1", "e4d5")).toBe("exd5");
    expect(uciToSan("4k3/P7/8/8/8/8/8/4K3 w - - 0 1", "a7a8q")).toBe("a8=Q+");
    expect(uciToSan("4k3/P7/8/8/8/8/8/4K3 w - - 0 1", "a7a8n")).toBe("a8=N");
  });

  it("understands both castling forms (Lichess engines write king-takes-rook)", () => {
    const fen = "r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1";
    expect(uciToSan(fen, "e1g1")).toBe("O-O");
    expect(uciToSan(fen, "e1h1")).toBe("O-O");
    expect(uciToSan(fen, "e1a1")).toBe("O-O-O");
  });

  it("returns undefined for illegal or malformed moves instead of inventing notation", () => {
    expect(uciToSan(START, "e2e5")).toBeUndefined();
    expect(uciToSan(START, "e7e5")).toBeUndefined(); // wrong side
    expect(uciToSan(START, "zz99")).toBeUndefined();
  });

  it("converts a cloud-eval line and stops at the first illegal move", () => {
    expect(uciLineToSan(AFTER_E4, "e7e5 g1f3 b8c6 f1b5 g8f6 e1h1 f6e4")).toEqual(["e5", "Nf3", "Nc6", "Bb5", "Nf6", "O-O", "Nxe4"]);
    expect(uciLineToSan(AFTER_E4, ["e7e5", "g1f3", "e5e3", "b8c6"])).toEqual(["e5", "Nf3"]);
  });
});

describe("move lists", () => {
  it("reads SAN with move numbers, plain SAN, and UCI", () => {
    const want = { uci: ["e2e4", "c7c5", "g1f3"], san: ["e4", "c5", "Nf3"] };
    expect(parseMoveList("1. e4 c5 2. Nf3")).toMatchObject(want);
    expect(parseMoveList("e4 c5 Nf3")).toMatchObject(want);
    expect(parseMoveList("e2e4,c7c5,g1f3")).toMatchObject(want);
    expect(parseMoveList("1.e4 c5 2.Nf3 *").fen).toBe("rnbqkbnr/pp1ppppp/8/2p5/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2");
  });

  it("names the first illegal move", () => {
    expect(() => parseMoveList("e4 e5 Ke3")).toThrow(/Illegal or unreadable move "Ke3" after e4 e5/);
  });

  it("replays a game and records the FEN before every ply", () => {
    const plies = replaySan(["e4", "e5", "Nf3"]);
    expect(plies.map((p) => [p.ply, p.color, p.moveNumber, p.uci])).toEqual([
      [1, "white", 1, "e2e4"],
      [2, "black", 1, "e7e5"],
      [3, "white", 2, "g1f3"],
    ]);
    expect(plies[1]!.fenBefore).toBe(AFTER_E4);
  });
});

describe("score formatting (values always come from Lichess)", () => {
  it("formats centipawns and mates from White's view", () => {
    expect(formatScore({ cp: 22 })).toBe("+0.22");
    expect(formatScore({ cp: -150 })).toBe("-1.50");
    expect(formatScore({ mate: -3 })).toBe("#-3");
    expect(formatScore({})).toBeUndefined();
  });

  it("uses Lichess's win-chance curve, symmetric around 50%", () => {
    expect(whiteWinPercent({ cp: 0 })).toBe(50);
    expect(whiteWinPercent({ cp: 300 })! + whiteWinPercent({ cp: -300 })!).toBeCloseTo(100, 1);
    expect(whiteWinPercent({ mate: 2 })).toBe(whiteWinPercent({ cp: 5000 }));
    expect(whiteWinPercent({})).toBeUndefined();
  });
});
