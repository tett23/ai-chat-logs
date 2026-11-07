import { describe, expect, test } from "bun:test";
import { literalOf, type Payload, restorePayloads, takePayloads } from "../src/payloads.ts";

// docs/adr/0031

// Spaces keep these strings from being valid base64.
const long = (n: number, c = "x ") => c.repeat(n).slice(0, n);
// A string whose JSON literal (with its two quotes) is exactly `bytes` bytes.
const ofLiteralBytes = (bytes: number) => long(bytes - 2);

const lookupOf = (payloads: readonly Payload[]) => (sha: string) => payloads.find((p) => p.sha256 === sha) ?? null;

const roundTrip = (raw: string): string => {
  const taken = takePayloads(raw);
  return taken === null ? raw : restorePayloads(taken.raw, lookupOf(taken.payloads));
};

const MARKER = /"\\u0000ai-chat-logs-payload:[0-9a-f]{64}"/g;
const markers = (raw: string) => raw.match(MARKER) ?? [];

const message = (content: unknown, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type: "user", uuid: "u1", sessionId: "s1", cwd: "/w", ...extra, message: { role: "user", content } });

describe("takePayloads: what is taken out", () => {
  test("a string tool_result content", () => {
    const big = long(2000);
    const raw = message([{ type: "tool_result", tool_use_id: "t1", content: big }]);
    const taken = takePayloads(raw);
    expect(taken).not.toBeNull();
    expect(markers(taken?.raw ?? "")).toHaveLength(1);
    expect(taken?.raw).not.toContain(big);
    expect(JSON.parse(taken?.raw ?? "")).toBeTruthy();
    expect(taken?.payloads).toHaveLength(1);
    expect(taken?.payloads[0]?.encoding).toBe("zstd");
    expect(taken?.payloads[0]?.size).toBe(2002);
    expect(taken?.payloads[0]?.sha256).toBe(new Bun.CryptoHasher("sha256").update(JSON.stringify(big)).digest("hex"));
  });

  test("the text of an array tool_result, a string in tool_use input and an image's data", () => {
    const png = Buffer.from(Array.from({ length: 1500 }, (_, i) => i % 251)).toString("base64");
    const raw = message([
      { type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: long(1500, "a ") }, { type: "image", source: { type: "base64", media_type: "image/png", data: png } }] },
      { type: "tool_use", id: "t2", name: "Write", input: { file_path: "/x", content: long(1500, "b ") } },
    ]);
    const taken = takePayloads(raw);
    expect(markers(taken?.raw ?? "")).toHaveLength(3);
    expect(taken?.payloads.map((p) => p.encoding).sort()).toEqual(["base64", "zstd", "zstd"]);
    expect(roundTrip(raw)).toBe(raw);
  });

  test("a literal of exactly 1024 bytes is taken, 1023 is not", () => {
    expect(takePayloads(message([{ type: "tool_result", content: ofLiteralBytes(1024) }]))).not.toBeNull();
    expect(takePayloads(message([{ type: "tool_result", content: ofLiteralBytes(1023) }]))).toBeNull();
  });

  test("sizes count UTF-8 bytes of the literal", () => {
    // 342 characters of 3 bytes each: 1026 + 2 bytes
    const raw = message([{ type: "tool_result", content: long(342, "あ") }]);
    expect(takePayloads(raw)?.payloads[0]?.size).toBe(1028);
  });
});

describe("takePayloads: what SQL reads stays", () => {
  test("top-level member values", () => {
    expect(takePayloads(message("hi", { customTitle: long(2000), cwd: long(2000) }))).toBeNull();
  });

  test("members of message, including a string content", () => {
    expect(takePayloads(message(long(2000), { }))).toBeNull();
    expect(takePayloads(JSON.stringify({ type: "assistant", message: { role: "assistant", model: long(2000), content: [] } }))).toBeNull();
  });

  test("text and thinking of content blocks", () => {
    expect(takePayloads(message([{ type: "text", text: long(2000) }, { type: "thinking", thinking: long(2000) }]))).toBeNull();
    // other members of a block, such as a thinking's signature, are taken out
    expect(takePayloads(message([{ type: "thinking", thinking: "t", signature: long(2000) }]))).not.toBeNull();
  });

  test("object keys are never taken", () => {
    const raw = JSON.stringify({ message: { content: [{ type: "tool_use", input: { [long(2000)]: 1 } }] } });
    expect(takePayloads(raw)).toBeNull();
  });
});

