#!/usr/bin/env node
// Gate S3 — nodes push their map, the hub folds one estate map.
//
// THIS GATE BOOTS THE PRODUCT, and that is the whole point of S13. Three earlier versions of this
// check asked server/app.js's SOURCE TEXT what the product does. The first two matched strings; the
// third lifted the options object out of the file and ran it with its collaborators stubbed. All
// three were defeated, the last one seven separate times by claude-s13-verifier-2, and every bypass
// ended the same way: gate green, hub accepting a map with no quarantine policy on disk — the inert
// state the whole R31 wiring exists to prevent.
//
// Those are not bugs in three implementations. They are two properties of the approach:
//   (i)  AN EXPRESSION RUN WITH STUBS CAN SEE THE STUBS. Every stub is a distinguisher. `typeof
//        process` never throws however thoroughly process is shadowed; coordDir was a sentinel
//        string the product never sees; the bus was null. So the expression could consult the real
//        reader under audit and hand the product an empty policy in production. Removing that
//        oracle means making the stub environment indistinguishable from a real one, which IS
//        booting the server.
//   (ii) THE LIFTED TEXT IS NOT PROVABLY THE CODE THAT RUNS. The gate matched an identifier;
//        JavaScript dispatches a value. `const build = createEstateApi` plus a never-taken decoy
//        call satisfied every textual rule while a different call was the live one. Deciding which
//        call really runs IS running it.
//
// So the product assertion is now the only kind that cannot be talked around: boot the real hub on
// a real loopback socket, push a real map, and ask what the hub DID with it. It is also shorter than
// the machinery it replaces. What it costs is node_modules — and when they are missing this gate
// FAILS AND SAYS SO rather than skipping the check, because a gate that reports green without
// having verified anything is the exact fault this contract was written to end.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createAgentServer } from "../../server/app.js";
import { buildManifest } from "../../server/coordination/lib/estate_register.mjs";
import { DEFAULT_MAP_MAX_AGE_MS } from "../../server/coordination/lib/estate_map_fold.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
for (const f of [
  "server/coordination/lib/estate_map_fold.mjs",
  "scripts/estate_satellite_agent.mjs"
])
  if (!fs.existsSync(path.join(ROOT, f))) {
    console.error(`[s3] FAIL: ${f} missing`);
    process.exit(1);
  }

// The satellite agent is the outbound edge, and it must reach the wire through withMap() — which
// judges the payload AND keeps the sessions when the map cannot go. What withMap does is tested;
// this only checks the agent goes through it rather than composing the manifest itself.
//
// THIS ONE IS STILL A TEXTUAL CHECK, and the comment says so rather than implying otherwise: it is
// weaker evidence than the boot below, and it survives here only because the hub oracle cannot see
// the satellite's side of the wire at all. If the agent is ever driven end to end, delete it.
const agent = fs.readFileSync(path.join(ROOT, "scripts/estate_satellite_agent.mjs"), "utf8");
// Any syntax that puts a map onto a manifest without withMap's verdict: an assignment, a bracket
// assignment, or an object literal carrying a map key. The agent may call withMap and then ignore
// what it returns, which is what this forbids (claude-s13-verifier's G4).
const attachesMapItself =
  /(?:\.map|\["map"\]|\['map'\])\s*=[^=]/u.test(agent) || /\bmap\s*:/u.test(agent);
