// POST /api/release_publish — act on a signed decision to publish a release.
//
// This endpoint CANNOT AUTHORISE ANYTHING. It looks for a signature that already exists and
// refuses when there is not one. That is the same division the whole estate runs on — agents
// and programs propose, humans sign — and it matters more here than anywhere else, because the
// effect is outward: installers on the internet under this estate's name, downloaded by
// machines that trust the feed.
//
// So the two halves of the authority are deliberately separated and neither is sufficient:
//
//   THE DECISION is a proposal in the governance ledger, signed by a human. Without it this
//   endpoint returns 403 and writes nothing.
//   THE CAPABILITY is a GitHub token on this machine, put there by a separate explicit act.
//   Without it the endpoint returns 409 — the estate has the decision but not the means.
//
// A request that supplies neither gets the first refusal, not a vague one: an operator who is
// told "not armed" when the real problem is "nobody signed it" goes and installs a credential
// to fix a governance gap, which is the wrong lesson to teach.
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { appendKelEvent, readKelEvents, ulid } from "../coordination/lib/kel.mjs";
import { isAuthorised, loadGovernance, subjectId } from "../coordination/lib/governance.mjs";
import { runRecordedEvent } from "../coordination/lib/runs.mjs";
import { resolveReleaseToken } from "../coordination/lib/release_token.mjs";
import { resolveEstateStore, governanceLogPath } from "../lib/estate_store.js";

const run = promisify(execFile);
const WORKFLOW = "release-desktop.yml";
const TAG = /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const MACHINE = String(process.env.COMPUTERNAME || os.hostname() || "unknown").toLowerCase();

const proposalIdFor = (tag) => `release-${String(tag).replace(/^v/, "").replace(/\./g, "-")}`;

// The project root, never process.cwd() — the server is routinely started from the directory
// above the checkout, where this git call fails and the endpoint would report "no github
// remote" for a repository that has one.
async function repoSlug(projectRoot) {
  try {
    const { stdout } = await run("git", ["remote", "get-url", "origin"], {
      cwd: projectRoot,
      timeout: 15000
    });
    const m = stdout.trim().match(/github\.com[:/]+([^/]+)\/([^/.]+)/i);
    return m ? { owner: m[1], repo: m[2] } : null;
  } catch {
    return null;
  }
}

function recordRun(task, proposalId, outcome, detail = {}) {
  const { root } = resolveEstateStore();
  const evt = runRecordedEvent({
    runId: ulid(),
    machine: MACHINE,
    task: `release ${task}`,
    kind: "estate",
    proposalId,
    outcome,
    detail
  });
  appendKelEvent(path.join(root, "eventlog", "runs.jsonl"), evt);
  return evt.subject.id;
}

export async function post(context) {
  const tag = String(context?.body?.tag || "").trim();
  if (!TAG.test(tag)) {
    return { status: 400, body: { ok: false, error: "tag must look like v1.24.1" } };
  }
  const proposalId = proposalIdFor(tag);
  const { file } = governanceLogPath();

  const { ok, events, badLine } = readKelEvents(file);
  if (!ok) {
    return {
      status: 409,
      body: {
        ok: false,
        error: `the governance ledger does not verify at line ${badLine} — refusing to publish on the authority of a record we already know has been altered`
      }
    };
  }

  // Governance first, capability second — see the header.
  if (!isAuthorised(events, proposalId)) {
    const gov = loadGovernance(file);
    const p = (gov.proposals || []).find((x) => x.id === proposalId);
    return {
      status: 403,
      body: {
        ok: false,
        error: p
          ? `proposal '${proposalId}' is still ${p.state} — a person has to sign it`
          : `no proposal '${proposalId}' exists — raise it before publishing ${tag}`,
        proposal: subjectId.proposal(proposalId),
        state: p?.state ?? null,
        sign_at: "_prime_silo/gov"
      }
    };
  }

  const token = resolveReleaseToken();
  if (!token) {
    return {
      status: 409,
      body: {
        ok: false,
        error:
          "this release is authorised, but no publishing credential is configured on this machine",
        remedy: "node scripts/release_raise.mjs arm < token.txt"
      }
    };
  }

  const slug = await repoSlug(context?.projectRoot);
  if (!slug) return { status: 409, body: { ok: false, error: "no github remote to publish to" } };

  let res;
  try {
    res = await fetch(
      `https://api.github.com/repos/${slug.owner}/${slug.repo}/actions/workflows/${WORKFLOW}/dispatches`,
      {
        method: "POST",
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "x-github-api-version": "2022-11-28"
        },
        body: JSON.stringify({ ref: "main", inputs: { release_tag: tag } }),
        signal: AbortSignal.timeout(30000)
      }
    );
  } catch (e) {
    const sid = recordRun(`publish ${tag}`, proposalId, "failed", { error: e.message });
    return {
      status: 502,
      body: { ok: false, error: `could not reach GitHub: ${e.message}`, run: sid }
    };
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    // An attempt is an execution whether or not GitHub accepted it. Recording the failure is
    // what stops a refused dispatch from being retried by hand until it works, unlogged.
    const sid = recordRun(`publish ${tag}`, proposalId, "failed", {
      status: res.status,
      error: detail.slice(0, 300)
    });
    return {
      status: 502,
      body: {
        ok: false,
        error: `GitHub refused the dispatch (HTTP ${res.status})`,
        hint:
          res.status === 403
            ? "the token is probably missing the workflow / actions:write scope"
            : null,
        run: sid
      }
    };
  }

  const sid = recordRun(`publish ${tag}`, proposalId, "ok", { workflow: WORKFLOW, tag });
  return {
    headers: { "Cache-Control": "no-store" },
    status: 200,
    body: {
      ok: true,
      tag,
      run: sid,
      proposal: subjectId.proposal(proposalId),
      // GitHub queues the run; the release exists only if every architecture builds. Saying so
      // here keeps the panel from reporting a publication that has not happened yet.
      note: "dispatched — the release appears only when all six builds succeed",
      watch: `https://github.com/${slug.owner}/${slug.repo}/actions/workflows/${WORKFLOW}`
    }
  };
}
