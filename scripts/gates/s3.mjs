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
import crypto from "node:crypto";
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
// THIS GATE WRITES INTO THE REAL COORDINATION DIRECTORY, so exactly one of it may run at a time.
// Two runs at once interleave their policy files and each sees the other's world — which is not
// hypothetical: a batch of mutations run back to back produced three failures that did not reproduce
// when the same mutations were run one at a time, and a gate that fails a CORRECT product is its own
// defect. The lock makes the collision loud instead of confusing. It does not, and cannot, stop a
// hub that is already serving this directory — see WHAT THIS DOES NOT PROVE.
// NOT A FILE, BECAUSE A FILE IS A NAME TO SCAN FOR. Round six put the lock inside the estate
// directory, where `exists(lock) ? reader() : []` read it straight off the disk the guard was already
// reading. Moving it to the OS temp directory did NOT close that — a product can list temp and look
// for a name beginning `psilo-s3-gate-`, and the mutation that does exactly that still passed. So the
// mutual exclusion is now a LISTENING SOCKET on a port derived from the coordination path: two runs
// cannot bind it at once, and it leaves nothing on disk to find.
//
// What must stay on disk is the RESTORE NOTE below, because a run killed outright runs no handler and
// the next run needs a fixed place to look. That it exists at all, while a run is in flight, is a
// signal — and the block at the bottom says so rather than claiming otherwise.
const LOCK_PORT = 20000 + (crypto.createHash("sha256").update(ROOT).digest().readUInt16BE(0) % 20000);
let lockServer = null;

async function takeLock() {
  lockServer = net.createServer();
  const ok = await new Promise((resolve) => {
    lockServer.once("error", () => resolve(false));
    lockServer.listen(LOCK_PORT, "127.0.0.1", () => resolve(true));
  });
  if (!ok) {
    console.error(
      [
        `[s3] FAIL: another run of this gate holds 127.0.0.1:${LOCK_PORT}.`,
        "[s3] This gate writes the real coordination directory, so two at once would each see the",
        "[s3] other's worlds. Wait for it to finish, or if you are certain nothing is running,",
        `[s3] find what holds 127.0.0.1:${LOCK_PORT} — the port is derived from this worktree's path.`
      ].join(String.fromCharCode(10))
    );
    process.exit(1);
  }
  lockServer.unref();
  // A run that died without clearing its note left the estate mid-flight; put it back before this
  // run records what IT is about to displace.
  recoverEstate();
}

const dropLock = () => {
  fs.rmSync(SIDECAR, { force: true });
  if (lockServer) lockServer.close();
};

const SIDECAR = path.join(
  os.tmpdir(),
  `psilo-estate-restore-${crypto.createHash("sha256").update(ROOT).digest("hex").slice(0, 12)}.json`
);

// WHAT NO HANDLER CAN COVER, RECOVERED INSTEAD OF PREVENTED. A hard kill runs nothing, so a run cut
// down mid-world leaves the gate's own policy sitting in the owner's real coordination directory and
// the owner's file only in the dead process's memory. Before touching anything, the gate writes what
// it is about to displace to SIDECAR, and takeLock() puts it back on the next run. The trigger is
// that the note EXISTS — not a stale lock, of which there can be none: the lock is a bound socket and
// dies with its holder. A gate that cannot prevent the damage should at least be able to undo it.
function rememberEstate() {
  fs.writeFileSync(
    SIDECAR,
    JSON.stringify({
      q: SNAPSHOT.q === null ? null : SNAPSHOT.q.toString("base64"),
      qAt: SNAPSHOT.qAt?.mtimeMs ?? null,
      kel: SNAPSHOT.kel === null ? null : SNAPSHOT.kel.toString("base64"),
      kelAt: SNAPSHOT.kelAt?.mtimeMs ?? null,
      dirAt: SNAPSHOT.dirAt?.mtimeMs ?? null
    })
  );
}

function recoverEstate() {
  if (!fs.existsSync(SIDECAR)) return;
  let saved;
  try {
    saved = JSON.parse(fs.readFileSync(SIDECAR, "utf8"));
  } catch {
    return;
  }
  console.error(`[s3] a previous run was interrupted; putting the estate back from ${SIDECAR}`);
  put(QJSON, saved.q === null ? null : Buffer.from(saved.q, "base64"));
  put(KEL, saved.kel === null ? null : Buffer.from(saved.kel, "base64"));
  if (saved.qAt && fs.existsSync(QJSON)) age(QJSON, saved.qAt);
  if (saved.kelAt && fs.existsSync(KEL)) age(KEL, saved.kelAt);
  if (saved.dirAt && fs.existsSync(ESTATE)) age(ESTATE, saved.dirAt);
  fs.rmSync(SIDECAR, { force: true });
}