describe("takePayloads: exactness", () => {
  test("escapes survive byte for byte", () => {
    const tricky = `${long(1000)}\n"quoted" back\\slash \u0001 é 🎉 /`;
    const variants = [
      message([{ type: "tool_result", content: tricky }]),
      // escapes JSON.stringify does not write: \/, \u00e9, a surrogate pair, upper-case hex
      `{"message":{"content":[{"type":"tool_result","content":"${long(1100)}\\/\\u00e9\\uD83C\\uDF89\\u00E9"}]}}`,
      // whitespace between tokens
      `{ "message" : { "content" : [ { "type" : "tool_result" , "content" : "${long(1100)}" } ] } }`,
    ];
    variants.forEach((raw) => {
      expect(takePayloads(raw)).not.toBeNull();
      expect(roundTrip(raw)).toBe(raw);
    });
  });

  test("base64 is kept as bytes only when it re-encodes to the same text", () => {
    const bytes = Buffer.from(Array.from({ length: 1200 }, (_, i) => (i * 7) % 256));
    const b64 = bytes.toString("base64");
    const encodingOf = (data: string) => takePayloads(message([{ type: "image", source: { type: "base64", data } }]))?.payloads[0]?.encoding;
    expect(encodingOf(b64)).toBe("base64");
    const asBase64 = takePayloads(message([{ type: "image", source: { data: b64 } }]))?.payloads[0];
    expect(Buffer.from(asBase64?.content ?? []).equals(bytes)).toBe(true);
    // 1200 bytes encode without padding; drop one byte to get "=" padding, then strip it
    const padded = bytes.subarray(1).toString("base64");
    expect(padded.endsWith("=")).toBe(true);
    expect(encodingOf(padded)).toBe("base64");
    expect(encodingOf(padded.replace(/=+$/, ""))).toBe("zstd");
    expect(encodingOf(`${b64.slice(0, 800)}\n${b64.slice(800)}`)).toBe("zstd");
    expect(encodingOf(b64.replace(/\+/g, "-").replace(/\//g, "_"))).toBe("zstd");
    // non-canonical: the last character carries bits that a re-encode drops
    const nonCanonical = `${padded.slice(0, -2)}${padded.at(-2) === "A" ? "B" : "A"}=`;
    if (Buffer.from(nonCanonical, "base64").toString("base64") !== nonCanonical) expect(encodingOf(nonCanonical)).toBe("zstd");
    [b64, padded, padded.replace(/=+$/, ""), nonCanonical].forEach((d) => {
      const raw = message([{ type: "image", source: { data: d } }]);
      expect(roundTrip(raw)).toBe(raw);
    });
  });

  test("the same literal twice, in one record or two, is one payload", () => {
    const big = long(3000, "z ");
    const one = takePayloads(message([{ type: "tool_result", content: big }, { type: "tool_result", content: big }]));
    expect(markers(one?.raw ?? "")).toHaveLength(2);
    expect(one?.payloads).toHaveLength(1);
    const a = takePayloads(message([{ type: "tool_result", content: big }]));
    const b = takePayloads(message([{ type: "tool_result", content: big }], { uuid: "u2" }));
    expect(a?.payloads[0]?.sha256).toBe(b?.payloads[0]?.sha256 as string);
  });

  test("a record that already holds the marker text is left as it is", () => {
    const raw = message([{ type: "tool_result", content: long(2000) }, { type: "text", text: "\u0000ai-chat-logs-payload:" }]);
    expect(raw).toContain("\\u0000ai-chat-logs-payload:");
    expect(takePayloads(raw)).toBeNull();
  });

  test("invalid JSON is left as it is", () => {
    expect(takePayloads(`{"message":{"content":[{"type":"tool_result","content":"${long(2000)}"}]}`)).toBeNull();
    expect(takePayloads(`not json ${long(2000)}`)).toBeNull();
  });

  test("restorePayloads leaves a record without markers unchanged and fails on a missing payload", () => {
    expect(restorePayloads("{}", () => null)).toBe("{}");
    const taken = takePayloads(message([{ type: "tool_result", content: long(2000) }]));
    expect(() => restorePayloads(taken?.raw ?? "", () => null)).toThrow();
  });

  test("literalOf rebuilds both encodings", () => {
    const taken = takePayloads(message([{ type: "tool_result", content: long(2000, "q ") }, { type: "image", source: { data: Buffer.alloc(900, 3).toString("base64") } }]));
    const literals = taken?.payloads.map(literalOf) ?? [];
    expect(literals).toContain(JSON.stringify(long(2000, "q ")));
    expect(literals).toContain(JSON.stringify(Buffer.alloc(900, 3).toString("base64")));
  });

  test("records of many shapes round-trip", () => {
    const pieces = ["", "x", "\"", "\\", "\n", "é", "🎉", "\u0000", "</script>", "a\\\"b"];
    const lines = Array.from({ length: 200 }, (_, i) => {
      const s = Array.from({ length: 400 + ((i * 37) % 900) }, (_, j) => pieces[(i + j * 7) % pieces.length]).join("");
      const shapes = [
        message([{ type: "tool_result", content: s }]),
        message([{ type: "tool_use", input: { a: [s, { b: s }], n: i, t: true, z: null } }]),
        message(s),
        JSON.stringify({ type: "attachment", attachment: { content: s, nested: [[s]] } }),
        JSON.stringify([s, { k: s }]),
        JSON.stringify(s),
      ];
      return shapes[i % shapes.length] as string;
    });
    lines.forEach((l) => expect(roundTrip(l)).toBe(l));
    expect(lines.filter((l) => takePayloads(l) !== null).length).toBeGreaterThan(100);
  });
});
