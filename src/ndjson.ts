/**
 * NDJSON (newline-delimited JSON) parsing.
 *
 * Lichess streams game exports as one JSON object per line
 * (`Accept: application/x-ndjson`). Chunks from the network can split a line
 * anywhere, so we buffer until we see a newline.
 */

export class NdjsonParseError extends Error {
  constructor(
    readonly line: string,
    cause: unknown,
  ) {
    super(`Invalid NDJSON line: ${line.slice(0, 80)}${line.length > 80 ? "…" : ""}`, { cause });
    this.name = "NdjsonParseError";
  }
}

/** Incremental parser: feed it text chunks, it returns every complete object so far. */
export class NdjsonParser<T = unknown> {
  private buffer = "";

  push(chunk: string): T[] {
    this.buffer += chunk;
    const out: T[] = [];
    let nl: number;
    while ((nl = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      const parsed = parseLine<T>(line);
      if (parsed !== undefined) out.push(parsed);
    }
    return out;
  }

  /** Flush a final line that had no trailing newline. */
  end(): T[] {
    const rest = this.buffer;
    this.buffer = "";
    const parsed = parseLine<T>(rest);
    return parsed === undefined ? [] : [parsed];
  }
}

function parseLine<T>(raw: string): T | undefined {
  const line = raw.trim();
  if (!line) return undefined; // Lichess sends blank keep-alive lines on slow streams.
  try {
    return JSON.parse(line) as T;
  } catch (err) {
    throw new NdjsonParseError(line, err);
  }
}

/** Parse a whole NDJSON document held in memory. */
export function parseNdjson<T = unknown>(text: string): T[] {
  const p = new NdjsonParser<T>();
  return [...p.push(text), ...p.end()];
}

/**
 * Read an NDJSON response body as a stream, stopping after `max` objects.
 * Stopping early cancels the body so we don't keep downloading.
 */
export async function readNdjson<T = unknown>(body: ReadableStream<Uint8Array> | null, max = Infinity): Promise<T[]> {
  if (!body) return [];
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const parser = new NdjsonParser<T>();
  const out: T[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      out.push(...parser.push(decoder.decode(value, { stream: true })));
      if (out.length >= max) {
        await reader.cancel().catch(() => {});
        return out.slice(0, max);
      }
    }
    out.push(...parser.push(decoder.decode()), ...parser.end());
    return out.slice(0, max);
  } finally {
    reader.releaseLock();
  }
}