if (!/withMap\(/u.test(agent) || attachesMapItself) {
  console.error("[s3] FAIL: the satellite agent does not attach its map through withMap()");
  process.exit(1);
}

// --- the hub, booted ---------------------------------------------------------------------------

const KEY = "s3-gate-key";

const sweep = (volume, finishedAt) => ({
  machine: "t480",
  sweep_id: "01M31Y102Z4631D8992T33C1FW",
  finished_at: finishedAt,
  scope: [volume],
  collectors: [{ name: "everything", kind: "files", volume, status: "ok", rows: 3 }],
  counts: {
    files: 3,
    bytes: 300,
    listed_files: 3,
    apps: 0,
    listed_apps: 0,
    media: 0,
    listed_media: 0
  },
  totals: [
    { kind: "files", collector: "everything", volume, category: "code", items: 3, bytes: 300 }
  ],
  digest: "a".repeat(64),
  snapshot: `sha256:${"b".repeat(64)}`
});

// One world: a coordination dir that either holds a quarantine policy or does not, a real hub booted
// over it, one map pushed, and the folded map read back. The dir is removed on the way out — this
// gate leaked nothing into %TEMP% before (a verifier counted the entries) and must not start now.
async function hubGiven({ policy, volume = "F:\\Backup Drive", ageMs = 30_000 }) {
  const coordDir = fs.mkdtempSync(path.join(os.tmpdir(), "s3-gate-"));
  let server = null;
  try {
    fs.mkdirSync(path.join(coordDir, "estate"), { recursive: true });
    if (policy !== undefined)
      fs.writeFileSync(
        path.join(coordDir, "estate", "quarantine.json"),
        JSON.stringify({ rules: policy })
      );
    // PORT 0 and an explicit loopback listen: the gate must never open a LAN socket, whatever the
    // machine's HOST happens to be set to.
    const runtime = await createAgentServer({
      coordDir,
      estateRegisterKey: KEY,
      runtimeParamOverrides: { PORT: "0", SINGLE_USER_APP: "true" }
    });
    server = runtime.server;
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const port = server.address().port;
    const manifest = buildManifest("t480", [], []);
    manifest.map = sweep(volume, new Date(Date.now() - ageMs).toISOString());
    const res = await fetch(`http://127.0.0.1:${port}/api/estate/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: KEY, manifest })
    });
    const body = await res.json().catch(() => ({}));
    const fold = await fetch(`http://127.0.0.1:${port}/api/estate/map`)
      .then((r) => r.json())
      .catch(() => null);
    const held = fold?.machines?.t480 ?? null;
    return {
      accepted: res.status >= 200 && res.status < 300,
      status: res.status,
      reason: body.reason ?? null,
      machines: Object.keys(fold?.machines ?? {}),
      stale: held?.stale ?? null
    };
  } finally {
    if (server) await new Promise((r) => server.close(r));
    fs.rmSync(coordDir, { recursive: true, force: true });
  }
}

let worlds;
try {
  worlds = {
    // fail closed: no policy file is not an empty policy, and a hub with no policy refuses maps
    noPolicy: await hubGiven({ policy: undefined }),
    // a real policy, and a volume its rules name
    quarantined: await hubGiven({ policy: ["payroll"], volume: "F:\\Payroll 2026" }),
    // the same policy and a volume it does not name: this one must get through, or a hub that
    // refuses every map would pass a gate that only checked refusals
    clean: await hubGiven({ policy: ["payroll"] }),
    // older than the shared threshold: the fold must call it stale rather than drop it or call it
    // fresh. This is what replaces asserting the threshold was passed — the fold's own default is
    // now that same named constant, so passing it and omitting it are the same behaviour, and
    // behaviour is what this gate measures.
    quiet: await hubGiven({ policy: ["payroll"], ageMs: DEFAULT_MAP_MAX_AGE_MS + 15 * 60_000 })
  };
} catch (e) {
  if (e?.code === "ERR_MODULE_NOT_FOUND") {
    console.error(
      `[s3] FAIL: the hub could not be booted — ${String(e.message).split("\n")[0]}\n` +
        "[s3] This gate proves the product by RUNNING it, so it needs the dependency tree. In a\n" +
        "[s3] fresh worktree, junction the repo's node_modules in:\n" +
        `[s3]   cmd /c mklink /J "${path.join(ROOT, "node_modules")}" "<repo>\\node_modules"\n` +
        "[s3] It does NOT skip the check and report green."
    );
    process.exit(1);
  }
  throw e;
}

const fail = (msg) => {
  console.error(`[s3] FAIL: ${msg}`);
  process.exit(1);
};

if (worlds.noPolicy.accepted)
  fail(
    `with no quarantine.json on disk the booted hub ACCEPTED a map (${worlds.noPolicy.status}) and ` +
      `folded ${worlds.noPolicy.machines.length} machine(s) — the hub is inert: it has no policy ` +
      "and does not know it"
  );
if (worlds.quarantined.accepted)
  fail(
    'under the policy ["payroll"] the booted hub ACCEPTED a map whose scope names F:\\Payroll 2026 ' +
      `(${worlds.quarantined.status}) — the policy reaches the hub but is not enforced`
  );
if (!worlds.clean.accepted)
  fail(
    'under the policy ["payroll"] the booted hub REFUSED a map of an unquarantined volume ' +
      `(${worlds.clean.status}: ${worlds.clean.reason}) — a hub that refuses every map is not a hub`
  );
if (!worlds.clean.machines.includes("t480"))
  fail("the booted hub accepted the map and then served a fold without the machine in it");
if (worlds.clean.stale !== false)
  fail("a map pushed thirty seconds ago is served as stale — the staleness threshold is too small");
if (worlds.quiet.stale !== true)
  fail(
    `a map older than the shared threshold (${DEFAULT_MAP_MAX_AGE_MS} ms) is not served as stale — ` +
      "a node that stopped pushing would read as current"
  );
if (!worlds.quiet.machines.includes("t480"))
  fail("a stale node is missing from the fold — §7: a quiet node is stale, never absent");

// WHAT THIS DOES NOT PROVE, stated because every earlier version of this gate claimed more than it
// checked and that is the fault this contract was written to end:
//   - THE SATELLITE'S SIDE OF THE WIRE. The hub oracle cannot see it; the textual withMap check
//     above is the only thing that looks, and it is weaker.
//   - AN AMBIENT SWITCH THAT IS DORMANT HERE. `quarantine: process.env.WHATEVER ? [] : reader(...)`
//     is measured, not argued: with the variable unset the product is genuinely correct (the hub
//     fail-closes and enforces the policy) and this gate is green, which is the right verdict; with
//     it set the hub goes inert and this gate goes RED and says so. What no gate running on THIS
//     machine can see is a switch armed on another one. That is deliberately not patched: the
//     previous version tried to exclude ambient switches structurally by shadowing `process`, and
//     that shadowing was itself the fingerprint four of claude-s13-verifier-2's seven bypasses used.
//     A declared limit beats a rule that manufactures the oracle it was meant to remove.
const t = spawnSync(process.execPath, ["--test", "tests/estate_map_fold_test.mjs"], {
  cwd: ROOT,
  stdio: "inherit"
});
if (t.status !== 0) {
  console.log("[s3] GATE FAILED (scenarios)");
  process.exit(1);
}

console.log(
  "[s3] the booted hub refuses a map with no policy, enforces the policy it has, folds the rest, and calls a quiet node stale"
);
console.log(
  "[s3] the node pushes and the hub folds; a quiet node is stale, not empty; only counts and hashes cross"
);
console.log("[s3] GATE GREEN");
process.exit(0);
