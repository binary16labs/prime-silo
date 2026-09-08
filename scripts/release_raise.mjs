#!/usr/bin/env node
// Publish a release through the estate instead of through a browser — raise, sign, dispatch, record.
//
// Publishing was the last estate action with no governed path. A tag went up, someone opened
// github.com, clicked Run workflow, and the only trace was in a CI log nobody folds. That is
// the same "uncontracted execution" the register exists to eliminate, except this one is
// outward-facing: it puts installers on the internet under the estate's name.
//
// PUBLISH REFUSES WITHOUT A SIGNATURE. This is the one place that differs deliberately from
// `artifact.mjs`, where omitting --caused-by is legal and the run is recorded honestly as
// unauthorised. Recording an unauthorised local file copy is a defect to measure; recording an
// unauthorised PUBLICATION is a defect that has already happened to other people. So the
// asymmetry: local machinery may run unauthorised and be counted, publishing may not run at
// all. A refusal you can fix in thirty seconds beats a release you cannot recall.
//
// THE TOKEN IS NEVER TAKEN FROM ARGV. `arm` reads it from stdin, because an argument is
// visible in shell history and in every process listing on the machine for the life of the
// call. This tool never prints it back.
//
//   node scripts/release_raise.mjs status
//   node scripts/release_raise.mjs arm < token.txt      # then delete token.txt
//   node scripts/release_raise.mjs raise --tag v1.24.1 --rationale "..."
//   node scripts/release_raise.mjs publish --tag v1.24.1
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { appendKelEvent, readKelEvents, ulid } from "../server/coordination/lib/kel.mjs";
import {
  proposalRaisedEvent,
  loadGovernance,
  isAuthorised,
  subjectId as govSubject
} from "../server/coordination/lib/governance.mjs";
import { runRecordedEvent } from "../server/coordination/lib/runs.mjs";
import { resolveEstateStore } from "../server/lib/estate_store.js";
import {
  resolveReleaseToken,
  releaseTokenStatus,
  storeReleaseToken
} from "../server/coordination/lib/release_token.mjs";
import { parseFeed, releaseHealth } from "../server/coordination/lib/releases.mjs";

const argv = process.argv.slice(2);
const cmd = argv[0] || "status";
const arg = (n, d = null) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : d;
};
const has = (n) => argv.includes(`--${n}`);
const JSON_OUT = has("json");
const say = (...m) => {
  if (!JSON_OUT) console.log(...m);
};
const die = (msg, code = 2) => {
  console.error(msg);
  process.exit(code);
};

const { root: ROOT } = resolveEstateStore();
const GOV = path.join(ROOT, "eventlog", "governance.jsonl");
const RUNS = path.join(ROOT, "eventlog", "runs.jsonl");
const MACHINE = String(process.env.COMPUTERNAME || os.hostname() || "unknown").toLowerCase();
const WORKFLOW = "release-desktop.yml";
const TAG = /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

// One proposal id per tag, derived rather than invented, so re-raising the same release finds
// the same proposal and the queue cannot accumulate two decisions about one publication.
const proposalIdFor = (tag) => `release-${String(tag).replace(/^v/, "").replace(/\./g, "-")}`;

const whoami = () => {
  try {
    return os.userInfo().username;
  } catch {
    return "unknown";
  }
};

/** owner/repo from the git remote — never hardcoded, so a fork publishes to itself. */
function repoSlug() {
  try {
    const url = execFileSync("git", ["remote", "get-url", "origin"], {
      encoding: "utf8"
    }).trim();
    const m = url.match(/github\.com[:/]+([^/]+)\/([^/.]+)/i);
    if (!m) return null;
    return { owner: m[1], repo: m[2] };
  } catch {
    return null;
  }
}

