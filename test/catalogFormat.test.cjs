// v1/v2 catalog format compatibility test (long-term contract).
// Requires the COMPILED out/agents.js, mocking the `vscode` module (only used
// inside functions we don't call here). Run with: node --test
const Module = require("module");
const assert = require("assert");
const path = require("path");
const { test } = require("node:test");

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "vscode") {
    return {
      Uri: { joinPath: () => ({ fsPath: "" }) },
      workspace: { getConfiguration: () => ({ get: () => [] }) },
    };
  }
  return originalLoad(request, parent, isMain);
};

const agents = require(path.join(__dirname, "..", "out", "agents.js"));
Module._load = originalLoad;

test("parseCatalog accepts legacy v1 flat array", () => {
  const v1 = '[{"id":"claude","command":"claude","displayName":"Claude Code","status":"active"}]';
  const parsed = agents.parseCatalog(v1);
  assert.strictEqual(parsed.length, 1);
  assert.strictEqual(parsed[0].id, "claude");
});

test("parseCatalog accepts v2 envelope with extra fields", () => {
  const v2 = JSON.stringify({
    schemaVersion: 2, updatedAt: "2026-11-18",
    agents: [{ id: "qodercn", command: "qodercn", displayName: "Qoder CN",
      status: "active", platformSupport: { darwin: "supported" } }],
  });
  const parsed = agents.parseCatalog(v2);
  assert.strictEqual(parsed.length, 1);
  assert.strictEqual(parsed[0].id, "qodercn");
  assert.strictEqual(parsed[0].status, "active");
});

test("parseCatalog rejects unknown schema version", () => {
  const v3 = '{"schemaVersion":3,"agents":[{"id":"x","command":"x","displayName":"X"}]}';
  assert.throws(() => agents.parseCatalog(v3));
});

test("bundled v2 catalog parses with status fields", () => {
  const fs = require("fs");
  const raw = fs.readFileSync(path.join(__dirname, "..", "agents.json"), "utf8");
  const parsed = agents.parseCatalog(raw);
  assert.strictEqual(parsed.length, 51);
  assert.ok(parsed.some((a) => a.id === "qodercn" && a.status === "active"));
  assert.ok(parsed.some((a) => a.id === "aider" && a.status === "stale"));
});
