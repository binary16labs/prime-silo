#!/usr/bin/env node
// Gate S3 — nodes push their map, the hub folds one estate map.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

// The PRODUCT wiring, not the tests' wiring. The tests build the estate API directly and pass a
// policy, so they cannot see that server/app.js passed none — which is how the quarantine guard
// shipped as dead code (claude-s3-verifier's D2). This assertion is the only thing that looks.
// THE PRODUCT'S OWN EXPRESSION, EVALUATED — not matched. Two earlier versions of this check read
// server/app.js and looked for strings in it; the second was defeated by appending "?? []" to the
// quarantine expression: green gate, hub with an empty policy, which is the inert state the D2
// amendment exists to prevent (claude-s3-verifier-3's F1, its X20 mutation). That was the third
// time in this contract that an assertion claimed more than it checked.
//
// So the options object server/app.js passes to createEstateApi is lifted out and RUN, with the
// identifiers it closes over replaced by stubs. The policy reader's stub returns a sentinel, so the
// gate can see what the product actually does with the reader's answer rather than that it merely
// mentions it. What this does NOT do is boot the server: it proves the expression, not the socket.
// The socket is proven by the tests, which drive the real API, and by S3's real-machine run.
// Comments are not code. The first version of this lifted the FIRST occurrence of
// "createEstateApi({" in the file, so a decoy above the real call satisfied it — and the decoy did
// not even have to run: a commented-out block scored green while the real call handed the hub an
// empty policy (claude-s13-verifier's G1, W2). Strings are left alone: a "createEstateApi({" inside
// one would be indistinguishable from the real thing, so the count below refuses that too.
function withoutComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//gu, " ").replace(/(^|[^:])\/\/[^\n]*/gu, "$1");
}

// The product's estate-API options, EVALUATED. What this can and cannot prove is set out at the
// bottom of this comment, because three earlier versions of this check described themselves as
// stronger than they were and that is the fault this whole contract exists to stop repeating.
function productEstateOptions({ policy, override }) {
  const raw = fs.readFileSync(path.join(ROOT, "server/app.js"), "utf8");
  const src = withoutComments(raw);

  // (a) EXACTLY ONE call. Two is a decoy, zero is not a product.
  const calls = src.split("createEstateApi(").length - 1;
  if (calls !== 1)
    throw new Error(`server/app.js builds the estate API ${calls} times; it must do so exactly once`);

  // (b) The policy reader may be IMPORTED under its own name and nothing else. A const, let, var
  // or function declaration rebinds the identifier this gate stubs, so the stub would measure a
  // function the product no longer calls; and "readQuarantinePolicy as somethingElse" renames the
  // import away, leaving the call site resolving to the stub here and to nothing in the product
  // (claude-s13-verifier's G2, both costumes).
  const rebound =
    /(?:\b(?:const|let|var|function)\s+readQuarantinePolicy\b)|(?:\bas\s+readQuarantinePolicy\b)|(?:\breadQuarantinePolicy\s+as\b)/u;
  if (rebound.test(src))
    throw new Error("server/app.js rebinds readQuarantinePolicy; the gate could not see past it");

  const open = src.indexOf("createEstateApi(");
  const close = src.indexOf("\n    })", open);
  if (close < 0) throw new Error("server/app.js does not build the estate API");
  const literal = src.slice(open + "createEstateApi(".length, close + "\n    }".length);

  // (c) The expression is run with every free identifier it may reach for supplied as a parameter —
  // INCLUDING process and globalThis, shadowed to undefined, so an ambient switch throws rather
  // than quietly deciding the policy (G3).
  let readerCalls = 0;
  const make = new Function(
    "overrides",
    "path",
    "fs",
    "coordDir",
    "coordinationBus",
    "readQuarantinePolicy",
    "resolveRegisterKey",
    "DEFAULT_MAP_MAX_AGE_MS",
    "process",
    "globalThis",
    `return ${literal};`
  );
  const options = make(
    override,
    path,
    fs,
    "/coord",
    null,
    (...args) => {
      readerCalls++;
      return typeof policy === "function" ? policy(...args) : policy;
    },
    () => "key",
    DEFAULT_MAP_MAX_AGE_MS,
    undefined,
    undefined
  );
  // (d) and it must have CONSULTED the reader, exactly once. An expression that ignores it is one
  // that decided the policy on its own.
  if (readerCalls !== 1)
    throw new Error(`server/app.js consulted its policy reader ${readerCalls} times, not once`);
  return options;
}

// WHAT THIS PROVES: that the single estate-API call in server/app.js, run with its collaborators
// stubbed, hands the hub the policy its reader returned and the shared staleness threshold — and
// that the reader is neither rebound nor bypassed. WHAT IT DOES NOT PROVE: that the server boots,
// or that the route behaves. Those are the tests' job and S3's real-machine run. Booting the
// product here was tried and dropped: it needs node_modules, which a fresh worktree does not have
// (the import itself fails there; a verifier who wants the stronger check can junction
// node_modules into the worktree, which is what claude-s13-verifier did).


// With no policy on disk the reader returns null, and null is what the hub must be given: an empty
// list would be a policy, and a hub with a policy accepts maps.
const noPolicy = productEstateOptions({ policy: null, override: {} });
if (noPolicy.quarantine !== null) {
  console.error(
    `[s3] FAIL: with no policy on disk the product hands the hub ${JSON.stringify(noPolicy.quarantine)}, not null — the hub would be inert`
  );
  process.exit(1);
}
const realPolicy = productEstateOptions({ policy: ["payroll"], override: {} });
if (!Array.isArray(realPolicy.quarantine) || realPolicy.quarantine[0] !== "payroll") {
  console.error("[s3] FAIL: the product does not hand the hub the policy its reader returned");
  process.exit(1);
}
if (noPolicy.mapMaxAgeMs !== DEFAULT_MAP_MAX_AGE_MS) {
  console.error("[s3] FAIL: the product does not pass the staleness threshold");
  process.exit(1);
}

const t = spawnSync(process.execPath, ["--test", "tests/estate_map_fold_test.mjs"], {
  cwd: ROOT,
  stdio: "inherit"
});
if (t.status !== 0) {
  console.log("[s3] GATE FAILED (scenarios)");
  process.exit(1);
}

console.log(
  "[s3] the node pushes and the hub folds; a quiet node is stale, not empty; only counts and hashes cross"
);
console.log("[s3] GATE GREEN");
process.exit(0);
