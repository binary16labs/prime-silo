// Work-contract validator (W0). Spec: architecture/SPEC-work-contracts.md
// Validates delivery/tasks/*.md against the contract format, token budget,
// plan-deps.json (machine-readable plan section 12), BOARD.md and TRACEABILITY.md.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const planDeps = JSON.parse(fs.readFileSync(path.join(here, "plan-deps.json"), "utf8"));
delete planDeps.$comment;

// Target is ~600 tokens; the hard ceiling accommodates the largest legitimate
// exemplar (Q0, a rescoped security sweep, ≈1440 est. tokens after its merge
// amendments). Estimator: chars/4 (deliberately simple).
export const MAX_TOKENS = 1500;
export const estimateTokens = (text) => Math.ceil(text.length / 4);
const ID_RE = /^(?:[A-Z]\d+|M2-\d+)$/;

export function parseFrontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return null;
  const fm = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^(\w+):\s*(.*)$/);
    if (!kv) continue;
    let [, key, raw] = kv;
    let val;
    if (raw.startsWith("[")) {
      const inner = raw.slice(1, raw.indexOf("]"));
      val = inner.trim() === "" ? [] : inner.split(",").map((s) => s.trim());
    } else {
      val = raw.replace(/\s+#.*$/, "").trim();
    }
    fm[key] = val;
  }
  return fm;
}

