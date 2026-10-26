/**
 * Generic Server-Sent Events reader (WHATWG HTML "event stream" format), used
 * for ArgoCD watch endpoints such as `/api/v1/stream/applications` (AFE-10).
 *
 * https://html.spec.whatwg.org/multipage/server-sent-events.html#parsing-an-event-stream
 */

export interface SseMessage {
  /** `event:` field; "message" when absent. */
  event: string;
  /** `data:` lines joined with "\n". */
  data: string;
  /** Last event id seen so far in the stream (`id:` field), if any. */
  id: string | undefined;
  /** `retry:` reconnection time in ms, if the server sent one with this message. */
  retry: number | undefined;
}

export interface SseReadOptions {
  /** Upper bound for one message (its data lines plus pending line); default 16 MiB. */
  maxMessageBytes?: number;
}

export class SseParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SseParseError";
  }
}

/**
 * Reads a byte stream and yields one `SseMessage` per dispatched event.
 * Handles chunks split anywhere (including inside a UTF-8 sequence or a CRLF),
 * `\r\n` / `\r` / `\n` line endings, comment lines (`:` heartbeats), multi-line
 * `data`, `id` and `retry`. A trailing message without a blank line at
 * end of stream is discarded, as the spec requires.
 */
export async function* readSseStream(
  body: AsyncIterable<Uint8Array>,
  options: SseReadOptions = {},
): AsyncGenerator<SseMessage> {
  const max = options.maxMessageBytes ?? 16 * 1024 * 1024;
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let first = true;
  let skipLf = false;

  let eventType = "";
  let data: string[] = [];
  let dataBytes = 0;
  let lastId: string | undefined;
  let retry: number | undefined;

  const processLine = (line: string): SseMessage | undefined => {
    if (line === "") {
      if (data.length === 0) {
        eventType = "";
        retry = undefined;
        return undefined;
      }
      const msg: SseMessage = {
        event: eventType || "message",
        data: data.join("\n"),
        id: lastId,
        retry,
      };
      eventType = "";
      data = [];
      dataBytes = 0;
      retry = undefined;
      return msg;
    }
    if (line.startsWith(":")) return undefined;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    switch (field) {
      case "event":
        eventType = value;
        break;
      case "data":
        dataBytes += value.length + 1;
        if (dataBytes > max) throw new SseParseError("event stream message too large");
        data.push(value);
        break;
      case "id":
        if (!value.includes("\0")) lastId = value;
        break;
      case "retry":
        if (/^\d+$/.test(value)) retry = Number(value);
        break;
      default:
        break;
    }
    return undefined;
  };

  const drainLines = function* (): Generator<SseMessage> {
    let start = 0;
    for (let i = 0; i < buffer.length; i++) {
      const ch = buffer.charCodeAt(i);
      if (skipLf) {
        skipLf = false;
        if (ch === 10) {
          start = i + 1;
          continue;
        }
      }
      if (ch === 10 || ch === 13) {
        const msg = processLine(buffer.slice(start, i));
        if (msg) yield msg;
        if (ch === 13) skipLf = true;
        start = i + 1;
      }
    }
    buffer = buffer.slice(start);
    if (buffer.length > max) throw new SseParseError("event stream line too large");
  };

  for await (const chunk of body) {
    let text = decoder.decode(chunk, { stream: true });
    if (first && text.length > 0) {
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
      first = false;
    }
    buffer += text;
    yield* drainLines();
  }
  buffer += decoder.decode();
  yield* drainLines();
}

/**
 * Reads newline-delimited JSON (one value per line), the format grpc-gateway
 * uses for server streaming when the client does not ask for an event stream.
 */
export async function* readJsonLines(
  body: AsyncIterable<Uint8Array>,
  options: SseReadOptions = {},
): AsyncGenerator<unknown> {
  const max = options.maxMessageBytes ?? 16 * 1024 * 1024;
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  const flush = function* (final: boolean): Generator<unknown> {
    let nl: number;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line) yield parseJson(line);
    }
    if (final && buffer.trim()) {
      yield parseJson(buffer.trim());
      buffer = "";
    }
    if (buffer.length > max) throw new SseParseError("JSON stream line too large");
  };
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    yield* flush(false);
  }
  buffer += decoder.decode();
  yield* flush(true);
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new SseParseError("stream contained invalid JSON");
  }
}
