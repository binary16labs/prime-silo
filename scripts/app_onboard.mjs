#!/usr/bin/env node
// Onboard an application — the governed path from "I want this" to "the estate can prove it".
//
// This is the workflow every other piece was built for. It walks propose -> decide -> acquire
// -> place -> remember, and its whole value is the gate in the middle:
//
//   NOTHING IS FETCHED OR INSTALLED UNTIL A HUMAN HAS SIGNED.
//
// `propose` writes a proposal and stops. `acquire` and `place` resolve that proposal against
// the governance ledger and refuse while it is open, declined or absent. There is no --force:
// a step that can be skipped under pressure is not a control, and the estate would go back to
// being a place where things appear without anyone having said yes.
//
// State is never duplicated. The app record holds only what the operator supplied; where the
// bytes are and which nodes hold them is a fold over the ledger, because two copies of that
// answer would eventually disagree and the wrong one would be the convenient one.
//
// Usage:
//   node scripts/app_onboard.mjs propose --app <id> --title <name> --source <url|path>
//        [--expected-hash <sha256>] [--rationale <why>] [--cost <text>] [--irreversible]
//   node scripts/app_onboard.mjs status  [--app <id>]
//   node scripts/app_onboard.mjs acquire --app <id>
//   node scripts/app_onboard.mjs place   --app <id> --at <path> [--purpose install]
//
// Common: --root <estate-store> (default $ESTATE_STORE or F:/estate-store), --quiet
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import {
  proposalRaisedEvent,
  loadGovernance,
  isAuthorised,
  subjectId as gov
} from "../server/coordination/lib/governance.mjs";
import {
  acquireArtifact,
  placeArtifact,
  buildArtifacts,
  subjectId as art
} from "../server/coordination/lib/artifacts.mjs";
import { runRecordedEvent } from "../server/coordination/lib/runs.mjs";
import { appendKelEvent, readKelEvents, ulid } from "../server/coordination/lib/kel.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const cmd = argv[0];
const arg = (n, d = null) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : d;
};
const has = (n) => argv.includes(`--${n}`);

const ROOT = arg("root", process.env.ESTATE_STORE || "F:/estate-store");
const GOV = path.join(ROOT, "eventlog", "governance.jsonl");
const ART = path.join(ROOT, "eventlog", "artifacts.jsonl");
const RUNS = path.join(ROOT, "eventlog", "runs.jsonl");
const APPS = path.join(repo, "manual", "apps");
const MACHINE = String(process.env.COMPUTERNAME || os.hostname() || "unknown").toLowerCase();

const say = (...m) => {
  if (!has("quiet")) console.log(...m);
};
const die = (m, code = 2) => {
  console.error(m);
  process.exit(code);
};

const ID = /^[a-z0-9][a-z0-9._-]{0,60}$/;
const appFile = (id) => path.join(APPS, `${id}.json`);
const readApp = (id) => {
  const f = appFile(id);
  if (!fs.existsSync(f)) die(`no application '${id}' — run 'propose' first`);
  return JSON.parse(fs.readFileSync(f, "utf8"));
};

function record(task, proposalId, outcome, detail) {
  const evt = runRecordedEvent({
    runId: ulid(),
    machine: MACHINE,
    task: `onboard ${task}`,
    kind: "onboarding",
    proposalId,
    outcome,
    detail
  });
  const r = appendKelEvent(RUNS, evt);
  if (!r.ok) console.error(`warning: action done but run not recorded (${r.reason})`);
  return evt;
}

// The gate. Resolves the proposal and refuses anything short of a human signature.
function requireSignature(app) {
  const { ok, events, badLine } = readKelEvents(GOV);
  if (!ok) die(`the governance ledger does not verify (line ${badLine}) — refusing to act on it`);
  if (isAuthorised(events, app.proposal_id)) return events;

  const g = loadGovernance(GOV);
  const p = g.proposals.find((x) => x.id === app.proposal_id);
  die(
    `'${app.id}' is not authorised — proposal:${app.proposal_id} ${p ? `is still ${p.state}` : "does not exist"}.\n` +
      `  Open the Gov arc (#/_prime_silo/gov) and decide. Nothing will be fetched or installed\n` +
      `  until you do, and there is deliberately no way to skip this.`
  );
}

// --- commands -----------------------------------------------------------------------------

function propose() {
  const id = arg("app") || die("propose: --app <id> is required");
  if (!ID.test(id)) die(`propose: --app must be a slug (lowercase, digits, . _ -)`);
  const title = arg("title") || die("propose: --title <name> is required");
  const source = arg("source") || die("propose: --source <url|path> is required");
  const rationale =
    arg("rationale") ||
    die("propose: --rationale <why> is required — a signer decides on the why, not the title");

  if (fs.existsSync(appFile(id))) die(`'${id}' already exists — use 'status --app ${id}'`);

  const proposalId = `onboard-${id}`;
  const evt = proposalRaisedEvent({
    proposalId,
    machine: MACHINE,
    title: `Onboard ${title}`,
    rationale,
    evidence: [
      `source: ${source}`,
      arg("expected-hash") ? `sha256: ${arg("expected-hash")}` : null
    ].filter(Boolean),
    domain: "estate",
    cost: arg("cost", null),
    // Installing software is not reversible by default. Claiming otherwise on a signer's
    // behalf would understate what they are agreeing to, so it must be opted OUT of.
    reversible: !has("irreversible"),
    authorship: "frontier"
  });
  const r = appendKelEvent(GOV, evt);
  if (!r.ok) die(`could not raise the proposal: ${r.reason}`, 1);

  fs.mkdirSync(APPS, { recursive: true });
  fs.writeFileSync(
    appFile(id),
    JSON.stringify(
      {
        id,
        title,
        source,
        expected_hash: arg("expected-hash", null),
        media_type: arg("media-type", null),
        publisher: arg("publisher", null),
        proposal_id: proposalId,
        proposed_at: evt.valid_time
      },
      null,
      2
    ) + "\n"
  );

  say(`proposed ${gov.proposal(proposalId)}`);
  say(`  ${title} <- ${source}`);
  say(`\nNothing has been fetched. Open the Gov arc to decide:  #/_prime_silo/gov`);
}

