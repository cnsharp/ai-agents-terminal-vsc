// Unit tests for the ported link patterns / parser. Run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { parseLine } = require("../out/links/linkParser.js");
const lp = require("../out/links/linkPatterns.js");

const payloads = (s) => parseLine(s).map((l) => l.payload);

test("file:line:col path", () => {
  assert.deepEqual(payloads("error at src/main/kotlin/com/cnsharp/yolo/Foo.kt:42:10"), [
    { kind: "file", path: "src/main/kotlin/com/cnsharp/yolo/Foo.kt", line: 42, column: 10 },
  ]);
});

test("stack-trace bare file:line", () => {
  const out = payloads("  at com.cnsharp.yolo.Bar.baz(Bar.java:123)");
  assert.ok(out.some((p) => p.kind === "file" && p.path === "Bar.java" && p.line === 123));
  assert.ok(out.some((p) => p.kind === "type" && p.name === "com.cnsharp.yolo.Bar.baz"));
});

test("quoted path (python traceback) dedupes to one file link with line", () => {
  assert.deepEqual(payloads('File "/Users/x/project/main.py", line 7'), [
    { kind: "file", path: "/Users/x/project/main.py", line: 7 },
  ]);
});

test("windows path with line", () => {
  assert.deepEqual(payloads("C:\\Users\\me\\src\\App.tsx:12"), [
    { kind: "file", path: "C:\\Users\\me\\src\\App.tsx", line: 12 },
  ]);
});

test("url", () => {
  assert.deepEqual(payloads("see https://example.com/docs for details"), [
    { kind: "url", url: "https://example.com/docs" },
  ]);
});

test("type and member names", () => {
  const out = payloads("type com.cnsharp.yolo.Config and call Config.load");
  assert.ok(out.some((p) => p.kind === "type" && p.name === "com.cnsharp.yolo.Config"));
  assert.ok(out.some((p) => p.kind === "type" && p.name === "Config.load"));
});

test("non-file dotted name is not linked as file", () => {
  // pay.amount.mark should never be a file link (no recognised extension)
  assert.ok(!payloads("pay.amount.mark").some((p) => p.kind === "file"));
});

test("many tokens capped at MAX_MATCHES_PER_LINE, no explosion", () => {
  const long = Array.from({ length: 200 }, (_, i) => `a${i}.kt`).join(" ");
  const links = parseLine(long);
  assert.equal(links.length, 50); // defensive cap (mirrors IntelliJ MAX_MATCHES_PER_LINE)
  assert.ok(links.every((l) => l.payload.kind === "file" || l.payload.kind === "type"));
});

test("matchers all compile (serializable)", () => {
  const ser = lp.toSerializable();
  assert.equal(ser.length, 9);
  for (const m of ser) {
    assert.doesNotThrow(() => new RegExp(m.source, m.flags));
  }
});
