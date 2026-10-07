# Proof

What was checked, how, and what wasn't. Everything below was run on 2026-10-07 with Node v22.22.0. Numbers are copied from the command output shown.

## Tests (no network)

```
$ npm test
 Test Files  7 passed (7)
      Tests  95 passed (95)
```

| File | Tests | Covers |
| --- | --- | --- |
| `test/tools.test.ts` | 23 | Every tool against recorded Lichess responses, including each "not available" path: unanalysed game, cloud-eval miss, explorer without a token, refused token (recorded 401 page), tablebase with more than 7 pieces, unknown player / game / puzzle |
| `test/chess.test.ts` | 17 | FEN validation (URL form, missing counters, 5 kinds of invalid FEN), UCI to SAN (captures, promotion, both castling forms, illegal moves), cloud-eval line conversion stopping at the first illegal move, move-list parsing, score formatting, win-chance curve |
| `test/http.test.ts` | 16 | SDK client over a real socket, stateless JSON responses, CORS and allow list, 405/406/400/413 handling, 504 on slow upstream, per-IP rate limit and daily cap, `X-Forwarded-For` trust, `/health`, playground CSP, piece SVG route |
| `test/server.test.ts` | 15 | Full MCP protocol in memory: 9 tools listed with read-only annotations and output schemas, 10 tool calls validated against their output schemas by the SDK client, schema rejection before any request, error mapping |
| `test/lichess.test.ts` | 11 | User-Agent and token header, 404 handling, 5xx retry with backoff, 60-second cooldown after a 429 (per host), 401 hint, timeout, bad timeout config, cache, one request at a time per host, NDJSON reading |
| `test/rateLimit.test.ts` | 7 | Token bucket refill, per-key isolation, memory bound, daily cap reset at UTC midnight, env parsing |
| `test/ndjson.test.ts` | 6 | Recorded game export, lines split across chunks, multi-byte characters split across chunks, blank keep-alive lines, bad lines, early stop that cancels an endless stream |

Fixtures in `test/fixtures/` were recorded from the live Lichess API. The one opening-explorer success response in `tools.test.ts` is synthetic (it says so in the test), because the explorer returns 401 without a token.

## Build, start, smoke (no network)

```
$ npm run typecheck        # no output, exit 0
$ npm run build
$ node scripts/smoke.mjs
initialize -> {"name":"lichess","version":"0.1.0"} protocol 2025-06-18
tools/list -> 9 tools
SMOKE OK

$ node scripts/smoke-http.mjs
GET /health -> {"status":"ok","name":"lichess","version":"0.1.0","transport":"streamable-http","endpoint":"/mcp","uptime_s":0,"lichess_token":false,"limits":{"per_ip_per_minute":30,"daily_requests":5000,"daily_used":0}}
OPTIONS /mcp -> 204, allow-origin: *
POST /mcp initialize -> 200 {"name":"lichess","version":"0.1.0"} protocol 2025-06-18
POST /mcp tools/list -> 9 tools: get_player, recent_games, get_game, find_mistakes, evaluate_position, tablebase, puzzle_of_the_day, get_puzzle, opening_stats
GET /pieces/wN.svg -> 200 image/svg+xml
GET / -> 200, 41967 bytes, title: Lichess MCP
HTTP SMOKE OK

$ PORT=3999 npm start &
$ curl -s localhost:3999/health
{"status":"ok","name":"lichess","version":"0.1.0","transport":"streamable-http","endpoint":"/mcp","uptime_s":1,"lichess_token":false,"limits":{"per_ip_per_minute":30,"daily_requests":5000,"daily_used":0}}
$ curl -s -o /dev/null -w "GET / %{http_code}\n" localhost:3999/
GET / 200

$ npm audit
found 0 vulnerabilities
```

## Live Lichess (network)

The sandbox could reach lichess.org, tablebase.lichess.org and explorer.lichess.org.

**Stdio, real calls** (`node scripts/smoke.mjs --live`): `get_player thibault`, `evaluate_position` after 1. e4 (cloud eval at depth 70), and `tablebase` for a king and pawn ending ("White to move wins (mate in 11 moves with best play)") all returned without errors. `SMOKE OK`.

**HTTP, real calls** (`node scripts/smoke-http.mjs --live`): `recent_games` (498 ms) and `puzzle_of_the_day` (322 ms) through `POST /mcp`. `HTTP SMOKE OK`.

**Opening explorer needs auth now.** Without a token, both databases answer 401:

```
$ curl -s -o /dev/null -w "%{http_code}\n" -A "lichess-mcp/0.1 (+https://github.com/frogr/lichess-mcp)" "https://explorer.lichess.org/lichess?fen=rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR%20w%20KQkq%20-%200%201"
401
(same for /masters)
```

