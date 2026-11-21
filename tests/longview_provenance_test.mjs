// Two-machine LONGVIEW: one copy per session, honest machine labels, prompt versions,
// and an edition manifest that says what a book/SAD run is.
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";
import {
  sessionKey,
  dedupeSessions,
  hostOf,
  promptVersion
} from "../scripts/longview/lib/provenance.mjs";
import { buildEditionManifest } from "../scripts/longview/lib/edition.mjs";
import { snapshotHost, pickCopies } from "../scripts/estate_satellite_merge.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const U1 = "0143e682-9fff-4e91-9e33-9dd5862ca0f5";
const U2 = "15342bdc-e2cf-4eb4-b7e4-d5fcd0303d11";

// 1. Snapshot → machine: the satellite's own name wins, then the folder suffix, else the hub.
assert.equal(snapshotHost("sessions-2026-07-27-asus", "x  host=OPTIMUS  created=", "t480"), "optimus");
assert.equal(snapshotHost("sessions-2026-11-21-t480", "", "t480"), "t480");
assert.equal(snapshotHost("sessions-2026-07-27-asus", "", "t480"), "optimus");
assert.equal(snapshotHost("sessions-2026-07-26", "Sessions backup 2026-07-26", "t480"), "t480");

// 2. One copy per session: biggest, then newest, then the earlier-listed source (live).
const best = pickCopies([
  { key: "a", size: 10, mtimeMs: 5, order: 1, from: "july" },
  { key: "a", size: 20, mtimeMs: 1, order: 2, from: "live" },
  { key: "b", size: 10, mtimeMs: 1, order: 1, from: "july" },
  { key: "b", size: 10, mtimeMs: 9, order: 2, from: "live" },
  { key: "c", size: 10, mtimeMs: 1, order: 0, from: "live" },
  { key: "c", size: 10, mtimeMs: 1, order: 1, from: "july" }
]);
assert.equal(best.get("a").from, "live");
assert.equal(best.get("b").from, "live");
assert.equal(best.get("c").from, "live");

// 3. The real session id behind an entity, whatever path it was imported from.
const claude = (id, file, n = 1, extra = {}) => ({
  id,
  agent: "Claude",
  timestamp: n,
  children_ids: Array.from({ length: n }, (_, i) => `${id}-${i}`),
  metadata: { filePath: file, ...extra }
});
assert.equal(sessionKey(claude("x", `C:\\Users\\nsdha\\.claude\\projects\\p\\${U2}.jsonl`)), U2);
assert.equal(sessionKey(claude("x", `F:\\backups\\satellite\\optimus\\claude\\projects\\p\\${U2}.jsonl`)), U2);
assert.equal(sessionKey(claude("x", "C:\\p\\s\\subagents\\agent-a4e478f0f0087aff7.jsonl")), "agent-a4e478f0f0087aff7");
// Generic file names are NOT ids: two different audit.jsonl sessions must not merge.
assert.equal(sessionKey(claude("e1", "C:\\a\\one\\audit.jsonl", 1, { logSessionId: "L1" })), "L1");
assert.equal(sessionKey(claude("e2", "C:\\a\\two\\audit.jsonl")), "e2");
assert.equal(
  sessionKey({ id: "z", agent: "Antigravity", metadata: { sessionPath: `F:\\b\\brain\\${U1.toUpperCase()}\\` } }),
  U1
);

// 4. Copies collapse to the most complete one; distinct sessions stay distinct.
{
  const old = claude("old", `C:\\Users\\nsdha\\.claude\\projects\\p\\${U2}.jsonl`, 3);
  const grown = claude("new", `F:\\backups\\satellite\\optimus\\claude\\projects\\p\\${U2}.jsonl`, 7);
  const other = claude("o", `C:\\p\\${U1}.jsonl`, 1);
  const a1 = claude("e1", "C:\\a\\one\\audit.jsonl");
  const a2 = claude("e2", "C:\\a\\two\\audit.jsonl");
  const { keep, dropped } = dedupeSessions([old, grown, other, a1, a2]);
  assert.deepEqual(keep.map((s) => s.id).sort(), ["e1", "e2", "new", "o"]);
  assert.deepEqual(dropped, [{ id: "old", kept: "new", reason: "duplicate_copy" }]);
}

