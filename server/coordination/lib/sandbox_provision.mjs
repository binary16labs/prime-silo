// W2 — sandbox + tool provisioning. The allowlist stops being discipline and becomes machinery.
//
// The three checks below are PURE functions over injected inputs: a verifier can break each one
// deterministically without a git repo. Only `provisionSandbox` shells out, and the gate enforces
// that split by scanning this file.
//
// NAMING NOTE (unresolved, owner's call — see LOG 2026-08-03): `SPEC-work-contracts.md:22` and this
// task's contract both say `.worktrees/<id>` on branch `feat/<id>`. Every branch in this repo is
// `task/*`, and the delivery-board skill says worktrees must live OUTSIDE the OneDrive-synced tree
// or sync thrashes — and `.worktrees/` is inside it. Defaults here follow OBSERVED PRACTICE; the
// spec's layout is available via options so neither is hard-coded away.
//
// Contract: delivery/tasks/W2.md
import path from "node:path";
import { spawnSync } from "node:child_process";

export const DEFAULTS = {
  worktreeRoot: process.env.PRIME_SILO_WORKTREES || null, // null → resolved next to the repo
  branchPrefix: "task/"
};

const LOCKFILES = /(^|\/)(package-lock\.json|requirements\.lock|.*\.lock)$/;
const TESTS = /(^|\/)tests?\//;

/** True when `file` is covered by an allowlist entry (exact file, or a directory prefix). */
function covered(file, allowlist) {
  const f = file.replace(/\\/g, "/");
  return allowlist.some((raw) => {
    const a = raw.replace(/\\/g, "/").trim();
    if (!a) return false;
    return a.endsWith("/") ? f.startsWith(a) : f === a || f.startsWith(a + "/");
  });
}

/**
 * PURE. Refuse a change set that escapes the contract's allowlist, NAMING the offenders — a check
 * that fails without saying which file is a check nobody can act on.
 */
export function checkAllowlist(changedFiles, allowlist) {
  const violations = (changedFiles ?? []).filter((f) => !covered(f, allowlist ?? []));
  return {
    ok: violations.length === 0,
    violations,
    reason: violations.length ? `outside allowlist: ${violations.join(", ")}` : null
  };
}

/**
 * PURE. Refuse an over-budget diff, reporting the count. Tests and lockfiles are excluded per
 * SPEC-work-contracts.md — the budget measures authored change, not fixtures.
 * @param numstat [{ file, added, deleted }]
 */
export function checkBudget(numstat, budget) {
  const counted = (numstat ?? []).filter(
    (r) => !TESTS.test(r.file.replace(/\\/g, "/")) && !LOCKFILES.test(r.file.replace(/\\/g, "/"))
  );
  const lines = counted.reduce((n, r) => n + (r.added ?? 0) + (r.deleted ?? 0), 0);
  return {
    ok: lines <= budget,
    lines,
    budget,
    reason: lines > budget ? `diff is ${lines} lines, budget is ${budget}` : null
  };
}

/**
 * PURE (the probe is injected). A declared tool that is not available must block BEFORE work starts,
 * naming the tool — discovering it three steps in is how a task ends up half-done.
 * @param probe (tool) => boolean
 */
export function preflightTools(tools, probe) {
  const missing = (tools ?? []).filter((t) => !probe(t));
  return {
    ok: missing.length === 0,
    missing,
    reason: missing.length ? `declared tool unavailable: ${missing.join(", ")}` : null
  };
}

// === IMPURE BELOW THIS LINE ===
// Everything above is a pure function of injected inputs and is testable without a git repo or a
// filesystem. Everything below touches the system. The w2 gate slices this file on this marker and
// fails if a process call appears above it — so the boundary is enforced, not merely intended.

/** Default probe: a binary on PATH, or an `mcp:<name>` server assumed present when declared. */
export function defaultProbe(repoRoot = process.cwd()) {
  return (tool) => {
    if (tool.startsWith("mcp:")) return true; // MCP mounting is the harness's business, not git's
    const which = process.platform === "win32" ? "where" : "which";
    return spawnSync(which, [tool], { cwd: repoRoot, stdio: "ignore" }).status === 0;
  };
}

/**
 * IMPURE. Provision the declared sandbox for a task. `in-place` provisions nothing by design.
 * Returns the worktree path and branch so the caller can report them honestly.
 */
export async function provisionSandbox(taskId, contract, opts = {}) {
  const {
    repoRoot = process.cwd(),
    sandbox = contract?.sandbox ?? "worktree",
    branchPrefix = DEFAULTS.branchPrefix,
    run = (args, cwd) => spawnSync("git", args, { cwd, encoding: "utf8" })
  } = opts;

  const tools = preflightTools(contract?.tools ?? [], opts.probe ?? defaultProbe(repoRoot));
  // Spread FIRST, then the machine-readable reason — otherwise preflightTools' own prose `reason`
  // overwrites it and callers switching on `reason` silently stop matching.
  if (!tools.ok) return { ok: false, ...tools, reason: "tool-unavailable", detail: tools.reason };

  if (sandbox === "in-place") return { ok: true, sandbox, path: repoRoot, branch: null };

  const worktreeRoot =
    opts.worktreeRoot ?? DEFAULTS.worktreeRoot ?? path.join(path.dirname(repoRoot), ".ps-worktrees");
  const dir = path.join(worktreeRoot, taskId);
  const branch = `${branchPrefix}${taskId}`;
  const r = run(["worktree", "add", dir, "-b", branch, opts.base ?? "main"], repoRoot);
  if (r.status !== 0)
    return { ok: false, reason: "worktree-failed", detail: (r.stderr || "").trim(), path: dir, branch };
  return { ok: true, sandbox, path: dir, branch };
}

/** IMPURE. Remove a provisioned worktree once its task is done. */
export function releaseSandbox(taskId, opts = {}) {
  const {
    repoRoot = process.cwd(),
    run = (args, cwd) => spawnSync("git", args, { cwd, encoding: "utf8" })
  } = opts;
  const worktreeRoot =
    opts.worktreeRoot ?? DEFAULTS.worktreeRoot ?? path.join(path.dirname(repoRoot), ".ps-worktrees");
  const r = run(["worktree", "remove", path.join(worktreeRoot, taskId)], repoRoot);
  return { ok: r.status === 0, detail: (r.stderr || "").trim() };
}
