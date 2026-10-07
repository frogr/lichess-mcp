/**
 * Small, polite client for the public Lichess APIs.
 *
 * - Sends a descriptive User-Agent. (Lichess answers some endpoints, like the
 *   user game export, with a 404 page when the User-Agent looks like curl.)
 * - One request at a time per host, as the Lichess API docs ask.
 * - After a 429, waits out a full minute before calling that host again and
 *   fails fast in the meantime, again as the docs ask.
 * - Timeouts on every request, retries with backoff on 5xx / network errors.
 * - Short in-memory cache so an agent re-asking the same thing is free.
 * - Optional LICHESS_TOKEN (personal API token) is sent as a Bearer token.
 */
import { LichessError } from "./errors.js";
import { readNdjson } from "./ndjson.js";

export const LICHESS = "https://lichess.org";
export const TABLEBASE = "https://tablebase.lichess.org";
export const EXPLORER = "https://explorer.lichess.org";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface LichessClientOptions {
  token?: string;
  timeoutMs?: number;
  maxRetries?: number;
  cacheTtlMs?: number;
  /** How long to back off a host after a 429. Lichess asks for 60s. */
  rateLimitCooldownMs?: number;
  fetch?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  userAgent?: string;
}

export interface RequestOptions {
  accept?: string;
  /** Return null on 404 instead of throwing (e.g. "no cloud eval for this position"). */
  nullOn404?: boolean;
  /** Message used when a 404 should be an error. */
  notFound?: string;
  notFoundHint?: string;
  /** Whether to attach the token (only where it helps). */
  auth?: boolean;
}

const RETRYABLE = new Set([500, 502, 503, 504]);
const CACHE_MAX_ENTRIES = 200;
export const DEFAULT_USER_AGENT = "lichess-mcp/0.1 (+https://github.com/frogr/lichess-mcp)";

export class LichessClient {
  readonly hasToken: boolean;
  private readonly token?: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly cacheTtlMs: number;
  private readonly cooldownMs: number;
  private readonly fetchImpl: FetchLike;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly userAgent: string;
  private readonly cache = new Map<string, { expires: number; value: unknown }>();
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly blockedUntil = new Map<string, number>();

  constructor(opts: LichessClientOptions = {}) {
    this.token = opts.token || undefined;
    this.hasToken = Boolean(this.token);
    // Ignore a missing, zero or non-numeric timeout (e.g. a typo in LICHESS_TIMEOUT_MS).
    this.timeoutMs = Number.isFinite(opts.timeoutMs) && opts.timeoutMs! > 0 ? opts.timeoutMs! : 15_000;
    this.maxRetries = opts.maxRetries ?? 2;
    this.cacheTtlMs = opts.cacheTtlMs ?? 60_000;
    this.cooldownMs = opts.rateLimitCooldownMs ?? 60_000;
    this.fetchImpl = opts.fetch ?? ((input, init) => fetch(input, init));
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = opts.now ?? Date.now;
    this.userAgent = opts.userAgent ?? DEFAULT_USER_AGENT;
  }

  /** GET a JSON document. Returns null on 404 when `nullOn404` is set. */
  async getJson<T>(url: string, opts: RequestOptions = {}): Promise<T | null> {
    return this.cached(`json ${url}`, () =>
      this.request(url, { ...opts, accept: opts.accept ?? "application/json" }, async (res) => (res ? ((await res.json()) as T) : null)),
    );
  }

  /** GET an NDJSON stream and read at most `max` objects. */
  async getNdjson<T>(url: string, max: number, opts: RequestOptions = {}): Promise<T[]> {
    const out = await this.cached(`ndjson ${url}`, () =>
      this.request(url, { ...opts, accept: "application/x-ndjson" }, async (res) => (res ? readNdjson<T>(res.body, max) : [])),
    );
    return out ?? [];
  }