async function gh(pathname, { token = null, method = "GET", body = null } = {}) {
  const headers = {
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28"
  };
  if (token) headers.authorization = `Bearer ${token}`;
  if (body) headers["content-type"] = "application/json";
  const res = await fetch(`https://api.github.com${pathname}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30000)
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { ok: res.ok, status: res.status, json, text };
}

const localTags = () => {
  try {
    return execFileSync("git", ["tag", "--list", "v*"], { encoding: "utf8" })
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
};

async function health(slug) {
  const rels = await gh(`/repos/${slug.owner}/${slug.repo}/releases?per_page=10`);
  const releases = Array.isArray(rels.json) ? rels.json : [];
  const release = releases.find((r) => !r.draft) || null;
  const feeds = {};
  if (release) {
    for (const [platform, name] of [
      ["windows", "metadata-latest-windows.yml"],
      ["mac", "metadata-latest-mac.yml"],
      ["linux", "metadata-latest-linux.yml"]
    ]) {
      const asset = (release.assets || []).find((a) => a.name === name);
      // A feed that was never published and one that would not download are different facts.
      // Both arrive here as null; releaseHealth reports either as "unknown" rather than
      // inventing a gap, which is the distinction that keeps a network blip out of the alarm.
      if (!asset) {
        feeds[platform] = null;
        continue;
      }
      try {
        const r = await fetch(asset.browser_download_url, { signal: AbortSignal.timeout(20000) });
        feeds[platform] = r.ok ? parseFeed(await r.text()) : null;
      } catch {
        feeds[platform] = null;
      }
    }
  }
  return releaseHealth({ release, feeds, tags: localTags(), releases });
}

function recordRun(task, proposalId, outcome, detail = {}) {
  const evt = runRecordedEvent({
    runId: ulid(),
    machine: MACHINE,
    task: `release ${task}`,
    kind: "estate",
    proposalId,
    outcome,
    detail
  });
  const res = appendKelEvent(RUNS, evt);
  if (!res.ok) console.error(`warning: the action ran but was not recorded (${res.reason})`);
  else say(`  run ${evt.subject.id} under proposal:${proposalId}`);
}

// --- arm -----------------------------------------------------------------------------------
if (cmd === "arm") {
  const value = fs.readFileSync(0, "utf8");
  const r = storeReleaseToken(value, { force: has("force") });
  if (!r.ok) die(`refused: ${r.reason}`);
  console.log(`release token stored (${r.shape}, mode 0600)`);
  console.log(`  ${r.path}`);
  console.log("\nNot printed here on purpose. Delete whatever file you piped in.");
  console.log("It needs actions:write on this repository and nothing else.");
  process.exit(0);
}

// --- status --------------------------------------------------------------------------------
if (cmd === "status") {
  const slug = repoSlug();
  const tok = releaseTokenStatus();
  const h = slug ? await health(slug) : null;
  if (JSON_OUT) {
    console.log(JSON.stringify({ token: tok, repo: slug, health: h }, null, 2));
    process.exit(0);
  }
  console.log("release publishing");
  console.log(`  repo       ${slug ? `${slug.owner}/${slug.repo}` : "(no github remote)"}`);
  console.log(`  token      ${tok.configured ? `configured — ${tok.shape}` : "NOT configured"}`);
  console.log(`  source     ${tok.source || "(none)"}`);
  if (!tok.configured) {
    console.log("  arm it with: node scripts/release_raise.mjs arm < token.txt");
  }
  if (!h) process.exit(0);
  console.log(`\nfeed health  ${h.state}`);
  if (h.latest) console.log(`  latest     ${h.latest.tag} (${h.latest.assets} assets)`);
  for (const c of h.coverage) {
    console.log(
      `  ${c.platform.padEnd(8)} ${c.state.padEnd(8)} listed=[${c.listed}] published=[${c.published}]`
    );
    for (const g of c.gaps) {
      console.log(`     ${g.severity}: ${g.arch} — ${g.mitigation || "no fallback exists"}`);
    }
  }
  if (h.unpublished.length) {
    console.log(`\ntagged but never published: ${h.unpublished.join(", ")}`);
    console.log("  a tag with no release means CI started and did not finish.");
    // Say where each one has actually got to. Telling someone to raise a proposal that already
    // exists is how a queue collects two decisions about one publication, which is the exact
    // duplication gov_raise refuses — the advice should not fight the ledger.
    const gov = loadGovernance(GOV);
    for (const t of h.unpublished) {
      const p = (gov.proposals || []).find((x) => x.id === proposalIdFor(t));
      if (!p) {
        console.log(`  ${t}  not proposed — node scripts/release_raise.mjs raise --tag ${t}`);
      } else if (p.state === "open") {
        console.log(`  ${t}  proposed, awaiting a human signature in the Gov arc`);
      } else if (p.state === "signed") {
        console.log(
          `  ${t}  signed — node scripts/release_raise.mjs publish --tag ${t}` +
            (tok.configured ? "" : "  (needs a credential first)")
        );
      } else {
        console.log(`  ${t}  ${p.state} — a decision was already made about this one`);
      }
    }
  }
  process.exit(0);
}

// --- raise ---------------------------------------------------------------------------------
if (cmd === "raise") {
  const tag = arg("tag");
  if (!tag || !TAG.test(tag)) die("--tag must be a v* release tag, e.g. v1.24.1");
  const rationale =
    arg("rationale") ||
    `Publish ${tag}. The tag exists but no release was created, so the updater feed on the ` +
      "latest published release is the one every installed app is reading.";
  const id = proposalIdFor(tag);

  const gov = loadGovernance(GOV);
  if (gov.ok === false) {
    die(`governance chain is broken at line ${gov.badLine}; refusing to append`);
  }
  const existing = gov.proposals.find((p) => p.id === id);
  if (existing && existing.state !== "open") {
    die(
      `proposal '${id}' was already ${existing.state}.\n` +
        "  A publication decision is made once. If this is genuinely a new situation,\n" +
        "  the tag is new too — raise that one instead."
    );
  }

  const evt = proposalRaisedEvent({
    proposalId: id,
    machine: MACHINE,
    title: `Publish release ${tag}`,
    rationale,
    evidence: [`.github/workflows/${WORKFLOW}`],
    requestedBy: whoami()
  });
  const res = appendKelEvent(GOV, evt);
  if (!res.ok) die(`could not append: ${res.reason}`);
  say(`raised ${govSubject.proposal(id)}`);
  say(`  title      Publish release ${tag}`);
  say("\nIt is asking, not authorising. Sign it in the Gov arc, then:");
  say(`  node scripts/release_raise.mjs publish --tag ${tag}`);
  if (JSON_OUT) {
    console.log(JSON.stringify({ ok: true, proposal: govSubject.proposal(id) }, null, 2));
  }
  process.exit(0);
}

// --- publish -------------------------------------------------------------------------------
if (cmd === "publish") {
  const tag = arg("tag");
  if (!tag || !TAG.test(tag)) die("--tag must be a v* release tag, e.g. v1.24.1");
  const id = proposalIdFor(tag);

  const { ok, events, badLine } = readKelEvents(GOV);
  if (!ok) {
    die(
      `the governance ledger does not verify (line ${badLine}) — refusing to publish on the\n` +
        "  authority of a record we already know has been altered"
    );
  }
  if (!isAuthorised(events, id)) {
    const gov = loadGovernance(GOV);
    const p = gov.proposals.find((x) => x.id === id);
    die(
      `proposal '${id}' ${p ? `is still ${p.state}` : "does not exist"} — refusing to publish.\n` +
        "  Publishing puts installers on the internet under this estate's name, so unlike\n" +
        "  local machinery it may not run unauthorised and be counted afterwards.\n" +
        `  ${p ? "Sign it in the Gov arc." : `Raise it: node scripts/release_raise.mjs raise --tag ${tag}`}`
    );
  }

  const token = resolveReleaseToken();
  if (!token) {
    die(
      "no release token configured — the estate has the decision but not the authority.\n" +
        "  node scripts/release_raise.mjs arm < token.txt"
    );
  }
  const slug = repoSlug();
  if (!slug) die("no github remote — nothing to publish to");

  const remoteTag = await gh(`/repos/${slug.owner}/${slug.repo}/git/ref/tags/${tag}`);
  if (!remoteTag.ok) {
    die(`tag ${tag} is not on the remote (HTTP ${remoteTag.status}) — push it before publishing`);
  }

  say(`authorised by ${govSubject.proposal(id)} (signed)`);
  say(`dispatching ${WORKFLOW} for ${tag}…`);
  const r = await gh(`/repos/${slug.owner}/${slug.repo}/actions/workflows/${WORKFLOW}/dispatches`, {
    token,
    method: "POST",
    body: { ref: "main", inputs: { release_tag: tag } }
  });

  if (!r.ok) {
    // Recorded as a failed run rather than swallowed: an attempt to publish is an execution
    // whether or not GitHub accepted it, and a refused dispatch is exactly the kind of thing
    // that otherwise gets retried by hand until it works, unlogged.
    recordRun(`publish ${tag}`, id, "failed", { status: r.status, error: r.json?.message || null });
    die(
      `dispatch refused (HTTP ${r.status}): ${r.json?.message || r.text.slice(0, 200)}\n` +
        (r.status === 403
          ? "  403 usually means the token lacks the 'workflow' / actions:write scope."
          : "")
    );
  }

  recordRun(`publish ${tag}`, id, "ok", { workflow: WORKFLOW, tag });
  say("\ndispatched. GitHub queues the run; six architectures build, then the feeds merge.");
  say(`  watch: https://github.com/${slug.owner}/${slug.repo}/actions/workflows/${WORKFLOW}`);
  say("  the release appears only when every build succeeds — a partial run publishes nothing.");
  if (JSON_OUT) console.log(JSON.stringify({ ok: true, dispatched: tag }, null, 2));
  process.exit(0);
}

die(`unknown command '${cmd}' — expected status | arm | raise | publish`);
