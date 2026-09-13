// The itinerary is how a person finds a file movement later ("what did I put on the NAS on
// Tuesday, and from where?"). These tests feed it the log a REAL NAS scan writes, so the
// mapping cannot drift from what the catalog actually emits.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";

import { scanNas, nasLogFile } from "../server/coordination/lib/nas_catalog.mjs";

const require = createRequire(import.meta.url);
const { readNewEvents, itineraryEntities } = require("../memoray/server/parsers/nasItinerary.js");

async function scannedLog() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "nas-itin-"));
  const share = path.join(base, "nas");
  const estate = path.join(base, "estate");
  fs.mkdirSync(path.join(share, "models"), { recursive: true });
  fs.mkdirSync(path.join(share, ".receipts"), { recursive: true });
  fs.writeFileSync(path.join(share, "models", "qwen.gguf"), "w".repeat(2048));
  fs.writeFileSync(
    path.join(share, ".receipts", "r.json"),
    JSON.stringify({
      dest: "models/qwen.gguf",
      origin_machine: "optimus",
      reason: "free laptop disk"
    })
  );
  const scan = (settleMs = 0) =>
    scanNas({ root: share, estateRoot: estate, machine: "t480", settleMs });
  await scan();
  fs.renameSync(
    path.join(share, "models", "qwen.gguf"),
    path.join(share, "models", "qwen-7b.gguf")
  );
  await scan();
  return { log: nasLogFile(estate, "t480") };
}

test("a scan's log becomes one day session with readable, origin-bearing entries", async () => {
  const { log } = await scannedLog();
  const read = readNewEvents(fs.readFileSync(log, "utf8"));
  assert.equal(read.broken, null);

  const { sessions, children } = itineraryEntities(read.events);
  assert.equal(sessions.length, 1);
  assert.match(sessions[0].content, /^NAS itinerary \d{4}-\d{2}-\d{2} · t480$/u);
  assert.equal(sessions[0].metadata.project, "NAS");

  const lines = children.map((c) => c.content);
  assert.ok(
    lines.some((l) =>
      /^Added models\/qwen\.gguf \(2 KB\) from optimus — free laptop disk$/u.test(l)
    ),
    lines.join("\n")
  );
  assert.ok(lines.includes("Moved models/qwen.gguf → models/qwen-7b.gguf"), lines.join("\n"));
  assert.equal(lines.filter((l) => l.startsWith("NAS scan:")).length, 2);
  // acquired events and the eviction half of a move are folded, not listed twice
  assert.equal(children.length, 4);
  assert.ok(children.every((c) => c.parent_id === sessions[0].id));
});

test("incremental read resumes at the cursor and stops at a tampered line", async () => {
  const { log } = await scannedLog();
  const text = fs.readFileSync(log, "utf8");
  const all = readNewEvents(text);
  const first = readNewEvents(text.split("\n").slice(0, 2).join("\n"));
  const rest = readNewEvents(text, { fromLine: first.nextLine, prevHash: first.lastHash });
  assert.equal(first.events.length + rest.events.length, all.events.length);

  const lines = text.trim().split("\n");
  lines[1] = lines[1].replace("qwen", "QWEN");
  const tampered = readNewEvents(lines.join("\n"));
  assert.equal(tampered.broken.line, 3, "the line after an edit no longer chains");
  assert.equal(tampered.events.length, 2);
});

test("documents never reach the itinerary by name, path or reason", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "nas-docs-"));
  const share = path.join(base, "nas");
  const estate = path.join(base, "estate");
  fs.mkdirSync(path.join(share, "documents", "jobs"), { recursive: true });
  fs.mkdirSync(path.join(share, ".receipts"), { recursive: true });
  fs.writeFileSync(
    path.join(share, "documents", "jobs", "Jane-CV-Acme-2026.docx"),
    "cv".repeat(4000)
  );
  fs.writeFileSync(
    path.join(share, ".receipts", "d.json"),
    JSON.stringify({
      dest: "documents/jobs/Jane-CV-Acme-2026.docx",
      origin_machine: "optimus",
      origin_path: "C:\Users\nsdha\Documents\Jane-CV-Acme-2026.docx",
      reason: "application to Acme"
    })
  );
  const scan = () => scanNas({ root: share, estateRoot: estate, machine: "t480", settleMs: 0 });
  await scan();
  fs.renameSync(
    path.join(share, "documents", "jobs", "Jane-CV-Acme-2026.docx"),
    path.join(share, "documents", "jobs", "cv-final.docx")
  );
  await scan();
  fs.rmSync(path.join(share, "documents", "jobs", "cv-final.docx"));
  await scan();

  const { events } = readNewEvents(fs.readFileSync(nasLogFile(estate, "t480"), "utf8"));
  const { children } = itineraryEntities(events);
  const everything = JSON.stringify(children);
  // secrets chosen so they cannot occur by chance inside ULIDs or hex hashes
  for (const secret of ["Jane", "Jane-CV", "cv-final", "Acme", "jobs/", "Documents"])
    assert.ok(!everything.includes(secret), `itinerary leaked "${secret}": ${everything}`);
  const lines = children.map((c) => c.content);
  assert.ok(
    lines.some((l) => /^Added a document \(\d+ KB\) from optimus$/u.test(l)),
    lines.join("\n")
  );
  assert.ok(lines.includes("Moved a document within documents"));
  assert.ok(lines.some((l) => l.startsWith("Removed a document")));
});
