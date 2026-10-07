/** A user-fixable input problem detected after schema validation. */
export class ToolInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolInputError";
  }
}

/** An upstream (Lichess) failure, with a hint the model can act on. */
export class LichessError extends Error {
  constructor(
    message: string,
    readonly status: number | undefined,
    readonly hint: string,
  ) {
    super(message);
    this.name = "LichessError";
  }

  toToolMessage(): string {
    return `${this.message}${this.status ? ` (HTTP ${this.status})` : ""}\nHint: ${this.hint}`;
  }
}
