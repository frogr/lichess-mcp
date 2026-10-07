import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { LichessClient } from "./lichess.js";
import { READ_ONLY_ANNOTATIONS, safe } from "./tools/common.js";
import {
  findMistakes,
  findMistakesDescription,
  findMistakesInput,
  findMistakesOutput,
  getGame,
  getGameDescription,
  getGameInput,
  getGameOutput,
} from "./tools/games.js";
import { getPlayer, getPlayerDescription, getPlayerInput, getPlayerOutput } from "./tools/getPlayer.js";
import { openingStats, openingStatsDescription, openingStatsInput, openingStatsOutput } from "./tools/openingStats.js";
import {
  evaluatePosition,
  evaluatePositionDescription,
  evaluatePositionInput,
  evaluatePositionOutput,
  tablebase,
  tablebaseDescription,
  tablebaseInput,
  tablebaseOutput,
} from "./tools/positions.js";
import {
  getPuzzle,
  getPuzzleDescription,
  getPuzzleInput,
  puzzleOfTheDay,
  puzzleOfTheDayDescription,
  puzzleOfTheDayInput,
  puzzleOutput,
} from "./tools/puzzles.js";
import { recentGames, recentGamesDescription, recentGamesInput, recentGamesOutput } from "./tools/recentGames.js";

export const SERVER_NAME = "lichess";
export const SERVER_VERSION = "0.1.0";

export const INSTRUCTIONS =
  "Tools for the public Lichess chess API. Rule: do not evaluate chess positions or moves yourself. " +
  "Language models are often confidently wrong about chess (illegal moves, missed tactics, invented evaluations). " +
  "Every evaluation must come from these tools: get_game / find_mistakes (Lichess server analysis), evaluate_position (Lichess cloud eval) " +
  "or tablebase (exact results for 7 pieces or fewer). When a tool says an evaluation is not available, tell the user that plainly instead of estimating. " +
  "For coaching: recent_games shows which games have analysis; find_mistakes lists the flagged moves; puzzles hide the solution until reveal_solution=true.";

export function createServer(client: LichessClient = new LichessClient({ token: process.env.LICHESS_TOKEN })): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, { instructions: INSTRUCTIONS });

  server.registerTool(
    "get_player",
    { title: "Lichess player profile and ratings", description: getPlayerDescription, inputSchema: getPlayerInput, outputSchema: getPlayerOutput, annotations: READ_ONLY_ANNOTATIONS },
    safe((args) => getPlayer(client, args)),
  );

  server.registerTool(
    "recent_games",
    { title: "A player's recent games", description: recentGamesDescription, inputSchema: recentGamesInput, outputSchema: recentGamesOutput, annotations: READ_ONLY_ANNOTATIONS },
    safe((args) => recentGames(client, args)),
  );

  server.registerTool(
    "get_game",
    { title: "One game with moves and evals", description: getGameDescription, inputSchema: getGameInput, outputSchema: getGameOutput, annotations: READ_ONLY_ANNOTATIONS },
    safe((args) => getGame(client, args)),
  );

  server.registerTool(
    "find_mistakes",
    { title: "Engine-flagged mistakes in a game", description: findMistakesDescription, inputSchema: findMistakesInput, outputSchema: findMistakesOutput, annotations: READ_ONLY_ANNOTATIONS },
    safe((args) => findMistakes(client, args)),
  );

  server.registerTool(
    "evaluate_position",
    { title: "Cloud engine evaluation of a position", description: evaluatePositionDescription, inputSchema: evaluatePositionInput, outputSchema: evaluatePositionOutput, annotations: READ_ONLY_ANNOTATIONS },
    safe((args) => evaluatePosition(client, args)),
  );

  server.registerTool(
    "tablebase",
    { title: "Exact endgame result (7 pieces or fewer)", description: tablebaseDescription, inputSchema: tablebaseInput, outputSchema: tablebaseOutput, annotations: READ_ONLY_ANNOTATIONS },
    safe((args) => tablebase(client, args)),
  );

  server.registerTool(
    "puzzle_of_the_day",
    { title: "Lichess daily puzzle", description: puzzleOfTheDayDescription, inputSchema: puzzleOfTheDayInput, outputSchema: puzzleOutput, annotations: READ_ONLY_ANNOTATIONS },
    safe((args) => puzzleOfTheDay(client, args)),
  );

  server.registerTool(
    "get_puzzle",
    { title: "Lichess puzzle by id", description: getPuzzleDescription, inputSchema: getPuzzleInput, outputSchema: puzzleOutput, annotations: READ_ONLY_ANNOTATIONS },
    safe((args) => getPuzzle(client, args)),
  );

  server.registerTool(
    "opening_stats",
    { title: "Opening explorer statistics", description: openingStatsDescription, inputSchema: openingStatsInput, outputSchema: openingStatsOutput, annotations: READ_ONLY_ANNOTATIONS },
    safe((args) => openingStats(client, args)),
  );

  return server;
}
