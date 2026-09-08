// The credential that lets the estate publish its own releases.
//
// Publishing was the one estate action that had no path through the estate: a tag went up, a
// person opened a browser, and a release either happened or silently did not. This holds the
// token that closes that gap — a GitHub PAT scoped to `actions:write` on one repository.
//
// IT IS SUPPLIED, NEVER GENERATED. Unlike the estate register key, this secret belongs to
// GitHub, so there is no `--init` that conjures one. The owner mints it and hands it over, and
// the only supported way to hand it over is a stream this process reads once: not an argv,
// which lands in shell history and in every process listing on the machine, and not a prompt
// this agent fills in on the owner's behalf.
//
// FAIL CLOSED. No token resolves to null, `publish` refuses, and the estate keeps saying so.
// A publish path that quietly degrades to "did nothing" is worse than one that is plainly shut.
//
// NEVER PRINTED. This module returns the token to callers that must send it to GitHub and to
// nobody else. Every status surface reports presence and scope, never the value.
import fs from "node:fs";
import path from "node:path";

export const TOKEN_FILENAME = "github-release-token";

// Windows separators normalised without writing an escape that a shell heredoc can eat.
const BACKSLASH = String.fromCharCode(92);
const normaliseSeparators = (p) => String(p).split(BACKSLASH).join("/");

/** Where the token lives — beside the register key, honouring BENNY_HOME like every control. */
export function tokenPath(home = process.env.BENNY_HOME || "D:/benny-home/benny") {
  return path.join(normaliseSeparators(home), "state", TOKEN_FILENAME);
}

/** Resolve the token, or null. Env wins (CI, and tests); otherwise the keystore file.
 *  A blank file resolves to null and NOT to "" — an empty string sent as a bearer token
 *  produces a 401 that reads like a revoked credential rather than an unconfigured one. */
export function resolveReleaseToken({ home, env = process.env } = {}) {
  const fromEnv = String(env.GITHUB_RELEASE_TOKEN || "").trim();
  if (fromEnv) return fromEnv;
  try {
    const v = fs.readFileSync(tokenPath(home), "utf8").trim();
    return v || null;
  } catch {
    return null;
  }
}

/** Presence and provenance, never the value. This is what every status surface may show. */
export function releaseTokenStatus({ home, env = process.env } = {}) {
  const p = tokenPath(home);
  const fromEnv = Boolean(String(env.GITHUB_RELEASE_TOKEN || "").trim());
  const token = resolveReleaseToken({ home, env });
  return {
    path: p,
    configured: Boolean(token),
    source: fromEnv ? "GITHUB_RELEASE_TOKEN (env)" : token ? "keystore file" : null,
    // A shape hint, not the secret: enough to tell a fine-grained PAT from a classic one when
    // a dispatch is refused, without putting any of the token on a screen or in a log.
    shape: token ? tokenShape(token) : null
  };
}

/** The token's family, inferred from its documented prefix. Returns a label, never a fragment. */
export function tokenShape(token) {
  const t = String(token || "");
  if (t.startsWith("github_pat_")) return "fine-grained PAT";
  if (t.startsWith("ghp_")) return "classic PAT";
  if (t.startsWith("gho_") || t.startsWith("ghu_")) return "OAuth token";
  if (t.startsWith("ghs_")) return "GitHub App installation token";
  return "unrecognised";
}

/** Persist a token the owner supplied. Refuses to overwrite without force, because replacing a
 *  working credential by accident leaves the estate unable to publish and no trace of why. */
export function storeReleaseToken(value, { home, force = false } = {}) {
  const token = String(value || "").trim();
  if (!token) return { ok: false, reason: "no token was supplied on stdin" };
  if (/\s/.test(token))
    return { ok: false, reason: "the value contains whitespace — that is not a GitHub token" };
  const p = tokenPath(home);
  if (fs.existsSync(p) && !force)
    return { ok: false, path: p, reason: "a token already exists — pass --force to replace it" };
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, token + "\n", { encoding: "utf8", mode: 0o600 });
  return { ok: true, path: p, shape: tokenShape(token) };
}