async function acquire() {
  const app = readApp(arg("app") || die("acquire: --app <id> is required"));
  requireSignature(app);
  say(`authorised by ${gov.proposal(app.proposal_id)} (signed)`);

  const opener = /^https?:\/\//i.test(app.source)
    ? async () => {
        const res = await fetch(app.source);
        if (!res.ok) throw new Error(`GET ${app.source} -> HTTP ${res.status}`);
        return Readable.fromWeb(res.body);
      }
    : async () => {
        if (!fs.existsSync(app.source)) die(`source is gone: ${app.source}`);
        return fs.createReadStream(app.source);
      };

  const res = await acquireArtifact(ROOT, ART, {
    sourceUri: app.source,
    label: app.title,
    mediaType: app.media_type,
    publisher: app.publisher,
    expectedHash: app.expected_hash,
    machine: MACHINE,
    open: opener,
    causedBy: gov.proposal(app.proposal_id)
  });

  record("acquire", app.proposal_id, "ok", { app: app.id, hash: res.hash, fetched: res.fetched });
  say(
    res.deduped && !res.fetched
      ? `already held — the source was never opened`
      : `stored ${(res.bytes / 1e6).toFixed(1)} MB`
  );
  say(`  ${art.artifact(res.hash)}`);
}

async function place() {
  const app = readApp(arg("app") || die("place: --app <id> is required"));
  const at = arg("at") || die("place: --at <path> is required");
  requireSignature(app);

  const held = buildArtifacts(readKelEvents(ART).events).find(
    (a) => a.source_uri === app.source || a.hash === app.expected_hash
  );
  if (!held) die(`'${app.id}' has not been acquired yet — run 'acquire --app ${app.id}' first`);

  const res = await placeArtifact(ROOT, ART, {
    hash: held.hash,
    machine: MACHINE,
    path: at,
    purpose: arg("purpose", "install"),
    overwrite: has("overwrite"),
    causedBy: gov.proposal(app.proposal_id)
  });
  record("place", app.proposal_id, "ok", { app: app.id, at, already_there: res.alreadyThere });
  say(res.alreadyThere ? `already at ${at} — placement recorded` : `placed at ${at}`);
}

// Status is folded from the ledgers, never from the app record: a stored status would drift
// from the events, and the stored one is always the one that looks better.
function status() {
  if (!fs.existsSync(APPS)) return say(`no applications onboarded yet`);
  const only = arg("app");
  const govEvents = readKelEvents(GOV).events;
  const artifacts = buildArtifacts(readKelEvents(ART).events);
  const g = loadGovernance(GOV);

  const ids = only
    ? [only]
    : fs
        .readdirSync(APPS)
        .filter((f) => f.endsWith(".json"))
        .map((f) => f.slice(0, -5));
  if (!ids.length) return say(`no applications onboarded yet`);

  for (const id of ids) {
    const app = readApp(id);
    const signed = isAuthorised(govEvents, app.proposal_id);
    const p = g.proposals.find((x) => x.id === app.proposal_id);
    const held = artifacts.find((a) => a.source_uri === app.source || a.hash === app.expected_hash);
    const places = held ? held.placements : [];

    say(`\n${app.title}  (${app.id})`);
    say(`  1 propose   done — ${gov.proposal(app.proposal_id)}`);
    say(
      `  2 decide    ${signed ? `signed by ${p?.signature?.signer ?? "?"}` : `WAITING — currently ${p ? p.state : "missing"}`}`
    );
    say(
      `  3 acquire   ${held ? `held ${held.hash.slice(0, 16)}…` : signed ? "ready" : "blocked until signed"}`
    );
    say(
      `  4 place     ${places.length ? places.map((x) => `${x.machine}:${x.path}`).join(", ") : held ? "ready" : "—"}`
    );
    say(`  5 remember  run: node scripts/manual_build.mjs`);
  }
}

const commands = { propose, acquire, place, status };
if (!cmd || cmd === "help" || has("help")) {
  console.log(
    fs
      .readFileSync(new URL(import.meta.url), "utf8")
      .split("\n")
      .filter((l) => l.startsWith("//"))
      .slice(1)
      .join("\n")
      .replace(/^\/\/ ?/gm, "")
  );
  process.exit(0);
}
if (!commands[cmd]) {
  const misplaced = argv.find((a) => commands[a]);
  die(
    misplaced
      ? `put the command first: 'app_onboard.mjs ${misplaced} ...'`
      : `unknown command '${cmd}' — try: ${Object.keys(commands).join(", ")}`
  );
}
if (!fs.existsSync(ROOT)) die(`no estate store at ${ROOT} — pass --root or set ESTATE_STORE`);
await commands[cmd]();