const stamp = (f) => (fs.existsSync(f) ? fs.statSync(f) : null);
// CAPTURED AFTER RECOVERY, NOT AT IMPORT. Taking the snapshot when this module loads means a run
// that follows an interrupted one snapshots the WRECKAGE — and then faithfully restores it over the
// repair at the end. The order is: take the lock, put back whatever the dead run displaced, and only
// then record what this run is about to displace.
let SNAPSHOT = { q: null, kel: null, qAt: null, kelAt: null, dirAt: null };
const captureEstate = () => {
  SNAPSHOT = { q: read(QJSON), kel: read(KEL), qAt: stamp(QJSON), kelAt: stamp(KEL), dirAt: stamp(ESTATE) };
};
// Bytes AND timestamps. Restoring only the content left the owner's quarantine.json dated NOW —
// destroying the very stat field this gate's own file-age defence depends on, on the one file the
// owner most needs to be able to reason about.
const restoreEstate = () => {
  put(QJSON, SNAPSHOT.q);
  put(KEL, SNAPSHOT.kel);
  if (SNAPSHOT.qAt && fs.existsSync(QJSON)) age(QJSON, SNAPSHOT.qAt.mtimeMs);
  if (SNAPSHOT.kelAt && fs.existsSync(KEL)) age(KEL, SNAPSHOT.kelAt.mtimeMs);
  if (SNAPSHOT.dirAt && fs.existsSync(ESTATE)) age(ESTATE, SNAPSHOT.dirAt.mtimeMs);
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
  // The third shape, and the one I called "both" before: with WORKERS above 1 the product FORKS
  // http workers, and a worker builds the hub with a sixteen-key options object no other caller
  // passes, under SPACE_CLUSTER_WORKER. It is booted here through the product's own entry rather
  // than by replicating those options — replicating the desktop's options is how the previous round
  // got the desktop wrong.
  cluster: (home, port) => ({
    args: [path.join(ROOT, "server", "server.js")],
    env: {
      BENNY_HOME: home,
      PORT: String(port),
      HOST: "127.0.0.1",
      SINGLE_USER_APP: "true",
      WORKERS: "2"
    },
    tree: true
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
  // A SHAPE THAT SILENTLY DEGRADES TO ANOTHER SHAPE IS NOT A THIRD SHAPE. WORKERS=2 is supposed to
  // fork; if it ever stops forking, this gate would quietly be booting the CLI twice and reporting
  // that it covered the cluster. Measured here rather than trusted: WORKERS=1 forks nothing and
  // WORKERS=2 forks two.
  if (spec.tree && process.platform === "win32") {
    const counted = spawnSync(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        `(Get-CimInstance Win32_Process -Filter "ParentProcessId=${child.pid}" | Measure-Object).Count`
      ],
      { encoding: "utf8" }
    );
    if (Number(String(counted.stdout).trim()) < 1)
      throw new Error("the clustered shape forked no workers — it is the CLI shape wearing a hat");
  }
  return { child, port: served, tree: spec.tree === true };
}

// THE PAYLOAD IS NOT A FIXTURE EITHER. A digest of sixty-four `a`s and a sweep_id beginning
// `01M31Y102Z` are values only this gate sends, and they are the same in all three shapes — so an
// expression keyed on one has all three hubs wrong together and the agreement check stays silent.
// Every push now carries its own random digest, snapshot, sweep id and counts.
const ULID = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const randomUlid = () =>
  Array.from({ length: 26 }, () => ULID[Math.floor(Math.random() * ULID.length)]).join("");
const randomSha = () => crypto.randomBytes(32).toString("hex");

const sweep = (machine, volume, ageMs, rows = 2 + Math.floor(Math.random() * 40)) => ({
  machine,
  sweep_id: randomUlid(),
  finished_at: new Date(Date.now() - ageMs).toISOString(),
  scope: [volume],
  collectors: [{ name: "everything", kind: "files", volume, status: "ok", rows }],
  counts: {
    files: rows,
    bytes: rows * 100,
    listed_files: rows,
    apps: 0,
    listed_apps: 0,
    media: 0,
    listed_media: 0
  },
  totals: [
    { kind: "files", collector: "everything", volume, category: "code", items: rows, bytes: rows * 100 }
  ],
  digest: randomSha(),
  snapshot: `sha256:${randomSha()}`
});

const push = async (port, machine, volume, ageMs = 30_000) => {
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
// JITTERED, because the number itself was the signal. Round six moved from 30 days to 97 on the
// reasoning that "exactly thirty days" was recognisable — but roundness was never the point,
// EXACTNESS was, and `mtime within 2h of exactly 97 days` walked past the gate just as `exactly 30`
// had. Every run picks a different age, so there is no constant to key on.
const BACKDATE_MS = (180 + Math.random() * 900) * 24 * 60 * 60 * 1000;
const writePolicy = (rules) => {
  put(QJSON, rules === undefined ? null : Buffer.from(JSON.stringify({ rules })));
  const at = Date.now() - BACKDATE_MS;
  if (rules !== undefined) age(QJSON, at);
  // THE DIRECTORY IS A TIMESTAMP TOO. Writing the policy file touches the estate directory's mtime,
  // so `estate dir changed in the last minute ? reader() : []` was honest here and inert on a machine
  // whose estate directory had sat still — a signal one level up from the file the previous round
  // learned to age.
  age(ESTATE, at);
};

// EVERY TIMESTAMP THE PLATFORM WILL LET US SET, not just the two Node can reach. fs.utimesSync sets
// mtime and atime; birthtime and ctime it cannot touch, and a verifier keyed a guard on birthtime —
// "was this policy created in the last ten minutes?" — which was true of the gate's file and false of
// the owner's, so the hub enforced nothing and the gate stayed green. On Windows CreationTime is
// settable from PowerShell, so it is set. The age is also NOT a round number, because "exactly thirty
// days old" was itself a signal.
function age(file, atMs) {
  const when = new Date(atMs);
  fs.utimesSync(file, when, when);
  if (process.platform !== "win32") return;
  spawnSync(
    "powershell",
    [
      "-NoProfile",
      "-Command",
      `$f = Get-Item -LiteralPath '${file.replace(/'/gu, "''")}'; ` +
        `$t = [datetime]::FromFileTimeUtc(${BigInt(Math.round(atMs)) * 10000n + 116444736000000000n}); ` +
        "$f.CreationTimeUtc = $t; $f.LastWriteTimeUtc = $t; $f.LastAccessTimeUtc = $t"
    ],
    { stdio: "ignore" }
  );
}

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
      // a clustered primary's forked workers outlive a kill aimed at the primary alone
      if (booted.tree && process.platform === "win32")
        spawnSync("taskkill", ["/pid", String(booted.child.pid), "/T", "/F"], { stdio: "ignore" });
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

await takeLock();
captureEstate();
rememberEstate();
// THE ESTATE IS PUT BACK BEFORE THE LOCK IS DROPPED, and both happen on the way out of any exit —
// including a signal. The previous order dropped the lock on process exit, AFTER the last restore,
// so deleting it re-stamped the estate directory and every run left it dated now: 365.000 days old
// before, 0.000 after. And an interrupted run left the gate's synthetic policy in the owner's real
// coordination directory with the owner's own file only in the dead process's memory.
const leave = () => {
  try {
    restoreEstate();
  } finally {
    dropLock();
  }
};
process.on("exit", leave);
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"])
  process.on(signal, () => {
    leave();
    process.exit(130);
  });

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
    const names = Object.keys(SHAPES);
    for (let i = 0; i < names.length; i++)
      for (let j = i + 1; j < names.length; j++) {
        const a = worlds[world][names[i]][probe];
        const b = worlds[world][names[j]][probe];
        if (a.accepted !== b.accepted)
          fail(
            `the same map was ${a.accepted ? "accepted" : "refused"} booted the ${names[i]} way and ` +
              `${b.accepted ? "accepted" : "refused"} booted the ${names[j]} way (${world}/${probe}). ` +
              "The guard depends on how the hub was started, which means it depends on something " +
              "that is not the policy"
          );
      }
  }

// WHAT THIS DOES NOT PROVE. Six rounds of this contract have turned on a comment claiming more than
// the code does, so this list is written from measurements, and the previous five versions of it were
// each wrong in the same way. The standard stands: a signal this gate emits that the estate's own
// boots do not is a defect in this section.
//   - THREE SHAPES ARE THE THREE THAT HAVE BEEN FOUND — the packaged desktop's in-process options,
//     the CLI's environment, and the clustered primary that forks workers under WORKERS>1. Calling
//     that "the three the estate implements" was an existential claim about the product, and it is
//     the same sentence that said "both" the round before a verifier found the third. Requiring
//     all three to agree kills anything keyed on a difference between them. What it cannot see is a
//     signal COMMON to all three: each is a child of this gate, from this worktree, with a temp
//     BENNY_HOME holding fixture keys, pushed to by fetch rather than by the satellite agent, and
//     with no owner .env beside it.
//   - ctime. THE ONE CHANNEL NO AVAILABLE API CAN CLOSE. The policy file is aged in mtime, atime and
//     birthtime (PowerShell sets CreationTime, which fs.utimesSync cannot) by a DIFFERENT number of
//     days every run — an earlier version used exactly 97 on the reasoning that 30 had been
//     recognisable because it was round, when what was recognisable was that it was EXACT. But
//     Windows updates ctime on any metadata change and offers no way to set it, so a guard reading
//     "be honest only if this policy file was changed in the last N minutes" is honest here and
//     inert on a machine whose policy has sat untouched. Measured on a run of this gate: the policy
//     file's mtime and birthtime match the jittered age it was given, to three decimal places, and
//     its ctime is 0.000 d — no API sets ctime. The figures are not quoted as constants here because
//     the age is now different every run, which is the point of the entry above. The opposite
//     polarity — inert when the file is FRESH — IS caught.
//   - A GUARD THAT DECAYS ON A COUNTER THIS GATE'S TRAFFIC DOES NOT EXHAUST. Measured: a policy that
//     empties after 2 reads dies, after 8 dies, after 40 reads of its `length` survives 30 pushes,
//     because the product does not consult it once per push. Raising DECAY_PROBES moves the line and
//     never removes it.
//   - THE PORT AND THE RESTORE NOTE'S NAME ARE COMPUTABLE, NOT MERELY DISCOVERABLE. Both are pure
//     functions of the project root, which the product holds as coordDir's parent — so where round
//     six's lock file had to be LISTED for, these can be derived from a path the product already
//     knows. A verifier computed both from the path alone and matched what this gate printed. No
//     exploit of it has been demonstrated, and the note exists only while a run is in flight, but a
//     signal that can be calculated is a weaker place to stand than one that cannot.
//   - A HARD KILL, WHICH IS RECOVERED RATHER THAN PREVENTED. Ctrl-C is handled: the estate goes back
//     and the lock is dropped. A kill that runs no handler cannot be, so before touching anything
//     this gate writes what it is about to displace into a restore note in the OS temp directory —
//     "beside its lock" until the lock became a socket and stopped being anywhere — and the next run
//     finds that note, puts the estate back and says so. What that costs is a window in which the owner's coordination directory holds
//     this gate's policy — which is why it must not be run against a directory a hub is serving.
//   - A HUB ALREADY SERVING THIS COORDINATION DIRECTORY. The gate writes and removes the real
//     quarantine.json, so it must not be run while the owner's hub is up on the same directory: it
//     would briefly change that hub's policy. A lock stops two copies of the GATE colliding; nothing
//     here can stop a running product, and the gate does not pretend to.
//   - THE SATELLITE'S SIDE OF THE WIRE. The withMap check above is textual and forbids three
//     spellings rather than the idea: a verifier attached a map under a computed key and the gate
//     stayed green. Closing it means driving the agent end to end, which is a contract of its own.
//   - AN AMBIENT SWITCH THAT IS DORMANT HERE, and the product being correct for callers who pass
//     coordDir — nothing in the tree does any more, so a mutation reading the policy from
//     projectRoot/coordination is invisible here and harmless on the owner's machine. Measured on a
//     zero-override boot; a latent break for an embedder, not an inert hub.
const t = spawnSync(process.execPath, ["--test", "tests/estate_map_fold_test.mjs"], {
  cwd: ROOT,
  stdio: "inherit"
});
if (t.status !== 0) {
  console.log("[s3] GATE FAILED (scenarios)");
  process.exit(1);
}

console.log(
  "[s3] booted three ways — CLI, desktop and clustered — the hub refuses a map with no policy, enforces the policy it has, folds the rest, and calls a quiet node stale"
);
console.log(
  "[s3] the node pushes and the hub folds; a quiet node is stale, not empty; only counts and hashes cross"
);
console.log("[s3] GATE GREEN");
process.exit(0);
