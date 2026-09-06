#!/usr/bin/env node
// Artifact CLI — download once, place anywhere, and record who said so.
//
// The estate fetched the same 123 MB installer twice in one day because nothing tracked what
// it already held. artifacts.mjs fixed the storage; this is the entry point that makes it
// reachable, and — more to the point — the first committed caller of the provenance writers.
// Until now derived_from and caused_by existed and nothing invoked them, so ORIGIN RECORDED
// sat at zero against a fully verifying estate.
//
// The invariant that makes the edge worth anything:
//
//   A --caused-by NAMING A PROPOSAL MUST NAME ONE A HUMAN ACTUALLY SIGNED. An unchecked
//   authorisation field is worse than an empty one: it puts the shape of approval into the
//   record for something nobody approved, and it is indistinguishable from the real thing
//   afterwards. So the id is resolved against the governance ledger and refused if it is
//   missing, still open, or declined. Causes that are not proposals cannot be checked this
//   way and are recorded as given, which the command says out loud.
//
//   Omitting it stays legal. Forcing an authorisation on every fetch would teach you to type
//   a plausible proposal id to get past the tool, and fabricated provenance is the one
//   failure this whole design exists to prevent. An unauthorised placement is instead
//   recorded honestly and counted as unprovenanced by the lineage fold.
//
// Usage:
//   node scripts/artifact.mjs acquire --source <url|path> [--expected-hash <sha256>]
//        [--expected-size <bytes>] [--label <text>] [--media-type <mime>] [--publisher <name>]
//        [--caused-by <subject-id>] [--derived-from <subject-id> ...]
//   node scripts/artifact.mjs place --hash <sha256> --at <path> [--purpose <text>]
//        [--overwrite] [--caused-by <subject-id>] [--derived-from <subject-id> ...]
//   node scripts/artifact.mjs evict --hash <sha256> --at <path> [--reason <text>]
//   node scripts/artifact.mjs ls [--hash <sha256>]
//
// Common: --root <estate-store> (default $ESTATE_STORE or F:/estate-store), --json, --quiet
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import {
  acquireArtifact,
  placeArtifact,
  evictPlacement,
  buildArtifacts,
  placementsOf,
  subjectId
} from "../server/coordination/lib/artifacts.mjs";
import { readKelEvents } from "../server/coordination/lib/kel.mjs";
import { isAuthorised, loadGovernance } from "../server/coordination/lib/governance.mjs";
import { isSubjectId } from "../server/coordination/lib/provenance.mjs";
import { runRecordedEvent } from "../server/coordination/lib/runs.mjs";
import { appendKelEvent, ulid } from "../server/coordination/lib/kel.mjs";

const argv = process.argv.slice(2);
const cmd = argv[0];
const arg = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : fallback;
};
// Repeatable flags: --derived-from a --derived-from b
const args = (name) =>
  argv.reduce((acc, v, i) => (argv[i - 1] === `--${name}` ? [...acc, v] : acc), []);
const has = (name) => argv.includes(`--${name}`);

const ROOT = arg("root", process.env.ESTATE_STORE || "F:/estate-store");
const LOG = path.join(ROOT, "eventlog", "artifacts.jsonl");
const GOV = path.join(ROOT, "eventlog", "governance.jsonl");
const RUNS = path.join(ROOT, "eventlog", "runs.jsonl");
const MACHINE = String(process.env.COMPUTERNAME || os.hostname() || "unknown").toLowerCase();
const JSON_OUT = has("json");
const QUIET = has("quiet");

const say = (...m) => {
  if (!QUIET && !JSON_OUT) console.log(...m);
};
const die = (msg, code = 2) => {
  console.error(msg);
  process.exit(code);
};
const emit = (obj) => {
  if (JSON_OUT) console.log(JSON.stringify(obj, null, 2));
};