// 4b. Equal copies: the already-carded one is kept, whatever its id or date.
{
  const carded = claude("zzz", `C:\\Users\\nsdha\\.claude\\projects\\p\\${U2}.jsonl`, 4);
  const fresh = claude("aaa", `F:\\backups\\satellite\\optimus\\claude\\projects\\p\\${U2}.jsonl`, 4);
  fresh.timestamp = 99;
  const { keep } = dedupeSessions([fresh, carded], new Set(), (id) => id === "zzz");
  assert.deepEqual(keep.map((s) => s.id), ["zzz"]);
}

// 5. PRIVACY: if any copy is quarantined, no copy gets through under a fresh id.
{
  const q = claude("q-old", `C:\\Users\\nsdha\\.claude\\projects\\p\\${U2}.jsonl`, 3);
  const fresh = claude("q-new", `F:\\backups\\satellite\\optimus\\claude\\projects\\p\\${U2}.jsonl`, 9);
  const { keep, dropped } = dedupeSessions([q, fresh], new Set(["q-old"]));
  assert.deepEqual(keep, []);
  assert.deepEqual(dropped, [{ id: "q-new", kept: null, reason: "copy_of_quarantined" }]);
}

// 6. Machine labels come from the hub's map, else a local file, else "unknown" (never guessed).
{
  const prov = { keys: { [U2]: "optimus" } };
  assert.equal(hostOf(claude("a", `C:\\x\\${U2}.jsonl`), prov, { localHost: "t480", localExists: () => true }), "optimus");
  assert.equal(hostOf(claude("b", `C:\\x\\${U1}.jsonl`), prov, { localHost: "t480", localExists: () => true }), "t480");
  assert.equal(hostOf(claude("c", `C:\\x\\${U1}.jsonl`), prov, { localHost: "t480", localExists: () => false }), "unknown");
}

// 7. Prompt version changes with any prompt, and ignores line endings.
{
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "lvp-"));
  fs.writeFileSync(path.join(d, "a.md"), "one\ntwo\n");
  const v1 = promptVersion(d);
  fs.writeFileSync(path.join(d, "a.md"), "one\r\ntwo\r\n");
  assert.equal(promptVersion(d), v1);
  fs.writeFileSync(path.join(d, "a.md"), "one\ntwo!\n");
  assert.notEqual(promptVersion(d), v1);
  assert.match(v1, /^prompts@[0-9a-f]{12}$/);
}

// 8. The edition manifest separates METHOD from EDITION and counts inputs by machine × agent.
{
  const items = [
    { id: "1", host: "t480", agent: "Claude" },
    { id: "2", host: "optimus", agent: "Antigravity" },
    { id: "3", host: "optimus", agent: "Claude" },
    { id: "4", host: "optimus", agent: "Claude" } // no card yet
  ];
  const cardMeta = new Map([
    ["1", { model: "m1" }],
    ["2", { model: "m2", prompt_version: "prompts@aaa" }],
    ["3", { model: "m2", prompt_version: "prompts@aaa" }]
  ]);
  const m = buildEditionManifest({
    edition: "2026-11-21-t480+optimus",
    generated: "2026-11-22T00:00:00Z",
    release: { tag: "v1.24.5", commit: "abc", dirty: false },
    agent: { model: "m2" },
    items,
    cardMeta,
    promptVersion: "prompts@aaa",
    produced: ["sad", "book"],
    files: []
  });
  assert.equal(m.methods.sad.label, "TOGAF EPIC V7 SAD");
  assert.equal(m.methods.book.label, "The AI Vampire — V2 method");
  assert.equal(m.edition, "2026-11-21-t480+optimus");
  assert.deepEqual(m.inputs.by_machine_agent, { "t480/Claude": 1, "optimus/Antigravity": 1, "optimus/Claude": 1 });
  assert.equal(m.inputs.carded, 3);
  assert.equal(m.inputs.sessions_or_episodes, 4);
  assert.deepEqual(m.prompts.on_cards, { unrecorded: 1, "prompts@aaa": 2 });
}