That is why `opening_stats` needs `LICHESS_TOKEN`.

### Live consistency check

`scripts/live-check.mjs` takes a player's recent games, runs `find_mistakes` on every analysed one, and checks this server's bookkeeping against Lichess's own data: the played move replays to the SAN Lichess recorded, our UCI-to-SAN of Lichess's best move matches the SAN in Lichess's comment ("Qe7 was best."), and Lichess's best line is legal from our `fen_before`. Then it asks `evaluate_position` about mistake positions, two seconds apart, and counts cache hits. It scores nothing itself.

```
$ node scripts/live-check.mjs thibault 20
thibault: 20 recent games, 12 with Lichess analysis, 8 without
flagged moves: 92
played move replays to Lichess's SAN: 92/92
best move UCI->SAN matches Lichess's comment: 92/92
best line legal from fen_before: 92/92
cloud eval for 15 mistake positions: 2 available, 13 not available
elapsed: 36.8s
LIVE CHECK OK

$ EVAL_SAMPLE=0 node scripts/live-check.mjs DrNykterstein 20
DrNykterstein: 20 recent games, 20 with Lichess analysis, 0 without
flagged moves: 83
played move replays to Lichess's SAN: 83/83
best move UCI->SAN matches Lichess's comment: 83/83
best line legal from fen_before: 83/83
cloud eval for 0 mistake positions: 0 available, 0 not available
elapsed: 9.5s
LIVE CHECK OK
```

Two things this showed:

- "Not available" is the common case, not an edge case. 8 of 20 recent games for one player had no analysis, and 13 of 15 real mistake positions were not in the cloud cache. The tools return that plainly.
- The cloud-eval endpoint rate-limits anonymous callers fast. An earlier run with no delay between requests hit a 429 before finishing, and a separate run at one request every 2 seconds was cut off after 13. The client handled both the way Lichess asks: it stopped calling lichess.org for 60 seconds and returned a clear error.

## Screenshots

Taken with `node scripts/screenshots.mjs thibault` (Playwright with the preinstalled Chromium, live Lichess data). Desktop at 1280x800, phone at 390x844 (device scale 2).

- `docs/screenshots/playground.png`: landing view
- `docs/screenshots/review.png`: thibault's recent games, first analysed game selected, mistake shown on the board with played (red) and Lichess's move (green)
- `docs/screenshots/review-not-analysed.png`: a game with no analysis, "Not available" message
- `docs/screenshots/puzzle.png`, `puzzle-solution.png`: puzzle of the day, hidden and revealed
- `docs/screenshots/connect.png`: client config tabs
- `docs/screenshots/phone.png`, `phone-review.png`, `phone-puzzle.png`: phone width

## Install from GitHub without npm

The package is not on npm. The README installs it with `npx -y github:frogr/lichess-mcp`, which works because a `prepare` script runs `npm run build` when npm installs from git. The GitHub repo wasn't public when this was checked, so the same path was tested from a local git URL with an empty npx cache:

```
$ rm -rf ~/.npm/_npx
$ echo '{"jsonrpc":"2.0","id":1,"method":"initialize",...}' | npx -y git+file:///home/claude/lichess-mcp
lichess-mcp running on stdio
{"result":{"protocolVersion":"2025-06-18",...,"serverInfo":{"name":"lichess","version":"0.1.0"},...}
```

First start took 14 s (clone, install, TypeScript build). Not checked: the same command against github.com, which needs the repo to be public.

## Piece images license

The 12 SVGs in `public/pieces/` are byte-identical to `public/piece/cburnett/` in the lichess-org/lila repository (each one compared with `curl -sSfL https://raw.githubusercontent.com/lichess-org/lila/master/public/piece/cburnett/<name>.svg | cmp - public/pieces/<name>.svg`: 12 identical). They are GPLv2+, so `public/pieces/LICENSE` has the attribution and the full GPLv2 text from gnu.org.

## Not verified

- `opening_stats` with a real token. There is no token here; the request shape is tested against a synthetic response built from the Lichess API docs, and the no-token and refused-token paths are tested against the real 401.
- Deployment to Render. `render.yaml` follows the Blueprint format and the same build and start commands were run locally, but nothing was deployed.
- The Docker image was not built (no Docker in the sandbox).
- Real clients (Claude Desktop, Claude Code, Cursor) were not connected. The official SDK client was, over stdio and over HTTP.
- No LLM is called by this server, so there is no API-key mode to test. Whether a model follows the "don't evaluate yourself" instruction depends on the client model; the server can only make the right data easy and the gap explicit.
- The package has not been published to npm. The README uses `npx -y github:frogr/lichess-mcp` until it is; `npx -y lichess-coach-mcp` will only work after publishing under that name.