// Every command here is an execution of estate machinery, so each one is recorded as a run.
// That is what gives the unauthorised-run gauge a population: without runs to check, "0
// unauthorised" is a statement about an empty set. The proposal is recorded AS CLAIMED — the
// citation was already verified signed by resolveProvenance(), but the check that matters to
// the evidence pack is the one it performs itself at read time.
function recordRun(task, causedBy, outcome, detail = {}) {
  const proposalId = causedBy && causedBy.startsWith("proposal:") ? causedBy.slice(9) : null;
  const evt = runRecordedEvent({
    runId: ulid(),
    machine: MACHINE,
    task: `artifact ${task}`,
    kind: "estate",
    proposalId,
    outcome,
    detail
  });
  const res = appendKelEvent(RUNS, evt);
  if (!res.ok)
    console.error(`warning: the action succeeded but the run was not recorded (${res.reason})`);
  else
    say(
      `  run ${evt.subject.id}${proposalId ? ` under proposal:${proposalId}` : " (unauthorised)"}`
    );
}

function usage() {
  console.log(
    fs
      .readFileSync(new URL(import.meta.url), "utf8")
      .split("\n")
      .filter((l) => l.startsWith("//"))
      .slice(1)
      .join("\n")
      .replace(/^\/\/ ?/gm, "")
  );
}

// --- provenance, checked rather than trusted --------------------------------------------
//
// Returns { derivedFrom, causedBy } ready for the writers, having refused anything that would
// put an unearned authorisation into the ledger.
function resolveProvenance() {
  const derivedFrom = args("derived-from");
  const causedBy = arg("caused-by");

  for (const s of [...derivedFrom, ...(causedBy ? [causedBy] : [])]) {
    if (!isSubjectId(s))
      die(
        `not a subject id: ${JSON.stringify(s)}\n` +
          `  expected something like proposal:retire-jellyfin-probe or artifact:sha256:…\n` +
          `  a reason is not a reference — put the reason in --purpose or --label`
      );
  }

  if (causedBy && causedBy.startsWith("proposal:")) {
    const id = causedBy.slice("proposal:".length);
    const { ok, events, badLine } = readKelEvents(GOV);
    if (!ok)
      die(
        `the governance ledger does not verify (line ${badLine}) — refusing to cite a\n` +
          `  proposal from a record we already know has been altered`
      );
    if (!isAuthorised(events, id)) {
      const gov = loadGovernance(GOV);
      const p = gov.proposals.find((x) => x.id === id);
      const state = p ? `is still ${p.state}` : "does not exist";
      die(
        `--caused-by ${causedBy} ${state} — refusing.\n` +
          `  Citing an unsigned proposal records the shape of an authorisation nobody gave,\n` +
          `  and afterwards it is indistinguishable from a real one.\n` +
          `  Sign it in the Gov arc first, or omit --caused-by and let this be recorded\n` +
          `  honestly as an unauthorised action.`
      );
    }
    say(`authorised by ${causedBy} (signed)`);
  } else if (causedBy) {
    // Not a proposal: no signature exists to check against, so this is recorded as given.
    say(`caused_by ${causedBy} recorded as given — only proposals can be checked for a signature`);
  } else {
    say(`no --caused-by: this will be recorded with no authorisation, and counted unprovenanced`);
  }

  return { derivedFrom, causedBy };
}

// A source may be a URL or a path on this machine. Either way `open` is only ever called when
// the blob is not already held — which is the entire saving.
function opener(source) {
  if (/^https?:\/\//i.test(source)) {
    return async () => {
      const res = await fetch(source);
      if (!res.ok) throw new Error(`GET ${source} -> HTTP ${res.status}`);
      return Readable.fromWeb(res.body);
    };
  }
  if (!fs.existsSync(source)) die(`no such file: ${source}`);
  return async () => fs.createReadStream(source);
}

const mb = (n) => `${(n / 1e6).toFixed(1)} MB`;

// --- commands ----------------------------------------------------------------------------

