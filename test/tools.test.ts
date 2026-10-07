// Each tool against recorded Lichess responses (test/fixtures, recorded 2026-10-07).
// The mocked fetch throws on any URL it doesn't know, so nothing here touches the network.
import { describe, expect, it } from "vitest";
import { ToolInputError } from "../src/errors.js";
import { cleanPgn, findMistakes, getGame } from "../src/tools/games.js";
import { getPlayer } from "../src/tools/getPlayer.js";
import { openingStats } from "../src/tools/openingStats.js";
import { evaluatePosition, tablebase } from "../src/tools/positions.js";
import { getPuzzle, puzzleOfTheDay } from "../src/tools/puzzles.js";
import { recentGames } from "../src/tools/recentGames.js";
import { AFTER_E4, KPK, START, data, json, lichessRoutes, mockFetch, testClient } from "./helpers.js";

const client = (extra = {}) => {
  const m = mockFetch(lichessRoutes());
  return { c: testClient(m.fetch, extra), calls: m.calls };
};

describe("get_player", () => {
  it("summarizes ratings, most-played first, skipping speeds never played", async () => {
    const { c } = client();
    const p = data(await getPlayer(c, { username: "DrNykterstein" }));
    expect(p.username).toBe("DrNykterstein");
    expect(p.ratings[0]).toMatchObject({ perf: "bullet", rating: 3263, games: 9585, provisional: false });
    expect(p.ratings.find((r: any) => r.perf === "rapid")).toBeUndefined(); // 0 games
    expect(p.ratings.find((r: any) => r.perf === "ultraBullet")).toMatchObject({ provisional: true });
  });

  it("returns a clear error for unknown players", async () => {
    const { c } = client();
    await expect(getPlayer(c, { username: "nobody_here_1" })).rejects.toThrow(/No Lichess player named 'nobody_here_1'/);
  });
});

describe("recent_games", () => {
  it("reads the NDJSON export from the player's side of the board", async () => {
    const { c, calls } = client();
    const r = data(await recentGames(c, { username: "thibault", max: 5 }));
    expect(r.returned).toBe(5);
    const first = r.games[0];
    expect(first).toMatchObject({ id: "bKi4MXMJ", color: "black", result: "win", has_analysis: true, accuracy: { player: 72, opponent: 66 } });
    expect(first.url).toBe("https://lichess.org/bKi4MXMJ/black");
    expect(r.games.find((g: any) => g.id === "suiYKU4c")).toMatchObject({ has_analysis: false });
    expect(r.games.find((g: any) => g.id === "suiYKU4c").accuracy).toBeUndefined();

    const q = calls[0]!.url.searchParams;
    expect([q.get("max"), q.get("accuracy"), q.get("opening"), q.get("moves")]).toEqual(["5", "true", "true", "false"]);
  });
});

