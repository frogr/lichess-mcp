// Live consistency check against the real Lichess API.
//
//   npm run build && node scripts/live-check.mjs [username] [games]
//
// For a player's recent games, it runs find_mistakes on every analysed game and
// checks the server's bookkeeping against Lichess's own data:
//   1. Replaying the played move (UCI) on fen_before gives the SAN Lichess recorded.
//   2. Lichess's best move (UCI) on fen_before gives the SAN Lichess wrote in its comment.
//   3. The whole best line Lichess gave is legal from fen_before.
// Then it asks evaluate_position about each mistake position and reports how
// often the cloud cache had an answer (the rest must come back "not available").
// It never scores anything itself. Needs network; tests never run this.
import { Chess } from "chess.js";
import { LichessClient } from "../dist/lichess.js";
import { findMistakes } from "../dist/tools/games.js";
import { evaluatePosition } from "../dist/tools/positions.js";
import { recentGames } from "../dist/tools/recentGames.js";
import { uciToSan } from "../dist/chess.js";

const username = process.argv[2] ?? "thibault";
const max = Number(process.argv[3] ?? 20);
const client = new LichessClient({ token: process.env.LICHESS_TOKEN });

const t0 = Date.now();
const games = (await recentGames(client, { username, max })).structuredContent.games;
const analysed = games.filter((g) => g.has_analysis);
console.log(`${username}: ${games.length} recent games, ${analysed.length} with Lichess analysis, ${games.length - analysed.length} without`);

let flagged = 0;
let playedOk = 0;
let bestOk = 0;
let bestChecked = 0;
let linesOk = 0;
const positions = [];
const problems = [];

for (const g of analysed) {
  const r = await findMistakes(client, { game_id: g.id, for_player: username, min_severity: "inaccuracy" });
  if (r.isError) {
    problems.push(`${g.id}: ${r.content[0].text}`);
    continue;
  }
  for (const m of r.structuredContent.mistakes) {
    flagged++;
    if (m.fen_before) positions.push(m.fen_before);
    if (m.fen_before && m.played.uci && uciToSan(m.fen_before, m.played.uci) === m.played.san) playedOk++;
    else problems.push(`${g.id} ply ${m.ply}: played move did not replay`);
    // Lichess writes "Blunder. Qe7 was best." Compare our UCI->SAN with that SAN.
    const commentBest = m.lichess_comment.match(/(\S+) was best/)?.[1];
    if (commentBest && m.best.uci) {
      bestChecked++;
      if (uciToSan(m.fen_before, m.best.uci) === commentBest) bestOk++;
      else problems.push(`${g.id} ply ${m.ply}: best ${m.best.uci} -> ${uciToSan(m.fen_before, m.best.uci)} vs comment ${commentBest}`);
    }
    const board = new Chess(m.fen_before);
    try {
      for (const san of m.best_line) board.move(san);
      linesOk++;
    } catch {
      problems.push(`${g.id} ply ${m.ply}: best line not legal`);
    }
  }
}

console.log(`flagged moves: ${flagged}`);
console.log(`played move replays to Lichess's SAN: ${playedOk}/${flagged}`);
console.log(`best move UCI->SAN matches Lichess's comment: ${bestOk}/${bestChecked}`);
console.log(`best line legal from fen_before: ${linesOk}/${flagged}`);

// The cloud-eval endpoint rate-limits anonymous callers quickly, so go slowly
// and stop at the first 429 rather than hammer it.
const sample = positions.slice(0, Number(process.env.EVAL_SAMPLE ?? 15));
let hits = 0;
let misses = 0;
let asked = 0;
for (const fen of sample) {
  try {
    const r = await evaluatePosition(client, { fen, multi_pv: 1 });
    asked++;
    if (r.structuredContent.available) hits++;
    else misses++;
  } catch (err) {
    console.log(`cloud eval stopped after ${asked} positions: ${err.message}`);
    break;
  }
  await new Promise((r) => setTimeout(r, 2_000));
}
console.log(`cloud eval for ${asked} mistake positions: ${hits} available, ${misses} not available`);
console.log(`elapsed: ${((Date.now() - t0) / 1000).toFixed(1)}s`);
if (problems.length) {
  console.log(`problems (${problems.length}):`);
  for (const p of problems.slice(0, 20)) console.log(`  ${p}`);
  process.exitCode = 1;
} else {
  console.log("LIVE CHECK OK");
}
