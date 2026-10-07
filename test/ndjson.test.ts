import { describe, expect, it } from "vitest";
import { NdjsonParseError, NdjsonParser, parseNdjson, readNdjson } from "../src/ndjson.js";
import { fixtureText, streamed } from "./helpers.js";

describe("NDJSON", () => {
  it("parses the recorded game export, one game per line", () => {
    const games = parseNdjson<{ id: string }>(fixtureText("games-thibault.ndjson"));
    expect(games.map((g) => g.id)).toEqual(["bKi4MXMJ", "sgLDzWna", "29nNSKqR", "KLc0KzAy", "suiYKU4c"]);
  });

  it("joins lines split across chunks and skips blank keep-alive lines", () => {
    const p = new NdjsonParser<{ a: number }>();
    expect(p.push('{"a":')).toEqual([]);
    expect(p.push('1}\n\n{"a"')).toEqual([{ a: 1 }]);
    expect(p.push(":2}\r\n   \n")).toEqual([{ a: 2 }]);
    expect(p.push('{"a":3}')).toEqual([]);
    expect(p.end()).toEqual([{ a: 3 }]);
  });

  it("names the bad line when one is not JSON", () => {
    expect(() => parseNdjson('{"ok":1}\n<html>oops</html>\n')).toThrow(NdjsonParseError);
    expect(() => parseNdjson("<html>oops</html>")).toThrow(/Invalid NDJSON line: <html>oops/);
  });

  it("reads a stream chunk by chunk, even when a chunk splits a multi-byte character", async () => {
    const text = '{"name":"Ödön"}\n{"name":"b"}\n';
    const bytes = new TextEncoder().encode(text);
    const cut = 13; // {"name":"Öd is 12 bytes, so byte 13 is the middle of "ö"
    expect(bytes[cut - 1]).toBe(0xc3);
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(bytes.slice(0, cut));
        c.enqueue(bytes.slice(cut));
        c.close();
      },
    });
    expect(await readNdjson(body)).toEqual([{ name: "Ödön" }, { name: "b" }]);
  });

  it("stops after max objects and cancels the rest of the download", async () => {
    let pulls = 0;
    const enc = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        pulls++;
        c.enqueue(enc.encode(`{"n":${pulls}}\n`));
      },
    });
    const out = await readNdjson<{ n: number }>(body, 3);
    expect(out.map((o) => o.n)).toEqual([1, 2, 3]);
    expect(pulls).toBeLessThan(10); // an endless stream, cut off early
  });

  it("returns [] for an empty body", async () => {
    expect(await readNdjson(null)).toEqual([]);
    expect(await readNdjson(streamed([]).body)).toEqual([]);
  });
});
