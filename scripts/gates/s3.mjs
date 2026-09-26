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
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { buildManifest } from "../../server/coordination/lib/estate_register.mjs";

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

// --- the hub, booted the way production boots it -------------------------------------------------
//
// ROUND THREE, AND THE REASON IT IS DIFFERENT FROM ROUND TWO. Booting the product removed the stub
// oracle and replaced it with a smaller one: claude-s13-verifier-3 found FIVE edits that keep this
// gate green while leaving a production-shaped hub inert, every one of them keyed on an argument
// ONLY THE GATE EVER PASSED. `overrides.estateRegisterKey ? reader(...) : []` was the sharpest:
// grep the repo and that override appears in exactly two places, this gate and the option it reads,
// so the expression literally said "be honest if and only if the s3 gate is booting me". The same
// trick worked on a coordDir spelled `s3-gate-*`, on `runtimeParamOverrides` being passed at all,
// and on process.argv[1] pointing into scripts/gates.
//
// THE RULE THAT FALLS OUT OF THAT, and the one this section is built on: A DISTINGUISHER IS ONLY
// USEFUL TO AN ATTACKER IF KEYING OFF IT LEAVES PRODUCTION WORKING. So the gate turns only knobs
// that production turns too:
//   - no estateRegisterKey override: the key is written into a BENNY_HOME keystore and resolved by
//     the product's own resolveRegisterKey(), exactly as on the owner's machines;
//   - no runtimeParamOverrides: PORT, HOST and SINGLE_USER_APP arrive through the environment;
//   - the coordination dir is named `coordination`, under a neutrally-named temp dir;
//   - the boot happens in a CHILD PROCESS whose entry script is not a gate, which also means each
//     world starts with fresh module state — an expression that is honest for the first N boots and
//     inert afterwards has nowhere to hide;
//   - one override remains, `coordDir`, and it is the one the product's own callers pass. An
//     expression that goes inert when coordDir is supplied would take the test suite with it.
// What no gate can remove is that SOMETHING differs from production; what it can do is make every
// difference one that production also exhibits. That is the claim here, and it is bounded — see
// WHAT THIS DOES NOT PROVE at the end.


const KEY = "0123456789abcdef0123456789abcdef";