  private async cached<T>(key: string, load: () => Promise<T>): Promise<T> {
    const hit = this.cache.get(key);
    if (hit && hit.expires > this.now()) return hit.value as T;
    const value = await load();
    if (this.cacheTtlMs > 0) {
      if (this.cache.size >= CACHE_MAX_ENTRIES) {
        const oldest = this.cache.keys().next().value;
        if (oldest !== undefined) this.cache.delete(oldest);
      }
      this.cache.set(key, { expires: this.now() + this.cacheTtlMs, value });
    }
    return value;
  }

  /** Serialize requests per host: one in flight at a time. */
  private enqueue<T>(host: string, task: () => Promise<T>): Promise<T> {
    const prev = this.queues.get(host) ?? Promise.resolve();
    const run = prev.then(task, task);
    // Keep the chain alive regardless of this task's outcome.
    this.queues.set(
      host,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    return run;
  }

  private request<T>(url: string, opts: RequestOptions, read: (res: Response | null) => Promise<T>): Promise<T> {
    const host = new URL(url).host;
    return this.enqueue(host, async () => {
      const blocked = this.blockedUntil.get(host);
      if (blocked && blocked > this.now()) {
        const secs = Math.ceil((blocked - this.now()) / 1000);
        throw new LichessError(
          `Lichess (${host}) rate-limited this server recently; pausing requests for another ${secs}s.`,
          429,
          "Wait about a minute and try again. Lichess asks API clients to back off for a full minute after a 429.",
        );
      }

      const headers: Record<string, string> = { Accept: opts.accept ?? "application/json", "User-Agent": this.userAgent };
      if (this.token && opts.auth !== false) headers.Authorization = `Bearer ${this.token}`;

      let attempt = 0;
      for (;;) {
        let res: Response;
        try {
          res = await this.fetchImpl(url, { headers, signal: AbortSignal.timeout(this.timeoutMs) });
        } catch (err) {
          const isTimeout = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
          if (!isTimeout && attempt < this.maxRetries) {
            await this.sleep(backoff(attempt++));
            continue;
          }
          throw isTimeout
            ? new LichessError(`${host} did not respond within ${Math.round(this.timeoutMs / 1000)}s.`, undefined, "Retry in a moment.")
            : new LichessError(`Network error contacting ${host}: ${err instanceof Error ? err.message : String(err)}`, undefined, "Check connectivity, then retry.");
        }

        if (res.ok) return read(res);

        if (res.status === 404 && opts.nullOn404) {
          await res.body?.cancel().catch(() => {});
          return read(null);
        }

        if (RETRYABLE.has(res.status) && attempt < this.maxRetries) {
          await res.body?.cancel().catch(() => {});
          await this.sleep(backoff(attempt++));
          continue;
        }

        if (res.status === 429) this.blockedUntil.set(host, this.now() + this.cooldownMs);
        throw await toLichessError(res, host, opts, this.hasToken);
      }
    });
  }
}

function backoff(attempt: number): number {
  return Math.min(500 * 2 ** attempt, 4_000);
}

async function toLichessError(res: Response, host: string, opts: RequestOptions, hasToken: boolean): Promise<LichessError> {
  let detail: string | undefined;
  try {
    const text = await res.text();
    const body = JSON.parse(text) as { error?: string };
    detail = typeof body.error === "string" ? body.error : undefined;
  } catch {
    /* HTML or empty body */
  }
  switch (res.status) {
    case 400:
      return new LichessError(`Lichess rejected the request${detail ? `: ${detail}` : "."}`, 400, "Check the inputs (FEN, move list, ids).");
    case 401:
    case 403:
      return new LichessError(
        `${host} requires authentication for this endpoint.`,
        res.status,
        hasToken
          ? "LICHESS_TOKEN was sent but refused. Create a new personal token at https://lichess.org/account/oauth/token and set LICHESS_TOKEN."
          : "Set LICHESS_TOKEN to a personal API token from https://lichess.org/account/oauth/token (no scopes needed).",
      );
    case 404:
      return new LichessError(opts.notFound ?? `Not found on ${host}.`, 404, opts.notFoundHint ?? "Check the id or username spelling.");
    case 429:
      return new LichessError(
        `Rate limited by ${host}.`,
        429,
        hasToken ? "Wait a full minute before retrying." : "Wait a full minute before retrying. Setting LICHESS_TOKEN raises some limits.",
      );
    default:
      return new LichessError(
        `${host} returned an error${detail ? `: ${detail}` : "."}`,
        res.status,
        res.status >= 500 ? "Lichess is having trouble; retry shortly." : "Check the request parameters.",
      );
  }
}

// ---- Response types (the subset we read) ----

export interface LichessPerf {
  games?: number;
  rating?: number;
  rd?: number;
  prog?: number;
  prov?: boolean;
  runs?: number;
  score?: number;
}

export interface LichessUser {
  id: string;
  username: string;
  title?: string;
  disabled?: boolean;
  tosViolation?: boolean;
  closed?: boolean;
  patron?: boolean;
  verified?: boolean;
  createdAt?: number;
  seenAt?: number;
  url?: string;
  perfs?: Record<string, LichessPerf>;
  profile?: { bio?: string; realName?: string; flag?: string; location?: string; fideRating?: number; links?: string };
  count?: { all?: number; rated?: number; win?: number; loss?: number; draw?: number };
  playTime?: { total?: number; tv?: number };
}

export interface LichessPlayerSide {
  user?: { name: string; id: string; title?: string };
  aiLevel?: number;
  rating?: number;
  ratingDiff?: number;
  provisional?: boolean;
  analysis?: { inaccuracy: number; mistake: number; blunder: number; acpl: number; accuracy?: number };
}

export interface LichessAnalysisEntry {
  eval?: number;
  mate?: number;
  best?: string;
  variation?: string;
  judgment?: { name: "Inaccuracy" | "Mistake" | "Blunder"; comment: string };
}

export interface LichessGame {
  id: string;
  rated: boolean;
  variant: string;
  speed: string;
  perf: string;
  createdAt: number;
  lastMoveAt?: number;
  status: string;
  source?: string;
  players: { white: LichessPlayerSide; black: LichessPlayerSide };
  winner?: "white" | "black";
  opening?: { eco: string; name: string; ply: number };
  moves?: string;
  clocks?: number[];
  pgn?: string;
  analysis?: LichessAnalysisEntry[];
  clock?: { initial: number; increment: number; totalTime?: number };
  daysPerTurn?: number;
  initialFen?: string;
  division?: { middle?: number; end?: number };
}

export interface LichessPuzzle {
  game: {
    id: string;
    perf?: { key: string; name: string };
    rated?: boolean;
    players?: Array<{ name: string; id?: string; color: "white" | "black"; rating?: number; title?: string }>;
    pgn: string;
    clock?: string;
  };
  puzzle: {
    id: string;
    rating: number;
    plays: number;
    solution: string[];
    themes: string[];
    initialPly: number;
    fen?: string;
    lastMove?: string;
  };
}

export interface CloudEval {
  fen: string;
  knodes: number;
  depth: number;
  pvs: Array<{ moves: string; cp?: number; mate?: number }>;
}

export interface TablebaseMove {
  uci: string;
  san: string;
  category: string;
  dtz: number | null;
  precise_dtz?: number | null;
  dtm: number | null;
  zeroing?: boolean;
  checkmate: boolean;
  stalemate: boolean;
  insufficient_material: boolean;
}

export interface TablebaseResponse {
  category: string;
  dtz: number | null;
  precise_dtz?: number | null;
  dtm: number | null;
  checkmate: boolean;
  stalemate: boolean;
  insufficient_material: boolean;
  moves: TablebaseMove[];
}

export interface ExplorerResponse {
  opening?: { eco: string; name: string } | null;
  white: number;
  draws: number;
  black: number;
  moves: Array<{
    uci: string;
    san: string;
    averageRating?: number;
    white: number;
    draws: number;
    black: number;
    opening?: { eco: string; name: string } | null;
  }>;
}
