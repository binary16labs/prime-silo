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

// --- the hub, booted with nothing passed to it ---------------------------------------------------
//
// FIVE DESIGNS HAVE BEEN DEFEATED THE SAME WAY, each defeat aimed at the fix before it: an
// expression that asks "am I being audited?" and answers honestly when it is. The signal it read got
// smaller every round — the gate's stubbed collaborators, then `estateRegisterKey`, then `coordDir`,
// then the SHAPE OF PASSING NOTHING — and every round I had written a comment here that made the
// latest signal look safe. The last one claimed a gate passing port 0 "hands the product a value it
// only ever sees under test"; the packaged desktop passes `port: 0`. The full account is in LOG.md.
//
// WHAT THE OWNER'S HUB ACTUALLY IS, measured rather than assumed: the desktop app calls
// createAgentServer IN-PROCESS with `{ host, port: 0, projectRoot, runtimeParamOverrides }` and sets
// no PORT and no HOST in the environment. `node server/server.js` with PORT in env is the CLI, not
// the desktop. Both are real; neither is "production" on its own.
//
// SO EVERY WORLD IS BUILT TWICE, ONCE IN EACH SHAPE, AND BOTH HUBS MUST AGREE. An expression keyed
// on any difference between them — an option one passes, an environment variable the other sets, the
// entry that runs — is honest in one shape and inert in the other, and this gate fails on either the
// wrong behaviour or the disagreement. That is the first version whose strength does not rest on my
// guess about which shape is real.
//
// In both shapes the coordination directory is the product's own default, `<projectRoot>/coordination`
// — the REAL one, whose quarantine policy this gate writes (backdated) and removes, and whose
// kel.jsonl it restores byte-identically. The key is resolved by the product from a keystore
// `benny init` would have written. What is left to key on is set out at the bottom, from measurement.


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

// A real free port for the CLI shape, because a port in the environment is what the CLI is given.
// The desktop shape passes `port: 0` as an OPTION, which is what the packaged app does — the two
// together mean neither spelling is a signal.
const freePort = () =>
  new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });

// The two shapes the estate actually boots in. `cli` is `node server/server.js` with its
// configuration in the environment. `desktop` is what packaging/desktop/main.js does: createAgentServer
// called in-process with host and port as OPTIONS, runtimeParamOverrides passed, and nothing in the
// environment. Neither is privileged here; both must agree.
const SHAPES = {
  cli: (home, port) => ({
    args: [path.join(ROOT, "server", "server.js")],
    env: { BENNY_HOME: home, PORT: String(port), HOST: "127.0.0.1", SINGLE_USER_APP: "true" }
  }),
  desktop: (home) => ({
    entry: [
      `import { createAgentServer } from ${JSON.stringify(pathToFileURL(path.join(ROOT, "server", "app.js")).href)};`,
      "const app = await createAgentServer({",
      '  host: "127.0.0.1",',
      "  port: 0,",
      `  projectRoot: ${JSON.stringify(ROOT)},`,
      '  runtimeParamOverrides: { WORKERS: "1", SINGLE_USER_APP: "true" }',
      "});",
      "await app.listen();",
      'console.log("listening at http://127.0.0.1:" + app.server.address().port);'
    ].join("\n"),
    env: { BENNY_HOME: home }
  })
};

