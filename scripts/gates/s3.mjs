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
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

// --- the hub, booted with nothing passed to it ---------------------------------------------------
//
// ROUND FOUR. Three designs have now been defeated the same way, and the third time it happened the
// defeat was aimed at the fix for the second: an expression that asks "am I being audited?" and
// answers honestly when it is. The signal it reads has got smaller each round — first the gate's
// stubbed collaborators, then `estateRegisterKey`, then `coordDir` — but the shape never changed.
//
// claude-s13-verifier-4 measured what the previous comment here merely asserted. That comment said
// coordDir "is the one the product's own callers pass" and that an expression going inert without it
// "would take the test suite with it". Both halves were false: `coordDir` was passed by EXACTLY ONE
// caller in the whole repository — this gate — and the suite passed 35/35 with the product inert.
// It was the new estateRegisterKey, and I had written the sentence that made it look safe.
//
// SO THIS GATE NOW PASSES NOTHING. It spawns `node server/server.js`, which is what the owner's
// machine runs, with no overrides of any kind. The coordination directory is therefore the product's
// own default, `<projectRoot>/coordination` — the REAL one, whose quarantine policy this gate writes
// and removes, and whose kel.jsonl it restores byte-identically afterwards. The key is resolved by
// the product from a keystore that `benny init` would have written. Nothing named PSILO_ anything
// exists, no entry script is generated, and no environment variable is set to a value production
// never uses: the port is a real free port rather than 0, and ESTATE_REGISTER_KEY is left ABSENT
// rather than set to the empty string, which was itself a signal the previous round armed.
//
// What is left to key on is the product's own configuration. An expression that goes inert on any of
// it goes inert on the owner's machine.


const KEY = "0123456789abcdef0123456789abcdef";
const ESTATE = path.join(ROOT, "coordination", "estate");
const QJSON = path.join(ESTATE, "quarantine.json");
const KEL = path.join(ESTATE, "kel.jsonl");

// The gate writes into the REAL coordination directory, so it takes a copy of everything it can
// disturb and puts it back byte for byte. A gate that leaves the owner's estate state altered has
// bought its evidence with the thing it was protecting.
const read = (f) => (fs.existsSync(f) ? fs.readFileSync(f) : null);
const put = (f, v) => (v === null ? fs.rmSync(f, { force: true }) : fs.writeFileSync(f, v));
const SNAPSHOT = { q: read(QJSON), kel: read(KEL) };
const restoreEstate = () => {
  put(QJSON, SNAPSHOT.q);
  put(KEL, SNAPSHOT.kel);
};

// A real port, not 0: production is configured with a port, and a gate that passes 0 hands the
// product a value it only ever sees under test.
const freePort = () =>
  new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });

