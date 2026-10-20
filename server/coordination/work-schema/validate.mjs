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
// The bands a contract's budget is drawn from, measured against what work of each shape has cost
// here. XL is a CEILING: work that does not fit is two contracts, split while authoring rather than
// discovered at line 880.
export const BUDGET_BANDS = Object.freeze({ S: 300, M: 500, L: 800, XL: 1000 });

export const MAX_TOKENS = 1500;
export const estimateTokens = (text) => Math.ceil(text.length / 4);

// GRANDFATHERED OVERSIZE - named, not a looser ceiling.
//
// The ceiling was calibrated against Q0 before contracts carried folded-in owner direction and
// measured numbers. Seven contracts the owner signed as written between 2026-10-11 and 2026-10-13
// are 2480-3843 tokens: the librarian (S21-S24), the drive registry and the owner's data (U0, U1)
// and the capacity report (K0). Splitting them would rewrite signed scope, and raising MAX_TOKENS
// would quietly licence every future contract to be three times the size - so each is listed here
// at the size it was measured at, and the ceiling stays 1500 for everything else.
//
// The pin is exact on purpose: a listed contract that GROWS fails again, which forces a deliberate
// re-grant rather than silent creep. Same idiom as the evidence pack's pre-control runs - excluded
// from the count, but named and visible.
export const OVERSIZE_GRANTED = Object.freeze({
  K0: 2839,
  S21: 2867, // re-granted 2026-10-18 on merge: +267 is the two owner-signed budget amendments (600->680->800) recorded in the contract on task/S21
  S22: 3687,
  S23: 3843,
  S24: 2480,
  U0: 3423,
  U1: 2809
});

// Milestone ids that exist on disk: delivery/milestones/M<n>-<name>.md -> "M<n>".
export function milestoneIds(repoRoot) {
  const dir = path.join(repoRoot, "delivery", "milestones");
  const ids = new Set();
  for (const f of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    const m = f.match(/^(M\d+)-.*\.md$/);
    if (m) ids.add(m[1]);
  }
  return ids;
}
const ID_RE = /^(?:[A-Z]\d+|M2-\d+)$/;

export function parseFrontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return null;
  const fm = {};
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = lines[i].match(/^(\w+):\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1];
    let raw = kv[2];
    let val;
    // A flow sequence may open on the key's own line or on the line below it,
    // and may wrap over several lines (prettier wraps long allowlists). Gather
    // lines until the brackets balance, else a wrapped list reads as empty.
    if (raw === "" && /^\s*\[/.test(lines[i + 1] ?? "")) raw = lines[++i].trim();
    if (raw.startsWith("[")) {
      while (!raw.includes("]") && i + 1 < lines.length) raw += " " + lines[++i].trim();
      val = raw
        .slice(1, raw.indexOf("]"))
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
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
  // The valid milestones are the ones that HAVE a file, read from disk rather than a literal
  // list. The literal froze at M10 while M11-M13 were authored, so three signed contracts were
  // reported as naming an unknown milestone when the real defect was the list.
  if (!milestoneIds(repoRoot).has(fm.milestone))
    errors.push(
      `${id}: milestone '${fm.milestone}' has no delivery/milestones file (M<n>-<name>.md)`
    );
  if (!fm.okr) errors.push(`${id}: okr missing`);
  if (!["agent-ok", "human-signed"].includes(fm.authority))
    errors.push(`${id}: authority '${fm.authority}'`);
  if (!["worktree", "in-place"].includes(fm.sandbox)) errors.push(`${id}: sandbox '${fm.sandbox}'`);
  if (!(parseInt(fm.budget, 10) > 0)) errors.push(`${id}: budget '${fm.budget}'`);
  // Budget bands (SPEC-work-contracts.md). Declared up front so the number stops being a guess
  // raised mid-flight: S21 went 600->680->800 and S22 600->800->900, four amendments in all, each
  // one interrupting the work. Where a contract names its band the budget must BE the band, and no
  // band may exceed the XL ceiling. Contracts authored before the rule carry no band and are left
  // alone rather than retro-fitted, which would rewrite signed scope.
  if (fm.band !== undefined) {
    const want = BUDGET_BANDS[fm.band];
    if (want === undefined)
      errors.push(`${id}: band '${fm.band}' is not one of ${Object.keys(BUDGET_BANDS).join(", ")}`);
    else if (parseInt(fm.budget, 10) !== want)
      errors.push(
        `${id}: band ${fm.band} is ${want} lines but budget says ${fm.budget} — split, do not raise`
      );
  }
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
  const granted = OVERSIZE_GRANTED[id];
  if (granted !== undefined ? tokens > granted : tokens > MAX_TOKENS)
    errors.push(
      granted !== undefined
        ? `${id}: ~${tokens} tokens exceeds its granted oversize of ${granted} - split it, or re-grant deliberately in OVERSIZE_GRANTED`
        : `${id}: ~${tokens} tokens exceeds the ${MAX_TOKENS} token ceiling - split the contract`
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
      // An id in a parenthetical is prose about another item ("wired to the G0 stream"), not an
      // entry: counting it put G0 and P4 on the board twice each while each appeared exactly once.
      for (const tok of line.replace(/\([^)]*\)/g, " ").split(/[\s·]+/))
        if (ID_RE.test(tok)) ids.push(tok);
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