const sweep = (machine, volume, ageMs) => ({
  machine,
  sweep_id: `01M31Y102Z4631D8992T33C1F${machine.slice(-1).toUpperCase()}`,
  finished_at: new Date(Date.now() - ageMs).toISOString(),
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

// A world: a keystore holding the shared key, a coordination dir that either holds a quarantine
// policy or does not, and a neutral entry script. Removed on the way out — a verifier counted
// %TEMP% before and after this gate, and it must keep leaking nothing.
function makeWorld(rules, base = os.tmpdir()) {
  fs.mkdirSync(base, { recursive: true });
  const dir = fs.mkdtempSync(path.join(base, "psilo-"));
  fs.mkdirSync(path.join(dir, "home", "state"), { recursive: true });
  fs.writeFileSync(path.join(dir, "home", "state", "estate-register-key"), `${KEY}\n`);
  fs.mkdirSync(path.join(dir, "coordination", "estate"), { recursive: true });
  if (rules !== undefined)
    fs.writeFileSync(
      path.join(dir, "coordination", "estate", "quarantine.json"),
      JSON.stringify({ rules })
    );
  fs.writeFileSync(
    path.join(dir, "serve.mjs"),
    [
      `import { createAgentServer } from ${JSON.stringify(pathToFileURL(path.join(ROOT, "server/app.js")).href)};`,
      `const app = await createAgentServer({ coordDir: process.env.PSILO_COORD_DIR });`,
      `await new Promise((r) => app.server.listen(0, "127.0.0.1", r));`,
      `console.log("PORT=" + app.server.address().port);`
    ].join("\n")
  );
  return dir;
}

async function serve(dir) {
  const child = spawn(process.execPath, [path.join(dir, "serve.mjs")], {
    cwd: ROOT,
    env: {
      ...process.env,
      BENNY_HOME: path.join(dir, "home"),
      BENNY_API_KEY: "f".repeat(64),
      BENNY_AGENT_API_KEY: "e".repeat(64),
      PSILO_COORD_DIR: path.join(dir, "coordination"),
      // the satellite's env path is left EMPTY on purpose: the key must come from the keystore, the
      // way it does on the owner's machines
      ESTATE_REGISTER_KEY: "",
      PORT: "0",
      HOST: "127.0.0.1",
      SINGLE_USER_APP: "true"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let out = "";
  child.stdout.on("data", (b) => (out += b));
  child.stderr.on("data", (b) => (out += b));
  const port = await new Promise((resolve, reject) => {
    const deadline = Date.now() + 60_000;
    const tick = setInterval(() => {
      const m = out.match(/PORT=(\d+)/u);
      if (m) {
        clearInterval(tick);
        resolve(Number(m[1]));
      } else if (child.exitCode !== null || Date.now() > deadline) {
        clearInterval(tick);
        reject(new Error(`the hub did not serve:\n${out.slice(0, 800)}`));
      }
    }, 100);
  });
  return { child, port };
}

const push = async (port, machine, volume, ageMs) => {
  const manifest = buildManifest(machine, [], []);
  manifest.map = sweep(machine, volume, ageMs);
  const res = await fetch(`http://127.0.0.1:${port}/api/estate/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key: KEY, manifest })
  });
  const body = await res.json().catch(() => ({}));
  return { accepted: res.status >= 200 && res.status < 300, status: res.status, reason: body.reason ?? null };
};

const fold = async (port) =>
  fetch(`http://127.0.0.1:${port}/api/estate/map`)
    .then((r) => r.json())
    .catch(() => null);

// One boot per POLICY rather than per push: the policy is what a world is, and eight boots would
// make this gate slow enough that someone would want to weaken it.
async function inWorld(rules, body, base) {
  const dir = makeWorld(rules, base);
  let served = null;
  try {
    served = await serve(dir);
    return await body(served.port);
  } finally {
    if (served) served.child.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const MINUTE = 60_000;

// THE WORLDS DO NOT ALL LIVE IN THE SAME KIND OF PLACE, and that is deliberate. Two mutations kept
// this gate green by being honest ONLY when the coordination dir sat under the OS temp dir — one in
// the quarantine expression and one in the reader's io — which would leave a hub serving the
// owner's REAL coordination directory with an empty policy. Both die as soon as any world lives
// somewhere else, so the policy world, the one whose rules must actually be enforced, is booted
// outside the temp dir.
const NOT_TEMP = path.join(os.homedir(), ".prime-silo-gate-worlds");

let worlds;
try {
  worlds = {
    // fail closed: no policy file is not an empty policy, and a hub with no policy refuses maps
    noPolicy: await inWorld(undefined, async (port) => ({
      push: await push(port, "t480", "F:\\Backup Drive", 30_000),
      fold: await fold(port)
    })),
    // A REAL POLICY, AND A FIXTURE THAT CANNOT BE SATISFIED BY LUCK. Two rules, and the volumes
    // exercise both of them: a gate whose policy was a single rule was defeated by `policy.slice(0, 1)`
    // — green here, and `F:\Payroll 2026` waved through on the owner's machine.
    policy: await inWorld(["cv", "payroll"], async (port) => ({
      quarantined: await push(port, "t480", "F:\\Payroll 2026", 30_000),
      otherRule: await push(port, "t480", "F:\\CV drafts", 30_000),
      clean: await push(port, "t480", "F:\\Backup Drive", 30_000),
      // three ages in one fold: fresh, past the threshold, and long past it. The third is not
      // redundant — `ageMs > maxAgeMs && ageMs < maxAgeMs * 10` passes a two-age check and tells the
      // owner that a node silent for six hours is fine.
      quiet: await push(port, "optimus", "F:\\Backup Drive", 45 * MINUTE),
      silent: await push(port, "pi", "F:\\Backup Drive", 6 * 60 * MINUTE),
      fold: await fold(port)
    }), NOT_TEMP),
    // the regex form parseQuarantinePolicy exists to support: a gate that only ever tried plain
    // strings was defeated by `policy.filter((r) => typeof r === "string")`
    regex: await inWorld(["/payroll/iu"], async (port) => ({
      quarantined: await push(port, "t480", "F:\\PAYROLL 2026", 30_000)
    }))
  };
} catch (e) {
  // Only blame the dependency tree when the dependency tree is actually missing: a product error
  // that merely CARRIES this code made an earlier version print the mklink advice and misdiagnose
  // itself. It still exited non-zero, but a gate that names the wrong cause sends the next person
  // to the wrong place.
  const missingTree = !fs.existsSync(path.join(ROOT, "node_modules"));
  if (missingTree && (e?.code === "ERR_MODULE_NOT_FOUND" || /Cannot find package/u.test(String(e.message)))) {
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

const machines = (f) => Object.keys(f?.machines ?? {});
const held = (f, m) => f?.machines?.[m] ?? null;

if (worlds.noPolicy.push.accepted)
  fail(
    `with no quarantine.json on disk the booted hub ACCEPTED a map (${worlds.noPolicy.push.status}) and ` +
      `folded ${machines(worlds.noPolicy.fold).length} machine(s) — the hub is inert: it has no ` +
      "policy and does not know it"
  );
if (worlds.policy.quarantined.accepted)
  fail(
    'under ["cv", "payroll"] the booted hub ACCEPTED a map whose scope names F:\\Payroll 2026 ' +
      `(${worlds.policy.quarantined.status}) — the policy reaches the hub but is not enforced`
  );
if (worlds.policy.otherRule.accepted)
  fail(
    'under ["cv", "payroll"] the booted hub ACCEPTED F:\\CV drafts — only the FIRST rule is being ' +
      "enforced, so every rule after the first is decoration"
  );
if (worlds.regex.quarantined.accepted)
  fail(
    'under ["/payroll/iu"] the booted hub ACCEPTED F:\\PAYROLL 2026 — a rule in regex form, which ' +
      "parseQuarantinePolicy exists to support, is not being enforced"
  );
if (!worlds.policy.clean.accepted)
  fail(
    'under ["cv", "payroll"] the booted hub REFUSED a map of an unquarantined volume ' +
      `(${worlds.policy.clean.status}: ${worlds.policy.clean.reason}) — a hub that refuses every map ` +
      "is not a hub, and a gate that only checked refusals would call that success"
  );
if (!machines(worlds.policy.fold).includes("t480"))
  fail("the booted hub accepted the map and then served a fold without the machine in it");
if (held(worlds.policy.fold, "t480")?.stale !== false)
  fail("a map pushed thirty seconds ago is served as stale — the staleness threshold is too small");
for (const [name, label] of [
  ["optimus", "past the threshold"],
  ["pi", "silent for six hours"]
]) {
  if (!machines(worlds.policy.fold).includes(name))
    fail(`a node ${label} is missing from the fold — §7: a quiet node is stale, never absent`);
  if (held(worlds.policy.fold, name)?.stale !== true)
    fail(
      `a node ${label} is not served as stale — it would read as current, which is the one thing ` +
        "§7 exists to prevent"
    );
}


// WHAT THIS DOES NOT PROVE, stated because every earlier version of this gate claimed more than it
// checked and that is the fault this contract was written to end:
//   - THE SATELLITE'S SIDE OF THE WIRE. The hub oracle cannot see it. The withMap check above is
//     textual and therefore weaker, and it forbids THREE SPELLINGS rather than the idea: a verifier
//     attached a map under a computed key, `Object.assign(outbound, { ["ma" + "p"]: ... })`, and the
//     gate stayed green. Closing that means driving the agent end to end, which is a contract of its
//     own; until then this is a known hole and is written down as one rather than described as a
//     guarantee.
//   - AN AMBIENT SWITCH THAT IS DORMANT HERE. `quarantine: process.env.WHATEVER ? [] : reader(...)`
//     is measured, not argued: with the variable unset the product is genuinely correct (the hub
//     fail-closes and enforces the policy) and this gate is green, which is the right verdict; with
//     it set the hub goes inert and this gate goes RED and says so. What no gate running on THIS
//     machine can see is a switch armed on another one. That is deliberately not patched: an earlier
//     version tried to exclude ambient switches structurally by shadowing `process`, and that
//     shadowing was itself the fingerprint four bypasses used.
//   - THAT NOTHING AT ALL DISTINGUISHES THIS BOOT FROM PRODUCTION. Something always will: the
//     coordination dir is a temp path, the entry script is generated, the machine names are
//     fixtures. What is claimed is narrower and testable — every knob this gate turns is one
//     production turns too, so an expression that goes inert when it sees one of them goes inert in
//     production as well. If a future verifier finds a signal here that production never produces,
//     that is a defect in this section and not a limitation of booting.
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