async function boot(home, port, shape, dir) {
  const spec = SHAPES[shape](home, port);
  const env = { ...process.env, ...spec.env };
  // absent, not empty: an empty ESTATE_REGISTER_KEY is a state the owner's machine never has, and a
  // shape that does not configure a port must not inherit one
  delete env.ESTATE_REGISTER_KEY;
  if (!spec.env.PORT) {
    delete env.PORT;
    delete env.HOST;
  }
  let args = spec.args;
  if (spec.entry) {
    const file = path.join(dir, "boot.mjs");
    fs.writeFileSync(file, `${spec.entry}\n`);
    args = [file];
  }
  const child = spawn(process.execPath, args, {
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
  const served = Number(out.match(/listening at https?:\/\/[^:]+:(\d+)/u)?.[1]) || port;
  return { child, port: served };
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
// A POLICY FILE THE PRODUCT CANNOT DATE. The gate writes quarantine.json seconds before the boot
// while the owner's is months old, so `Date.now() - statSync(qjson).mtimeMs < 120000 ? reader() : []`
// was honest here and inert on the owner's machine - the half of the question a no-policy probe can
// never see, because there the file is absent either way. The timestamps are pushed back thirty days.
const BACKDATE_MS = 30 * 24 * 60 * 60 * 1000;
const writePolicy = (rules) => {
  put(QJSON, rules === undefined ? null : Buffer.from(JSON.stringify({ rules })));
  if (rules !== undefined) {
    const when = new Date(Date.now() - BACKDATE_MS);
    fs.utimesSync(QJSON, when, when);
  }
};

async function inShape(shape, rules, body) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "psilo-home-"));
  let booted = null;
  try {
    fs.mkdirSync(path.join(home, "state"), { recursive: true });
    fs.writeFileSync(path.join(home, "state", "estate-register-key"), `${KEY}\n`);
    // the per-install keystore `benny init` writes, so nothing reaches the product by environment
    // that a real install would not already have on disk
    fs.writeFileSync(path.join(home, "state", "hmac-key"), `${"7a".repeat(32)}\n`);
    fs.mkdirSync(ESTATE, { recursive: true });
    writePolicy(rules);
    booted = await boot(home, await freePort(), shape, home);
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

// EVERY WORLD IS BUILT TWICE AND BOTH HUBS MUST BEHAVE THE SAME. That is the point of this round:
// an expression keyed on anything that differs between the desktop shape and the CLI shape — an
// option the one passes, an environment variable the other sets, the entry that runs — is honest in
// one and inert in the other, and a disagreement is a failure. Neither shape is treated as the real
// one, because guessing which is real is how the last two rounds were lost.
async function inWorld(rules, body) {
  const out = {};
  for (const shape of Object.keys(SHAPES)) out[shape] = await inShape(shape, rules, body);
  return out;
}

const MINUTE = 60_000;

// How many quarantined pushes the guard must survive AFTER it has already refused once and accepted
// once. A guard honest for its first two consultations and empty afterwards passed an earlier round,
// because no world then needed the policy more than twice: fresh module state per world had closed
// "honest for the first N BOOTS" and opened "honest for the first N REQUESTS".
//
// MEASURED, so the number means something: a decay after 2 policy reads dies here and the failure
// names the consultation it broke at; a decay after 8 dies; a decay counted on 40 reads of the
// policy's `length` SURVIVES even at 30 probes, because the product does not read it once per push.
// That residual is named in WHAT THIS DOES NOT PROVE rather than papered over with a bigger number.
const DECAY_PROBES = 30;

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

// Every assertion is made about EVERY shape, and the shape is named when one of them fails. A hub
// that is honest booted one way and inert booted the other is the defect this round exists to catch.
for (const shape of Object.keys(SHAPES)) {
  const noPolicy = worlds.noPolicy[shape];
  const policy = worlds.policy[shape];
  const regex = worlds.regex[shape];
  const where = `booted the ${shape} way`;

  if (noPolicy.push.accepted)
    fail(
      `with no quarantine.json on disk the hub ${where} ACCEPTED a map (${noPolicy.push.status}) and ` +
        `folded ${machines(noPolicy.fold).length} machine(s) — it is inert: it has no policy and ` +
        "does not know it"
    );
  if (policy.first.accepted)
    fail(
      `under ["cv", "payroll"] the hub ${where} ACCEPTED a map whose scope names F:\Payroll 2026 ` +
        `(${policy.first.status}) — the policy reaches the hub but is not enforced`
    );
  if (policy.otherRule.accepted)
    fail(
      `under ["cv", "payroll"] the hub ${where} ACCEPTED F:\CV drafts — only the FIRST rule is ` +
        "being enforced, so every rule after the first is decoration"
    );
  if (regex.quarantined.accepted)
    fail(
      `under ["/payroll/iu"] the hub ${where} ACCEPTED F:\PAYROLL 2026 — a rule in regex form, ` +
        "which parseQuarantinePolicy exists to support, is not being enforced"
    );
  if (!policy.clean.accepted)
    fail(
      `under ["cv", "payroll"] the hub ${where} REFUSED a map of an unquarantined volume ` +
        `(${policy.clean.status}: ${policy.clean.reason}) — a hub that refuses every map is not a ` +
        "hub, and a gate that only checked refusals would call that success"
    );
  const decayed = policy.late.findIndex((r) => r.accepted);
  if (decayed >= 0)
    fail(
      `the quarantine guard ${where} stopped working after ${decayed + 3} consultations: ` +
        "F:\Payroll 2026 was refused at first and ACCEPTED later in the same process. A hub that " +
        "guards the first few pushes of its life and waves the rest through is the worst of both — " +
        "it looks enforced"
    );
  if (!machines(policy.fold).includes("t480"))
    fail(`the hub ${where} accepted the map and then served a fold without the machine in it`);
  if (held(policy.fold, "t480")?.stale !== false)
    fail(`a map pushed thirty seconds ago is served as stale ${where} — the threshold is too small`);
  for (const [name, label] of [
    ["optimus", "past the threshold"],
    ["pi", "silent for six hours"]
  ]) {
    if (!machines(policy.fold).includes(name))
      fail(`a node ${label} is missing from the fold ${where} — §7: a quiet node is stale, never absent`);
    if (held(policy.fold, name)?.stale !== true)
      fail(
        `a node ${label} is not served as stale ${where} — it would read as current, which is the ` +
          "one thing §7 exists to prevent"
      );
  }
}

// AND THE TWO SHAPES MUST AGREE, which is the assertion that makes the pair worth booting: an
// expression honest in one shape and inert in the other fails above, but one that merely BEHAVES
// differently — a policy read in one boot and not the other — would otherwise pass both halves.
for (const [world, probes] of [
  ["noPolicy", ["push"]],
  ["policy", ["first", "otherRule", "clean"]],
  ["regex", ["quarantined"]]
])
  for (const probe of probes) {
    const a = worlds[world].cli[probe];
    const b = worlds[world].desktop[probe];
    if (a.accepted !== b.accepted)
      fail(
        `the same map was ${a.accepted ? "accepted" : "refused"} by the hub booted the CLI way and ` +
          `${b.accepted ? "accepted" : "refused"} booted the desktop way (${world}/${probe}). The ` +
          "guard depends on how the hub was started, which means it depends on something that is " +
          "not the policy"
      );
  }

// WHAT THIS DOES NOT PROVE. Five rounds of this contract have turned on a comment claiming more
// than the code does, so this list is written from measurements and every previous version of it was
// wrong in the same way. The standard stands: if a verifier finds a signal this gate emits that the
// estate's own boots do not, that is a defect in this section.
//   - THE TWO SHAPES ARE THE ESTATE'S TWO SHAPES, not all conceivable ones. Both boots here are real
//     — the packaged desktop's in-process options and the CLI's environment — and requiring them to
//     agree kills anything keyed on the difference between them. What it cannot see is a signal
//     COMMON to both and absent in production: both are children of this gate, both run from this
//     worktree, both use a temp BENNY_HOME with fixture keys, both are pushed to by fetch rather
//     than by the satellite agent, and neither has an owner's real .env beside it.
//   - A GUARD THAT DECAYS ON A COUNTER THIS GATE'S TRAFFIC DOES NOT EXHAUST. Measured: a policy that
//     empties after 2 reads dies, after 8 dies, after 40 reads of its `length` survives 30 pushes,
//     because the product does not consult it once per push. Raising DECAY_PROBES moves the line and
//     never removes it; no finite probe does.
//   - A POLICY THE PRODUCT DATES. The file the gate writes is backdated thirty days, which kills
//     "honest only for a file written seconds ago". A guard keyed on the file being EXACTLY as old as
//     the owner's, or on its inode, path depth or directory neighbours, is not covered.
//   - THE SATELLITE'S SIDE OF THE WIRE. The hub oracle cannot see it. The withMap check above is
//     textual and forbids THREE SPELLINGS rather than the idea: a verifier attached a map under a
//     computed key, `Object.assign(outbound, { ["ma" + "p"]: ... })`, and the gate stayed green.
//     Closing it means driving the agent end to end, which is a contract of its own.
//   - AN AMBIENT SWITCH THAT IS DORMANT HERE. Unset, the product is genuinely correct and this gate
//     is green, which is the right verdict; set, the hub goes inert and this gate goes RED. What no
//     gate running on this machine can see is a switch armed on another one.
//   - THAT THE PRODUCT IS CORRECT FOR CALLERS WHO PASS coordDir. Nothing in the tree does any more,
//     so a mutation reading the policy from projectRoot/coordination is invisible here and harmless
//     on the owner's machine — measured on a zero-override boot. That is a latent break for an
//     embedder, not an inert hub, and it is written down rather than counted as a kill.
const t = spawnSync(process.execPath, ["--test", "tests/estate_map_fold_test.mjs"], {
  cwd: ROOT,
  stdio: "inherit"
});
if (t.status !== 0) {
  console.log("[s3] GATE FAILED (scenarios)");
  process.exit(1);
}

console.log(
  "[s3] booted both ways, the hub refuses a map with no policy, enforces the policy it has, folds the rest, and calls a quiet node stale"
);
console.log(
  "[s3] the node pushes and the hub folds; a quiet node is stale, not empty; only counts and hashes cross"
);
console.log("[s3] GATE GREEN");
process.exit(0);