// 9. The merge is additive and idempotent: a second run copies nothing; provenance is written.
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lvm-"));
  const put = (p, s) => {
    fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true });
    fs.writeFileSync(path.join(root, p), s);
  };
  put(`live/optimus/claude/proj/${U2}.jsonl`, '{"a":1}\n{"b":2}\n');
  put(`sessions-2026-07-27-asus/MANIFEST.txt`, "sessions-2026-07-27-asus  host=OPTIMUS  created=x\n");
  put(`sessions-2026-07-27-asus/claude/projects/proj/${U2}.jsonl`, '{"a":1}\n');
  put(`sessions-2026-07-27-asus/claude/history.jsonl`, "{}\n");
  put(`sessions-2026-07-27-asus/antigravity/antigravity-ide-brain/${U1}/.system_generated/logs/transcript.jsonl`, "{}\n");
  put(`live/t480/claude/proj/aaaaaaaa-1111-2222-3333-444444444444.jsonl`, "{}\n");
  // a fake memo-ray store that already holds the Antigravity conversation U1
  const store = fs.mkdtempSync(path.join(os.tmpdir(), "lvs-"));
  fs.mkdirSync(path.join(store, "entities"));
  fs.writeFileSync(path.join(store, "index.json"), JSON.stringify({ sessions: ["e1"] }));
  fs.writeFileSync(
    path.join(store, "entities", "e1.json"),
    JSON.stringify({ id: "e1", agent: "Antigravity", metadata: { sessionPath: `C:\\Users\\nsdha\\.gemini\\antigravity-ide\\brain\\${U1}` } })
  );
  const env = { ...process.env, ESTATE_BACKUP_ROOT: root, ESTATE_HUB_HOST: "t480", MEMORAY_DATA_DIR: store };
  const run = () => {
    const r = spawnSync(process.execPath, [path.join(REPO, "scripts/estate_satellite_merge.mjs"), "--host", "optimus"], {
      env,
      encoding: "utf8"
    });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  };
  const first = run();
  assert.equal(first.merge.claude.sessions, 1);
  assert.equal(first.merge.antigravity.conversations, 1);
  const merged = fs.readFileSync(path.join(root, `satellite/optimus/claude/projects/proj/${U2}.jsonl`), "utf8");
  assert.equal(merged, '{"a":1}\n{"b":2}\n', "the bigger (live) copy wins");
  assert.ok(!fs.existsSync(path.join(root, "satellite/optimus/claude/projects/history.jsonl")), "history is not a session");
  // memo-ray ingests ONLY what it lacks: re-reading U1 from a new path would duplicate its events
  assert.equal(first.merge.ingest.claude_new, 1);
  assert.equal(first.merge.ingest.antigravity_new, 0);
  assert.equal(first.merge.ingest.known_skipped, 1);
  assert.ok(fs.existsSync(path.join(root, `satellite/optimus/ingest/claude/projects/proj/${U2}.jsonl`)));
  assert.ok(!fs.existsSync(path.join(root, `satellite/optimus/ingest/antigravity/brain/${U1}`)));
  const second = run();
  assert.equal(second.merge.files_copied, 0, "second run copies nothing");
  assert.equal(second.merge.ingest.files_copied, 0, "second run ingests nothing new");
  // once memo-ray knows U2 (read from the ingest folder), it STAYS in ingest so growth flows
  fs.writeFileSync(path.join(store, "index.json"), JSON.stringify({ sessions: ["e1", "e2"] }));
  fs.writeFileSync(
    path.join(store, "entities", "e2.json"),
    JSON.stringify({ id: "e2", agent: "Claude", metadata: { filePath: path.join(root, `satellite/optimus/ingest/claude/projects/proj/${U2}.jsonl`) } })
  );
  put(`live/optimus/claude/proj/${U2}.jsonl`, '{"a":1}\n{"b":2}\n{"c":3}\n');
  const third = run();
  assert.equal(third.merge.ingest.claude_new, 1, "a session already in ingest keeps updating");
  assert.equal(
    fs.readFileSync(path.join(root, `satellite/optimus/ingest/claude/projects/proj/${U2}.jsonl`), "utf8").split("\n").length,
    4
  );
  fs.rmSync(store, { recursive: true, force: true });
  const prov = JSON.parse(fs.readFileSync(path.join(root, "provenance.json"), "utf8"));
  assert.equal(prov.keys[U2], "optimus");
  assert.equal(prov.keys[U1], "optimus");
  assert.equal(prov.keys["aaaaaaaa-1111-2222-3333-444444444444"], "t480");
  // the hub's own sessions are never merged into a satellite folder
  const self = spawnSync(process.execPath, [path.join(REPO, "scripts/estate_satellite_merge.mjs"), "--host", "t480"], {
    env,
    encoding: "utf8"
  });
  assert.equal(self.status, 2);
  fs.rmSync(root, { recursive: true, force: true });
}

console.log("longview_provenance_test: all assertions passed");