async function boot(home, port) {
  const env = { ...process.env, BENNY_HOME: home, PORT: String(port), HOST: "127.0.0.1", SINGLE_USER_APP: "true" };
  // absent, not empty: an empty ESTATE_REGISTER_KEY is a state the owner's machine never has
  delete env.ESTATE_REGISTER_KEY;
  const child = spawn(process.execPath, [path.join(ROOT, "server", "server.js")], {
    cwd: ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let out = "";
  child.stdout.on("data", (b) => (out += b));
  child.stderr.on("data", (b) => (out += b));
  await new Promise((resolve, reject) => {
    const deadline = Date.now() + 90_000;
    const tick = setInterval(() => {
      if (/listening at/u.test(out)) {
        clearInterval(tick);
        resolve();
      } else if (child.exitCode !== null || Date.now() > deadline) {
        clearInterval(tick);
        reject(new Error(`the hub did not serve:\n${out.slice(0, 1200)}`));
      }
    }, 120);
  });
  return { child, port };
}

const sweep = (machine, volume, ageMs, tag) => ({
  machine,
  sweep_id: `01M31Y102Z4631D8992T33C1F${tag}`,
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

let tag = 0;
const push = async (port, machine, volume, ageMs = 30_000) => {
  const manifest = buildManifest(machine, [], []);
  manifest.map = sweep(machine, volume, ageMs, String.fromCharCode(65 + (tag++ % 26)));
  const res = await fetch(`http://127.0.0.1:${port}/api/estate/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key: KEY, manifest })
  });
  const body = await res.json().catch(() => ({}));
  return { accepted: res.status >= 200 && res.status < 300, status: res.status, reason: body.reason ?? null };
};

const fold = (port) =>
  fetch(`http://127.0.0.1:${port}/api/estate/map`)
    .then((r) => r.json())
    .catch(() => null);

// One world: a policy on disk (or none), a hub booted over the product's own coordination directory,
// and whatever pushes the world needs. The BENNY_HOME keystore is the only temporary thing, and it
// is removed; the estate is put back byte for byte.
async function inWorld(rules, body) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "psilo-home-"));
  let booted = null;
  try {
    fs.mkdirSync(path.join(home, "state"), { recursive: true });
    fs.writeFileSync(path.join(home, "state", "estate-register-key"), `${KEY}\n`);
    // the per-install keystore `benny init` writes, so nothing reaches the product by environment
    // that a real install would not already have on disk
    fs.writeFileSync(path.join(home, "state", "hmac-key"), `${"7a".repeat(32)}\n`);
    fs.mkdirSync(ESTATE, { recursive: true });
    put(QJSON, rules === undefined ? null : Buffer.from(JSON.stringify({ rules })));
    booted = await boot(home, await freePort());
    return await body(booted.port);
  } finally {
    // Wait for the child to actually go before deleting its home: Windows refuses to remove a
    // directory a living process still holds, and a gate that leaves debris behind on the paths it
    // takes when something FAILS is a gate that litters exactly when someone is debugging it.
    if (booted) {
      booted.child.kill();
      await new Promise((resolve) => {
        if (booted.child.exitCode !== null || booted.child.signalCode !== null) return resolve();
        const done = setTimeout(resolve, 5_000);
        booted.child.once("exit", () => {
          clearTimeout(done);
          resolve();
        });
      });
    }
    restoreEstate();
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

const MINUTE = 60_000;

// How many times the policy is consulted before the gate stops looking. A guard that is honest for
// the first two consultations and empty afterwards passed the previous round, because no world it
// booted needed the policy more than twice — fresh module state per world had closed "honest for the
// first N BOOTS" and opened "honest for the first N REQUESTS".
const DECAY_PROBES = 12;

let worlds;
try {
  worlds = {
    // fail closed: no policy file is not an empty policy, and a hub with no policy refuses maps
    noPolicy: await inWorld(undefined, async (port) => ({
      push: await push(port, "t480", "F:\\Backup Drive"),
      fold: await fold(port)
    })),
    // Two rules, a volume that matches the SECOND one, and a clean volume that must get through —
    // without that last one a hub refusing every map would pass a gate that only checked refusals.
    policy: await inWorld(["cv", "payroll"], async (port) => {
      const first = await push(port, "t480", "F:\\Payroll 2026");
      const otherRule = await push(port, "t480", "F:\\CV drafts");
      const clean = await push(port, "t480", "F:\\Backup Drive");
      // the same refusal, again, after the guard has been consulted many times
      const late = [];
      for (let i = 0; i < DECAY_PROBES; i++) late.push(await push(port, "t480", "F:\\Payroll 2026"));
      return {
        first,
        otherRule,
        clean,
        late,
        quiet: await push(port, "optimus", "F:\\Backup Drive", 45 * MINUTE),
        silent: await push(port, "pi", "F:\\Backup Drive", 6 * 60 * MINUTE),
        fold: await fold(port)
      };
    }),
    // the regex form parseQuarantinePolicy exists to support
    regex: await inWorld(["/payroll/iu"], async (port) => ({
      quarantined: await push(port, "t480", "F:\\PAYROLL 2026")
    }))
  };
} catch (e) {
  restoreEstate();
  // Only blame the dependency tree when the dependency tree is actually missing: a product error
  // that merely CARRIES this code made an earlier version print the mklink advice and misdiagnose
  // itself. It still exited non-zero, but a gate that names the wrong cause sends the next person to
  // the wrong place.
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
if (worlds.policy.first.accepted)
  fail(
    'under ["cv", "payroll"] the booted hub ACCEPTED a map whose scope names F:\\Payroll 2026 ' +
      `(${worlds.policy.first.status}) — the policy reaches the hub but is not enforced`
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
const decayed = worlds.policy.late.findIndex((r) => r.accepted);
if (decayed >= 0)
  fail(
    `the quarantine guard stopped working after ${decayed + 3} consultations: F:\\Payroll 2026 was ` +
      "refused at first and ACCEPTED later in the same process. A hub that guards the first few " +
      "pushes of its life and waves the rest through is the worst of both — it looks enforced"
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


// WHAT THIS DOES NOT PROVE. Four rounds of this contract have turned on one thing: a comment here
// claiming more than the code does. The previous version of this block invited a verifier to find a
// signal the gate emits that production never emits, and called any such signal a defect in this
// section. claude-s13-verifier-4 found six, so the invitation stands and the list below is what is
// left after removing them.
//   - WHAT IS STILL KEYABLE. This gate passes the product nothing, so what remains is the product's
//     own configuration: BENNY_HOME is a temp directory, its keystore holds fixture values, the
//     machine names and volume names are fixtures, and the map arrives by fetch rather than from the
//     satellite agent. An expression keyed on any of those is keyed on something the owner's machine
//     also has — a real BENNY_HOME, a real key, real machine names — so it cannot distinguish this
//     boot from that one without also going inert there. That is the claim, and it is the claim to
//     attack: if a future verifier finds a signal here that production never produces, that is a
//     defect in this section and not a limitation of booting.
//   - A GUARD THAT DECAYS AFTER MORE CONSULTATIONS THAN THIS GATE MAKES. The policy is exercised
//     DECAY_PROBES times after it has already refused and accepted, so a guard honest for the first
//     two, three or eleven consultations dies here. One honest for the first fifty does not, and no
//     finite probe closes that — the bound is stated rather than implied, and the number is one line
//     to raise.
//   - THE SATELLITE'S SIDE OF THE WIRE. The hub oracle cannot see it. The withMap check above is
//     textual and forbids THREE SPELLINGS rather than the idea: a verifier attached a map under a
//     computed key, `Object.assign(outbound, { ["ma" + "p"]: ... })`, and the gate stayed green.
//     Closing it means driving the agent end to end, which is a contract of its own; until then it
//     is a known hole rather than a guarantee.
//   - AN AMBIENT SWITCH THAT IS DORMANT HERE. `quarantine: process.env.WHATEVER ? [] : reader(...)`
//     is measured, not argued: unset, the product is genuinely correct and this gate is green, which
//     is the right verdict; set, the hub goes inert and this gate goes RED and says so. What no gate
//     running on THIS machine can see is a switch armed on another one. An earlier round tried to
//     exclude ambient switches structurally by shadowing `process`, and that shadowing was itself
//     the fingerprint four bypasses used.
//   - THAT THE PRODUCT IS CORRECT FOR CALLERS WHO PASS coordDir. It no longer does, and neither does
//     anything else in the tree: the only caller that ever passed it was this gate. A mutation that
//     reads the policy from projectRoot/coordination is therefore invisible here AND harmless on the
//     owner's machine — measured on a zero-override boot, not assumed — but it would break an
//     embedder who overrode coordDir. That is a latent break, not an inert hub, and it is written
//     down rather than counted as a kill.
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