export function validateContract(text, { id, repoRoot, knownIds }) {
  const errors = [];
  const fm = parseFrontmatter(text);
  if (!fm) return { ok: false, errors: [`${id}: frontmatter missing or unparseable`] };

  if (fm.id !== id) errors.push(`${id}: frontmatter id '${fm.id}' != filename`);
  if (!fs.existsSync(path.join(repoRoot, "delivery", "epics", `${fm.epic}.md`)))
    errors.push(`${id}: epic '${fm.epic}' has no delivery/epics file`);
  if (!["M1", "M2", "M3", "M4", "M5", "M6"].includes(fm.milestone)) errors.push(`${id}: milestone '${fm.milestone}'`);
  if (!fm.okr) errors.push(`${id}: okr missing`);
  if (!["agent-ok", "human-signed"].includes(fm.authority))
    errors.push(`${id}: authority '${fm.authority}'`);
  if (!["worktree", "in-place"].includes(fm.sandbox)) errors.push(`${id}: sandbox '${fm.sandbox}'`);
  if (!(parseInt(fm.budget, 10) > 0)) errors.push(`${id}: budget '${fm.budget}'`);
  if (!Array.isArray(fm.deps)) errors.push(`${id}: deps must be a list`);
  else
    for (const d of fm.deps)
      if (!knownIds.includes(d)) errors.push(`${id}: dep '${d}' does not resolve to a task`);
  if (!Array.isArray(fm.tools) || fm.tools.length === 0) errors.push(`${id}: tools empty`);

  if (!Array.isArray(fm.allowlist) || fm.allowlist.length === 0)
    errors.push(`${id}: allowlist empty`);
  else
    for (const p of fm.allowlist) {
      if (p.includes("..") || path.isAbsolute(p)) {
        errors.push(`${id}: allowlist path '${p}' not repo-relative`);
        continue;
      }
      const root = p.split("/")[0];
      if (!fs.existsSync(path.join(repoRoot, p)) && !fs.existsSync(path.join(repoRoot, root)))
        errors.push(`${id}: allowlist root '${root}' does not exist (path '${p}')`);
    }

  if (!fm.verify) errors.push(`${id}: verify missing`);
  else {
    const gate = (fm.verify.match(/\S*scripts\/gates\/\S+/) || [])[0];
    const covered = (g) =>
      fs.existsSync(path.join(repoRoot, g)) ||
      (Array.isArray(fm.allowlist) && fm.allowlist.some((a) => g === a || g.startsWith(a)));
    if (gate && !covered(gate))
      errors.push(
        `${id}: verify gate '${gate}' neither exists nor is in the contract's own allowlist`
      );
  }

  if (!/^## Goal/m.test(text)) errors.push(`${id}: '## Goal' section missing`);
  const gherkin = text.match(/```gherkin([\s\S]*?)```/);
  if (!gherkin || !/Scenario:/.test(gherkin[1]))
    errors.push(`${id}: no gherkin Scenario — acceptance is not automatable`);

  const tokens = estimateTokens(text);
  if (tokens > MAX_TOKENS)
    errors.push(
      `${id}: ~${tokens} tokens exceeds the ${MAX_TOKENS} token ceiling — split the contract`
    );

  return { ok: errors.length === 0, errors };
}

export function detectCycle(graph) {
  const state = new Map(); // 1 visiting, 2 done
  const visit = (n, trail) => {
    if (state.get(n) === 2) return null;
    if (state.get(n) === 1) return [...trail, n];
    state.set(n, 1);
    for (const d of graph[n] ?? []) {
      const c = visit(d, [...trail, n]);
      if (c) return c;
    }
    state.set(n, 2);
    return null;
  };
  for (const n of Object.keys(graph)) {
    const c = visit(n, []);
    if (c) return c.join(" -> ");
  }
  return null;
}

function boardIds(boardText) {
  const ids = [];
  let section = "";
  for (const line of boardText.split(/\r?\n/)) {
    const h = line.match(/^## (\w+)/);
    if (h) {
      section = h[1];
      continue;
    }
    if (!section || section === "BACKLOG") continue;
    if (section === "AUTHORED") {
      for (const tok of line.split(/[\s·]+/)) if (ID_RE.test(tok)) ids.push(tok);
    } else {
      const b = line.match(/^- ([A-Z]\d+|M2-\d+)\b/);
      if (b) ids.push(b[1]);
    }
  }
  return ids;
}

function traceabilityIds(traceText) {
  const ids = [];
  for (const line of traceText.split(/\r?\n/)) {
    const cells = line.split("|").map((s) => s.trim());
    if (cells.length < 6 || cells[1] === "OKR" || /^-+$/.test(cells[1])) continue;
    for (const tok of cells[5].split(/\s+/)) if (ID_RE.test(tok)) ids.push(tok);
  }
  return ids;
}

export function validateBacklog(repoRoot) {
  const errors = [];
  const tasksDir = path.join(repoRoot, "delivery", "tasks");
  const files = fs.readdirSync(tasksDir).filter((f) => f.endsWith(".md") && f !== "_TEMPLATE.md");
  const ids = files.map((f) => f.replace(/\.md$/, ""));
  const knownIds = ids;
  const graph = {};

  for (const f of files) {
    const id = f.replace(/\.md$/, "");
    const text = fs.readFileSync(path.join(tasksDir, f), "utf8");
    const r = validateContract(text, { id, repoRoot, knownIds });
    errors.push(...r.errors);
    graph[id] = parseFrontmatter(text)?.deps ?? [];
  }

  // nothing lost between plan and backlog
  const planIds = Object.keys(planDeps);
  for (const p of planIds)
    if (!ids.includes(p)) errors.push(`plan phase ${p} has no contract in delivery/tasks/`);
  for (const t of ids)
    if (!planIds.includes(t))
      errors.push(`task ${t} is not a plan phase (scope enters via plan revs)`);
  for (const t of ids)
    if (
      planDeps[t] &&
      JSON.stringify([...graph[t]].sort()) !== JSON.stringify([...planDeps[t]].sort())
    )
      errors.push(`${t}: deps [${graph[t]}] diverge from plan section 12 [${planDeps[t]}]`);
  const cycle = detectCycle(graph);
  if (cycle) errors.push(`dependency cycle: ${cycle}`);

  // board: every id exactly once across columns
  const board = boardIds(
    fs.readFileSync(path.join(repoRoot, "delivery", "board", "BOARD.md"), "utf8")
  );
  for (const t of ids) {
    const n = board.filter((b) => b === t).length;
    if (n !== 1) errors.push(`${t}: appears ${n} times on the board (must be exactly 1)`);
  }
  for (const b of board) if (!ids.includes(b)) errors.push(`board id ${b} has no contract`);

  // traceability: every id exactly once, every row id exists
  const trace = traceabilityIds(
    fs.readFileSync(path.join(repoRoot, "delivery", "TRACEABILITY.md"), "utf8")
  );
  for (const t of ids) {
    const n = trace.filter((x) => x === t).length;
    if (n !== 1) errors.push(`${t}: appears ${n} times in TRACEABILITY (must be exactly 1)`);
  }
  for (const x of trace) if (!ids.includes(x)) errors.push(`TRACEABILITY id ${x} has no contract`);

  return { ok: errors.length === 0, errors, count: ids.length };
}