async function acquire() {
  const source = arg("source") || die("acquire: --source <url|path> is required");
  const expectedHash = arg("expected-hash");
  const expectedSizeRaw = arg("expected-size");
  const { derivedFrom, causedBy } = resolveProvenance();

  const res = await acquireArtifact(ROOT, LOG, {
    sourceUri: source,
    label: arg("label", ""),
    mediaType: arg("media-type"),
    publisher: arg("publisher"),
    expectedHash,
    expectedSize: expectedSizeRaw ? Number(expectedSizeRaw) : null,
    machine: MACHINE,
    open: opener(source),
    derivedFrom,
    causedBy
  });

  recordRun("acquire", causedBy, "ok", { hash: res.hash, bytes: res.bytes, fetched: res.fetched });
  if (res.deduped && !res.fetched)
    say(`already held — source never opened, ${mb(expectedSizeRaw || 0)} not transferred`);
  else say(`stored ${mb(res.bytes)}`);
  say(`  sha256 ${res.hash}`);
  say(`  subject ${subjectId.artifact(res.hash)}`);
  emit({ ...res, subject: subjectId.artifact(res.hash), event: undefined });
}

async function place() {
  const hash = arg("hash") || die("place: --hash <sha256> is required");
  const at = arg("at") || die("place: --at <path> is required");
  const { derivedFrom, causedBy } = resolveProvenance();

  const res = await placeArtifact(ROOT, LOG, {
    hash,
    machine: MACHINE,
    path: at,
    purpose: arg("purpose", ""),
    overwrite: has("overwrite"),
    derivedFrom,
    causedBy
  });

  recordRun("place", causedBy, "ok", { hash, at, already_there: res.alreadyThere });
  say(res.alreadyThere ? `already at ${at} — placement recorded` : `placed at ${at}`);
  emit({ ...res, event: undefined });
}

function evict() {
  const hash = arg("hash") || die("evict: --hash <sha256> is required");
  const at = arg("at") || die("evict: --at <path> is required");
  const { derivedFrom, causedBy } = resolveProvenance();

  const res = evictPlacement(ROOT, LOG, {
    hash,
    machine: MACHINE,
    path: at,
    reason: arg("reason", ""),
    derivedFrom,
    causedBy
  });

  // The blob surviving is the point, not a detail: reclaiming space on one machine must never
  // be able to destroy the only copy of something.
  recordRun("evict", causedBy, "ok", { hash, at, removed: res.removed });
  say(res.removed ? `removed ${at}` : `nothing at ${at} — placement retired anyway`);
  say(`  blob retained: ${res.blobRetained}`);
  emit(res);
}

function ls() {
  const { ok, events, badLine } = readKelEvents(LOG);
  if (!ok) die(`the artifact ledger does not verify at line ${badLine}`, 1);
  const only = arg("hash");

  if (only) {
    const rows = placementsOf(events, only);
    say(`${rows.length} placement(s) of ${only}:`);
    for (const p of rows) say(`  ${p.machine.padEnd(16)} ${p.path}`);
    return emit(rows);
  }

  const rows = buildArtifacts(events);
  say(`${rows.length} artifact(s) in ${ROOT}`);
  for (const a of rows) {
    const places = placementsOf(events, a.hash);
    say(`  ${a.label || "(unlabelled)"} — ${mb(a.size || 0)}`);
    say(`    sha256 ${a.hash}`);
    say(`    ${places.length} placement(s): ${places.map((p) => p.machine).join(", ") || "none"}`);
  }
  emit(rows);
}

const commands = { acquire, place, evict, ls };
if (!cmd || cmd === "help" || has("help")) {
  usage();
  process.exit(0);
}
// The subcommand comes first, git-style. Accepting it after flags would need this parser to
// know which flags take a value, and `--json acquire` is genuinely ambiguous — so the rule is
// fixed and the error says which mistake you made rather than just refusing.
if (!commands[cmd]) {
  const misplaced = argv.find((a) => commands[a]);
  die(
    misplaced
      ? `put the command first: 'artifact.mjs ${misplaced} ${argv.filter((a) => a !== misplaced).join(" ")}'`
      : `unknown command '${cmd}' — try: ${Object.keys(commands).join(", ")}`
  );
}
if (!fs.existsSync(ROOT)) die(`no estate store at ${ROOT} — pass --root or set ESTATE_STORE`);

await commands[cmd]();
