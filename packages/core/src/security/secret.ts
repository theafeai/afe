import { inspect } from "node:util";

export const REDACTED = "[REDACTED]";

/**
 * Wraps a sensitive value (token, private key, webhook secret) so it cannot leak
 * through logging, string interpolation, JSON serialisation or `util.inspect`.
 * The value is kept in a private field and is only available via `reveal()`,
 * which should be called as late as possible, at the point of use.
 */
export class Secret<T = string> {
  readonly #value: T;

  constructor(value: T) {
    this.#value = value;
  }

  /** Returns the wrapped value. Never pass the result to a logger. */
  reveal(): T {
    return this.#value;
  }

  toString(): string {
    return REDACTED;
  }

  toJSON(): string {
    return REDACTED;
  }

  [Symbol.toPrimitive](): string {
    return REDACTED;
  }

  [inspect.custom](): string {
    return `Secret(${REDACTED})`;
  }
}

/** Returns the raw value of a `Secret`, or the value itself if it is not wrapped. */
export function revealIfSecret<T>(value: T | Secret<T>): T {
  return value instanceof Secret ? value.reveal() : value;
}
