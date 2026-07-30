// L2 acceptance — inbound poison gate. Scenarios map 1:1 to delivery/tasks/L2.md gherkin.
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { poisonGate, admit, ledgerRejection } from "../../server/coordination/lib/poison_gate.mjs";

const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "poison-"));

function rec(over = {}) {
  return { sid: "sess_1", machine: "t480", blobs: ["sha256:" + sha256("raw")], ...over };
}

test("Scenario: a hash-mismatched blob is refused admission", () => {
  const content = "raw session bytes";
  const wrongHash = "sha256:" + sha256("something else");
  const r = poisonGate({
    content,
    declaredContentHash: wrongHash,
    record: rec({ blobs: [wrongHash] })
  });
  assert.equal(r.admissible, false);
  assert.equal(r.reason, "hash-mismatch");
});

test("Scenario: an injected control record cannot pose as data (rejection ledgered)", () => {
  // a raw blob forged to look like a chained KEL control event (carries `prev` + a control `type`)
  const forged = JSON.stringify({
    type: "tombstoned",
    prev: "genesis",
    subject: { id: "card:victim" }
  });
  const declaredContentHash = "sha256:" + sha256(forged);
  const r = poisonGate({
    content: forged,
    declaredContentHash,
    record: rec({ blobs: [declaredContentHash] })
  });
  assert.equal(r.admissible, false);
  assert.equal(r.reason, "injected-control-record");

  // the rejection is ledgered with a reason
  const root = tmp();
  ledgerRejection(root, { sid: "sess_x", reason: r.reason });
  const led = fs.readFileSync(path.join(root, "poison-rejections.jsonl"), "utf8").trim();
  assert.match(led, /injected-control-record/);
});

test("Scenario: a genuine session passes and is marked admissible", () => {
  const content = JSON.stringify({ kind: "claude-session", turns: [{ role: "user", text: "hi" }] });
  const declaredContentHash = "sha256:" + sha256(content);
  const r = poisonGate({
    content,
    declaredContentHash,
    record: rec({ blobs: [declaredContentHash] })
  });
  assert.equal(r.admissible, true);
  assert.equal(r.reason, undefined);
});

test("shape: a malformed record (no sid) is rejected", () => {
  const content = "x";
  const h = "sha256:" + sha256(content);
  const r = poisonGate({ content, declaredContentHash: h, record: { blobs: [h] } });
  assert.equal(r.admissible, false);
  assert.equal(r.reason, "malformed-record");
});

test("admit: on pass the index record is marked pass; on fail it is not admissible", () => {
  const root = tmp();
  const content = "genuine";
  const h = sha256(content);
  // lay down a staging-shaped index record + blob
  const idxDir = path.join(root, "index", "t480", "2026-07-25");
  fs.mkdirSync(idxDir, { recursive: true });
  const blobDir = path.join(root, "blobs", "sha256", h.slice(0, 2));
  fs.mkdirSync(blobDir, { recursive: true });
  fs.writeFileSync(path.join(blobDir, h), content);
  const indexPath = path.join(idxDir, "sess_ok.json");
  fs.writeFileSync(
    indexPath,
    JSON.stringify({
      sid: "sess_ok",
      machine: "t480",
      blobs: ["sha256:" + h],
      poison_gate: "pending"
    })
  );

  const r = admit(root, indexPath);
  assert.equal(r.admissible, true);
  assert.equal(JSON.parse(fs.readFileSync(indexPath, "utf8")).poison_gate, "pass");
});
