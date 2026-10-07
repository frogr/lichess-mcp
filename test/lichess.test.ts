import { describe, expect, it } from "vitest";
import { LichessError } from "../src/errors.js";
import { DEFAULT_USER_AGENT, LICHESS, LichessClient } from "../src/lichess.js";
import { json, mockFetch, streamed, testClient } from "./helpers.js";

const URL_USER = `${LICHESS}/api/user/someone`;

describe("LichessClient", () => {
  it("sends a descriptive User-Agent, and the token only when one is set", async () => {
    const m = mockFetch([{ match: () => true, respond: () => json({ ok: 1 }) }]);
    await testClient(m.fetch).getJson(URL_USER);
    expect(m.calls[0]!.headers["User-Agent"]).toBe(DEFAULT_USER_AGENT);
    expect(m.calls[0]!.headers.Authorization).toBeUndefined();

    await testClient(m.fetch, { token: "lip_secret" }).getJson(URL_USER);
    expect(m.calls[1]!.headers.Authorization).toBe("Bearer lip_secret");

    await testClient(m.fetch, { token: "lip_secret" }).getJson(URL_USER, { auth: false });
    expect(m.calls[2]!.headers.Authorization).toBeUndefined();
  });

  it("returns null on 404 when asked (a cloud-eval miss is not an error)", async () => {
    const m = mockFetch([{ match: () => true, respond: () => json({ error: "No cloud evaluation available for that position" }, 404) }]);
    expect(await testClient(m.fetch).getJson(URL_USER, { nullOn404: true })).toBeNull();
  });

  it("turns other 404s into a readable error with a hint", async () => {
    const m = mockFetch([{ match: () => true, respond: () => json({ error: "Not found" }, 404) }]);
    const err = await testClient(m.fetch).getJson(URL_USER, { notFound: "No such player.", notFoundHint: "Check spelling." }).catch((e) => e);
    expect(err).toBeInstanceOf(LichessError);
    expect(err.toToolMessage()).toBe("No such player. (HTTP 404)\nHint: Check spelling.");
  });

  it("retries 5xx with backoff, then succeeds", async () => {
    let n = 0;
    const waits: number[] = [];
    const m = mockFetch([{ match: () => true, respond: () => (++n < 3 ? json({}, 503) : json({ ok: true })) }]);
    const c = testClient(m.fetch, { sleep: async (ms) => void waits.push(ms) });
    expect(await c.getJson(URL_USER)).toEqual({ ok: true });
    expect(waits).toEqual([500, 1000]);
  });

  it("after a 429, fails fast for a full minute without calling Lichess again", async () => {
    let t = 0;
    const m = mockFetch([{ match: () => true, respond: () => json({}, 429) }]);
    const c = testClient(m.fetch, { now: () => t });
    await expect(c.getJson(URL_USER)).rejects.toThrow(/Rate limited by lichess.org/);
    expect(m.calls).toHaveLength(1);

    t = 30_000;
    const err = await c.getJson(`${LICHESS}/api/puzzle/daily`).catch((e) => e);
    expect(err.message).toMatch(/pausing requests for another 30s/);
    expect(err.hint).toMatch(/full minute/);
    expect(m.calls).toHaveLength(1);

    // Other hosts are not blocked.
    await expect(c.getJson("https://tablebase.lichess.org/standard?fen=x")).rejects.toThrow(/tablebase.lichess.org/);
    expect(m.calls).toHaveLength(2);

    t = 61_000;
    await c.getJson(URL_USER).catch(() => {});
    expect(m.calls).toHaveLength(3);
  });

  it("explains 401s with how to get a token", async () => {
    const m = mockFetch([{ match: () => true, respond: () => new Response("<html>401</html>", { status: 401 }) }]);
    const err = await testClient(m.fetch).getJson("https://explorer.lichess.org/lichess").catch((e) => e);
    expect(err.status).toBe(401);
    expect(err.hint).toMatch(/LICHESS_TOKEN/);
  });

  it("times out slow requests", async () => {
    const hang = (_: string, init?: RequestInit) =>
      new Promise<Response>((_r, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason)));
    const c = new LichessClient({ fetch: hang, timeoutMs: 20, cacheTtlMs: 0 });
    await expect(c.getJson(URL_USER)).rejects.toThrow(/did not respond within/);
  });

  it("falls back to the default timeout when the configured one is not a positive number", async () => {
    const m = mockFetch([{ match: () => true, respond: () => json({ ok: 1 }) }]);
    for (const timeoutMs of [Number("abc"), 0, -5]) {
      await expect(testClient(m.fetch, { timeoutMs }).getJson(URL_USER)).resolves.toEqual({ ok: 1 });
    }
  });

  it("caches identical requests briefly", async () => {
    const m = mockFetch([{ match: () => true, respond: () => json({ ok: 1 }) }]);
    const c = new LichessClient({ fetch: m.fetch, cacheTtlMs: 60_000 });
    await c.getJson(URL_USER);
    await c.getJson(URL_USER);
    expect(m.calls).toHaveLength(1);
  });

  it("sends one request at a time per host", async () => {
    let inFlight = 0;
    let peak = 0;
    const slow = async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return json({ ok: 1 });
    };
    const c = testClient(slow);
    await Promise.all([1, 2, 3].map((i) => c.getJson(`${URL_USER}?i=${i}`)));
    expect(peak).toBe(1);
  });

  it("reads NDJSON streams up to max", async () => {
    const m = mockFetch([{ match: () => true, respond: () => streamed(['{"id":"a"}\n{"id"', ':"b"}\n{"id":"c"}\n']) }]);
    expect(await testClient(m.fetch).getNdjson(URL_USER, 2)).toEqual([{ id: "a" }, { id: "b" }]);
    expect(m.calls[0]!.headers.Accept).toBe("application/x-ndjson");
  });
});