describe("get_game", () => {
  it("returns moves with clocks, server-analysis evals and judgments, and clean PGN", async () => {
    const { c } = client();
    const g = data(await getGame(c, { game_id: "bKi4MXMJ", include_pgn: true }));
    expect(g).toMatchObject({ id: "bKi4MXMJ", result: "0-1", winner: "black", has_analysis: true });
    expect(g.moves).toHaveLength(130);
    expect(g.moves[25]).toMatchObject({ ply: 26, move: "13... d4", uci: "d5d4", judgment: "blunder", eval: { cp: 301, display: "+3.01" } });
    expect(g.pgn).toContain('[Event "');
    expect(g.pgn).not.toMatch(/\{|%eval|%clk/);
    expect(g.note).toMatch(/server analysis/);
  });

  it("says plainly when a game has no analysis", async () => {
    const { c } = client();
    const g = data(await getGame(c, { game_id: "suiYKU4c", include_pgn: false }));
    expect(g.has_analysis).toBe(false);
    expect(g.pgn).toBeUndefined();
    expect(g.moves.every((m: any) => m.eval === undefined && m.judgment === undefined)).toBe(true);
    expect(g.note).toMatch(/no Lichess computer analysis/);
    expect(g.note).toMatch(/do not estimate one yourself/);
  });

  it("404s with a hint for unknown games", async () => {
    const { c } = client();
    await expect(getGame(c, { game_id: "zzzzzzzz", include_pgn: false })).rejects.toThrow(/No Lichess game with id 'zzzzzzzz'/);
  });

  it("strips eval and clock comments from PGN", () => {
    const pgn = '[White "a"]\n[Black "b"]\n\n1. e4 { [%eval 0.2] [%clk 0:03:00] } 1... e5 { [%clk 0:03:00] } 2. Nf3 *\n';
    expect(cleanPgn(pgn)).toBe('[White "a"]\n[Black "b"]\n\n1. e4 e5 2. Nf3 *\n');
  });
});

describe("find_mistakes", () => {
  it("lists only the chosen player's flagged moves, with Lichess's best move", async () => {
    const { c } = client();
    const r = data(await findMistakes(c, { game_id: "bKi4MXMJ", for_player: "Thibault", min_severity: "inaccuracy" }));
    expect(r.analysis_available).toBe(true);
    expect(r.player).toEqual({ name: "thibault", color: "black" });
    expect(r.summary).toEqual({ accuracy: 72, acpl: 72, inaccuracies: 4, mistakes: 2, blunders: 7 });
    expect(r.mistakes).toHaveLength(4 + 2 + 7);
    expect(r.mistakes.every((m: any) => m.ply % 2 === 0)).toBe(true); // black's plies

    const first = r.mistakes.find((m: any) => m.ply === 26);
    expect(first).toMatchObject({
      move: "13... d4",
      judgment: "blunder",
      played: { san: "d4", uci: "d5d4" },
      best: { san: "Qe7", uci: "d7e7" },
      eval_before: { cp: 69 },
      eval_after: { cp: 301 },
      win_chance_before: 43.7,
      win_chance_after: 24.8,
      win_chance_lost: 18.9,
      fen_before: "3r1rk1/pp1q1pbp/2n3p1/2Pppb2/1P2n3/PNP1PN2/1B2BPPP/2RQ1RK1 b - - 8 13",
      lichess_comment: "Blunder. Qe7 was best.",
    });
  });

  it("filters by severity and accepts white/black", async () => {
    const { c } = client();
    const r = data(await findMistakes(c, { game_id: "bKi4MXMJ", for_player: "white", min_severity: "blunder" }));
    expect(r.player.name).toBe("sasha2061");
    expect(r.mistakes).toHaveLength(7);
    expect(r.mistakes.every((m: any) => m.judgment === "blunder" && m.ply % 2 === 1)).toBe(true);
  });

  it("returns 'not available' for an unanalysed game instead of guessing", async () => {
    const { c } = client();
    const r = data(await findMistakes(c, { game_id: "suiYKU4c", for_player: "thibault", min_severity: "inaccuracy" }));
    expect(r.analysis_available).toBe(false);
    expect(r.mistakes).toEqual([]);
    expect(r.message).toMatch(/no computer analysis/);
    expect(r.message).toMatch(/Do not guess/);
  });

  it("rejects a player who wasn't in the game", async () => {
    const { c } = client();
    await expect(findMistakes(c, { game_id: "bKi4MXMJ", for_player: "magnus", min_severity: "inaccuracy" })).rejects.toThrow(
      /'magnus' did not play in game bKi4MXMJ. Players: sasha2061 \(white\), thibault \(black\)/,
    );
  });
});

describe("evaluate_position", () => {
  it("returns cloud-eval lines in SAN, castling included", async () => {
    const { c } = client();
    const r = data(await evaluatePosition(c, { fen: AFTER_E4.replace(/ /g, "_"), multi_pv: 3 }));
    expect(r).toMatchObject({ available: true, depth: 60, side_to_move: "black", fen: AFTER_E4 });
    expect(r.lines).toHaveLength(3);
    expect(r.lines[0]).toMatchObject({ rank: 1, eval: { cp: 22, display: "+0.22" }, best_move: { san: "e5", uci: "e7e5" } });
    expect(r.lines[0].line_san).toEqual(["e5", "Nf3", "Nc6", "Bb5", "Nf6", "O-O", "Nxe4", "Re1", "Nd6", "Nxe5"]);
  });

  it("says 'not available' on a cache miss and points at the tablebase for small endgames", async () => {
    const { c } = client();
    const r = data(await evaluatePosition(c, { fen: START, multi_pv: 1 }));
    expect(r.available).toBe(false);
    expect(r.lines).toEqual([]);
    expect(r.message).toMatch(/^Not available/);
    expect(r.message).toMatch(/Do not estimate/);

    const small = data(await evaluatePosition(c, { fen: KPK, multi_pv: 1 }));
    expect(small.message).toMatch(/3 pieces, so the tablebase tool/);
  });

  it("rejects an invalid FEN before calling Lichess", async () => {
    const { c, calls } = client();
    await expect(evaluatePosition(c, { fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP w KQkq - 0 1", multi_pv: 1 })).rejects.toThrow(ToolInputError);
    expect(calls).toHaveLength(0);
  });
});

describe("tablebase", () => {
  it("gives the exact result and ranks moves from the mover's side", async () => {
    const { c } = client();
    const r = data(await tablebase(c, { fen: KPK }));
    expect(r).toMatchObject({ pieces: 3, result: "win", dtz: 3, dtm: 21 });
    expect(r.verdict).toBe("White to move wins (mate in 11 moves with best play).");
    expect(r.moves[0]).toMatchObject({ san: "Kd6", uci: "e6d6", result_for_mover: "win", dtm_after: 20 });
    expect(r.moves.length).toBeLessThanOrEqual(8);
  });

  it("refuses positions with more than 7 pieces without calling Lichess", async () => {
    const { c, calls } = client();
    await expect(tablebase(c, { fen: START })).rejects.toThrow(/7 pieces or fewer .* this one has 32/);
    expect(calls).toHaveLength(0);
  });
});

describe("puzzles", () => {
  it("hides the solution by default but gives a one-piece hint", async () => {
    const { c } = client();
    const p = data(await puzzleOfTheDay(c, { reveal_solution: false }));
    expect(p).toMatchObject({ id: "uFTip", solver_color: "black", solver_moves: 5, solution_revealed: false, last_move: { san: "Nxd5", uci: "c3d5" } });
    expect(p.fen).toBe("1r1q1rk1/pb3pbp/5np1/3Np3/7P/4BB2/PPPQ1PP1/2KR3R b - - 0 14");
    expect(p.solution).toBeUndefined();
    expect(JSON.stringify(p)).not.toContain("e5e4");
    expect(p.hint).toBe("The first move is a pawn move.");
    expect(p.message).toMatch(/Do not work out the solution yourself/);
  });

  it("reveals the full line in SAN with move numbers when asked", async () => {
    const { c } = client();
    const p = data(await getPuzzle(c, { id: "uFTip", reveal_solution: true }));
    expect(p.hint).toBeUndefined();
    expect(p.solution.san).toEqual(["e4", "Nxf6+", "Qxf6", "Bd4", "Qxd4", "Qxd4", "Bxd4", "Rxd4", "exf3"]);
    expect(p.solution.numbered).toBe("14... e4 15. Nxf6+ Qxf6 16. Bd4 Qxd4 17. Qxd4 Bxd4 18. Rxd4 exf3");
  });

  it("404s unknown puzzles", async () => {
    const { c } = client();
    await expect(getPuzzle(c, { id: "zzzzz", reveal_solution: false })).rejects.toThrow(/No Lichess puzzle with id 'zzzzz'/);
  });
});

describe("opening_stats", () => {
  it("says it needs LICHESS_TOKEN, without calling Lichess, when none is set", async () => {
    const { c, calls } = client();
    const err = await openingStats(c, { moves: "e4 c5", database: "lichess" }).catch((e) => e);
    expect(err.status).toBe(401);
    expect(err.toToolMessage()).toMatch(/requires a signed-in token/);
    expect(err.hint).toMatch(/lichess.org\/account\/oauth\/token/);
    expect(calls).toHaveLength(0);
  });

  it("passes a refused token through as a clear error (recorded 401 page)", async () => {
    const { c } = client({ token: "lip_expired" });
    const err = await openingStats(c, { moves: "e4 c5", database: "lichess" }).catch((e) => e);
    expect(err.status).toBe(401);
    expect(err.hint).toMatch(/LICHESS_TOKEN was sent but refused/);
  });

  it("with a token, builds the explorer request and computes percentages", async () => {
    // Explorer response shape from the Lichess API docs; numbers are synthetic.
    const m = mockFetch([
      {
        match: (u) => u.host === "explorer.lichess.org",
        respond: () =>
          json({
            opening: { eco: "B20", name: "Sicilian Defense" },
            white: 450,
            draws: 100,
            black: 450,
            moves: [
              { uci: "g1f3", san: "Nf3", averageRating: 1900, white: 300, draws: 60, black: 240, opening: null },
              { uci: "b1c3", san: "Nc3", averageRating: 1850, white: 150, draws: 40, black: 210, opening: { eco: "B23", name: "Sicilian Defense: Closed" } },
            ],
          }),
      },
    ]);
    const c = testClient(m.fetch, { token: "lip_ok" });
    const r = data(await openingStats(c, { moves: "1. e4 c5", database: "lichess", speeds: ["blitz", "rapid"], ratings: [1600, 1800] }));
    expect(r).toMatchObject({ total_games: 1000, white_wins_pct: 45, draws_pct: 10, black_wins_pct: 45, moves_san: ["e4", "c5"] });
    expect(r.opening).toEqual({ eco: "B20", name: "Sicilian Defense" });
    expect(r.next_moves[0]).toMatchObject({ san: "Nf3", games: 600, share_pct: 60, white_wins_pct: 50, draws_pct: 10, black_wins_pct: 40 });
    expect(r.next_moves[1].opening).toBe("B23 Sicilian Defense: Closed");

    const call = m.calls[0]!;
    expect(call.url.pathname).toBe("/lichess");
    expect(call.url.searchParams.get("play")).toBe("e2e4,c7c5");
    expect(call.url.searchParams.get("speeds")).toBe("blitz,rapid");
    expect(call.url.searchParams.get("ratings")).toBe("1600,1800");
    expect(call.headers.Authorization).toBe("Bearer lip_ok");
  });

  it("rejects illegal move lists before calling Lichess", async () => {
    const m = mockFetch([]);
    const c = testClient(m.fetch, { token: "lip_ok" });
    await expect(openingStats(c, { moves: "e4 e4", database: "masters" })).rejects.toThrow(/Illegal or unreadable move "e4" after e4/);
  });
});
