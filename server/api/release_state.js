// GET /api/release_state — what the estate has published, and whether anyone can install it.
//
// The update path had no surface. The desktop host knew whether it could update itself, the
// workflow knew whether it had published, and nothing joined the two — so a release that half
// happened looked identical to one that went fine until somebody's app stopped updating.
//
// IT IS RATE-LIMITED BY SOMEBODY ELSE. Unauthenticated GitHub allows sixty requests an hour per
// address and this endpoint spends four of them per refresh. A panel polling every few seconds
// would exhaust that in minutes and then report "unknown" for the rest of the hour — the
// surface would break the very check it exists to show. Hence a short server-side cache, shared
// by every viewer, with the age of the answer returned so the page can say how old it is
// instead of implying it is live.
//
// THE TOKEN IS NEVER SENT TO THE BROWSER. Presence and family only; the panel needs to know
// whether publishing is armed, not what the credential is.
import { parseFeed, releaseHealth } from "../coordination/lib/releases.mjs";
import { releaseTokenStatus } from "../coordination/lib/release_token.mjs";
import { loadGovernance } from "../coordination/lib/governance.mjs";
import { governanceLogPath } from "../lib/estate_store.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const TTL_MS = Number(process.env.RELEASE_STATE_TTL_MS || 300000);
const WORKFLOW = "release-desktop.yml";

let cache = { at: 0, value: null };

async function gh(pathname) {
  try {
    const res = await fetch(`https://api.github.com${pathname}`, {
      headers: {
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28"
      },
      signal: AbortSignal.timeout(15000)
    });
    if (!res.ok) return { ok: false, status: res.status, json: null };
    return { ok: true, status: res.status, json: await res.json() };
  } catch {
    return { ok: false, status: 0, json: null };
  }
}

// git runs in the PROJECT ROOT, never in process.cwd(). The server is routinely started from
// the directory above the checkout — `node prime-silo/space.js serve` — and inside that parent
// `git remote get-url origin` fails, which this endpoint reported as "no github remote on this
// checkout". A true statement about the wrong directory, and the surface said the estate had
// nothing to publish to.
async function gitLines(args, projectRoot) {
  try {
    const { stdout } = await run("git", args, { cwd: projectRoot, timeout: 15000 });
    return stdout
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

async function repoSlug(projectRoot) {
  const [url] = await gitLines(["remote", "get-url", "origin"], projectRoot);
  const m = String(url || "").match(/github\.com[:/]+([^/]+)\/([^/.]+)/i);
  return m ? { owner: m[1], repo: m[2] } : null;
}

async function fetchHealth(projectRoot) {
  const slug = await repoSlug(projectRoot);
  if (!slug) {
    return {
      // Not a failure of the release: a checkout with no GitHub remote has nothing to publish
      // to, and saying so is different from saying the feeds are broken.
      reachable: false,
      reason: "no github remote on this checkout",
      repo: null,
      health: null
    };
  }

  const rels = await gh(`/repos/${slug.owner}/${slug.repo}/releases?per_page=10`);
  if (!rels.ok) {
    return {
      reachable: false,
      reason:
        rels.status === 403
          ? "GitHub is rate-limiting this address — the answer would be a guess"
          : `GitHub did not answer (HTTP ${rels.status || "network"})`,
      repo: slug,
      health: null
    };
  }

  const releases = Array.isArray(rels.json) ? rels.json : [];
  const release = releases.find((r) => !r.draft) || null;
  const feeds = {};
  if (release) {
    await Promise.all(
      [
        ["windows", "metadata-latest-windows.yml"],
        ["mac", "metadata-latest-mac.yml"],
        ["linux", "metadata-latest-linux.yml"]
      ].map(async ([platform, name]) => {
        const asset = (release.assets || []).find((a) => a.name === name);
        if (!asset) {
          feeds[platform] = null;
          return;
        }
        try {
          const r = await fetch(asset.browser_download_url, {
            signal: AbortSignal.timeout(15000)
          });
          feeds[platform] = r.ok ? parseFeed(await r.text()) : null;
        } catch {
          feeds[platform] = null;
        }
      })
    );
  }

  const tags = await gitLines(["tag", "--list", "v*"], projectRoot);
  return {
    reachable: true,
    reason: null,
    repo: slug,
    health: releaseHealth({ release, feeds, tags, releases })
  };
}

export async function get(context) {
  const fresh = String(context?.query?.fresh ?? "") === "1";
  const now = Date.now();
  if (fresh || !cache.value || now - cache.at > TTL_MS) {
    cache = { at: now, value: await fetchHealth(context?.projectRoot) };
  }

  // The publish half: is there a decision, and is there authority to act on it. Both are local
  // reads, so they are never cached — a signature made ten seconds ago must show immediately or
  // the operator signs it twice.
  const token = releaseTokenStatus();
  const gov = loadGovernance(governanceLogPath().file);
  const proposals = (gov.proposals || [])
    .filter((p) => /^release-/.test(p.id))
    .map((p) => ({
      id: p.id,
      title: p.title,
      state: p.state,
      // The tag this decision is about, recovered from the derived id so the panel can line a
      // proposal up against the release it authorises.
      tag: `v${String(p.id)
        .replace(/^release-/, "")
        .replace(/-/g, ".")}`
    }));

  return {
    headers: { "Cache-Control": "no-store" },
    status: 200,
    body: {
      at: new Date().toISOString(),
      // How stale the GitHub half is. A surface that cannot say this implies it is live.
      age_seconds: Math.round((now - cache.at) / 1000),
      ttl_seconds: Math.round(TTL_MS / 1000),
      ...cache.value,
      workflow: WORKFLOW,
      publish: {
        armed: token.configured,
        credential: token.shape,
        // Named so the panel can explain a refusal without the operator reading a script.
        note: token.configured
          ? "publishing is armed; a signed proposal is still required for each release"
          : "no release credential on this machine — publishing is refused before it starts",
        proposals
      },
      // The panel offers no publish button of its own: see release_publish.js. Stated in the
      // payload so a future renderer cannot quietly assume otherwise.
      signing_happens_in: "_prime_silo/gov"
    }
  };
}
