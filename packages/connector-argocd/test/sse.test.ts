import { describe, expect, it } from "vitest";
import { readJsonLines, readSseStream, SseParseError, type SseMessage } from "../src/index.ts";

async function* chunks(...parts: (string | Uint8Array)[]): AsyncGenerator<Uint8Array> {
  for (const p of parts) yield typeof p === "string" ? new TextEncoder().encode(p) : p;
}

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

describe("readSseStream", () => {
  it("parses events, comments, ids, retry and multi-line data", async () => {
    const msgs = await collect(
      readSseStream(
        chunks(
          ": heartbeat\n\n",
          'data: {"a":1}\n\n',
          "event: update\nid: 7\nretry: 3000\ndata: line1\ndata: line2\n\n",
          "data:no-space\n\n",
          "data\n\n",
        ),
      ),
    );
    expect(msgs).toEqual<SseMessage[]>([
      { event: "message", data: '{"a":1}', id: undefined, retry: undefined },
      { event: "update", data: "line1\nline2", id: "7", retry: 3000 },
      { event: "message", data: "no-space", id: "7", retry: undefined },
      { event: "message", data: "", id: "7", retry: undefined },
    ]);
  });

  it("handles chunks split anywhere, CRLF/CR endings, BOM and split UTF-8", async () => {
    const euro = new TextEncoder().encode("€"); // 3 bytes
    const msgs = await collect(
      readSseStream(
        chunks(
          "﻿da",
          "ta: x",
          euro.slice(0, 1),
          euro.slice(1),
          "\r",
          "\n\r\ndata: second\r\rdata: third\n",
          "\n",
        ),
      ),
    );
    expect(msgs.map((m) => m.data)).toEqual(["x€", "second", "third"]);
  });

  it("drops an unterminated trailing message", async () => {
    const msgs = await collect(readSseStream(chunks("data: done\n\n", "data: partial")));
    expect(msgs.map((m) => m.data)).toEqual(["done"]);
  });

  it("enforces the message size limit", async () => {
    const big = "data: " + "x".repeat(100) + "\n";
    await expect(
      collect(readSseStream(chunks(big, big), { maxMessageBytes: 150 })),
    ).rejects.toBeInstanceOf(SseParseError);
  });
});

describe("readJsonLines", () => {
  it("parses newline-delimited JSON across chunks", async () => {
    const values = await collect(
      readJsonLines(chunks('{"result":', '{"n":1}}\n\n{"result":{"n":2}}')),
    );
    expect(values).toEqual([{ result: { n: 1 } }, { result: { n: 2 } }]);
  });
});
