// Stage gate: after each pipeline phase, check what the phase PRODUCED, not
// only how its process exited.
//
// Why (C0, 2026-11-21): three phases printed ✓ while failing. code and enrich
// died on import, and the SAD's PDF gate failed on one broken diagram. Each
// child logged "FAILED" and still exited 0. The exit code is the child's
// opinion. This gate reads the ledger the phase wrote and the files it was
// meant to write, so a phase that lies about success is stopped before the
// next stage builds on it.
//
// Verdicts:
//   pass — the phase's output contract holds
//   warn — the output exists but has known quality gaps (e.g. book sections
//          that kept their best draft); recorded, the run continues
//   fail — the output is missing, stale, or the phase recorded an error;
//          the run stops here (auto-resume still retries infra wedges)
//
// Quality THRESHOLDS (how many gate-failed sections are too many) belong to
// the frozen rubric (EP-Y Y2, human-signed), so this gate never invents one:
// soft quality gaps are warn, never fail.

const SLACK_MS = 2000; // clock/FS mtime rounding

// entries written by THIS run of the phase
const since = (ledger, phase, startedMs) =>
  ledger.filter((e) => e.phase === phase && Date.parse(e.ts) >= startedMs - SLACK_MS);

function fileCheck(stat, p, startedMs, minBytes, label) {
  const s = p ? stat(p) : null;
  if (!s) return { ok: false, check: label, why: "missing" };
  if (s.size < minBytes) return { ok: false, check: label, why: `${s.size} bytes` };
  if (s.mtimeMs < startedMs - SLACK_MS) return { ok: false, check: label, why: "not rewritten by this run (stale)" };
  return { ok: true, check: label, why: `${s.size} bytes` };
}

// A phase-level ledger result is required for phases that write one; absence
// means the phase returned without saying what happened — that is a failure.
function ledgerResult(entries, phase, isResult = (e) => !e.artifact) {
  const results = entries.filter(isResult);
  if (!results.length) return { ok: false, check: `${phase} result`, why: "phase wrote no result to the ledger" };
  const last = results[results.length - 1];
  const ok = last.ok === true || (last.ok === undefined && last.exit === 0);
  const why = ok
    ? "ok"
    : last.error || last.tail || (last.exit !== undefined ? `exit ${last.exit}` : "ok:false");
  return { ok, check: `${phase} result`, why: String(why).slice(0, 300) };
}

const CONTRACTS = {
  code: ({ entries }) => [ledgerResult(entries, "code")],
  enrich: ({ entries }) => [ledgerResult(entries, "enrich")],
  sad: ({ entries, stat, paths, startedMs }) => {
    const checks = [
      ledgerResult(entries, "sad", (e) => e.flow === "togaf_epic_v7"),
      fileCheck(stat, paths.sadMd, startedMs, 10000, "SAD markdown"),
      fileCheck(stat, paths.sadPdf, startedMs, 10000, "SAD PDF")
    ];
    // Repairs and fallbacks pass the gate but are never silent.
    const rep = entries.filter((e) => e.artifact === "md_repair").pop();
    if (rep && rep.ok) {
      const n = Object.values(rep.fixes || {}).reduce((a, b) => a + b, 0);
      if (n)
        checks.push({ ok: false, soft: true, check: "fence repair", why: `${n} fence fix(es): ${Object.entries(rep.fixes).map(([k, v]) => `${v} ${k}`).join(", ")}` });
      if (rep.fallback?.length)
        checks.push({ ok: false, soft: true, check: "diagram fallback", why: `${rep.fallback.length} diagram(s) printed as source (#${rep.fallback.join(", #")})` });
    }
    const scan = entries.find((e) => e.artifact === "code_scan");
    if (scan && !scan.ok)
      checks.push({ ok: false, soft: true, check: "code graph refresh", why: `exit ${scan.exit} — robustness may be thin` });
    return checks;
  },
  opus: ({ entries, stat, paths, startedMs }) => {
    const sections = entries.filter((e) => String(e.artifact || "").startsWith("section:"));
    const crashed = sections.filter((e) => e.error);
    const gateFailed = sections.filter((e) => !e.ok && !e.error);
    const coverage = entries.filter((e) => e.artifact === "coverage").pop();
    const checks = [fileCheck(stat, paths.bookMd, startedMs, 10000, "book markdown")];
    checks.push(
      crashed.length
        ? { ok: false, check: "sections written", why: `${crashed.length} section(s) crashed: ${crashed.slice(0, 3).map((e) => e.artifact.slice(8)).join(", ")}` }
        : { ok: true, check: "sections written", why: `${sections.length} written` }
    );
    if (!coverage) checks.push({ ok: false, check: "coverage", why: "no coverage record — the book was not assembled" });
    else {
      if (coverage.sections_missing > 0)
        checks.push({ ok: false, check: "coverage", why: `${coverage.sections_missing} section(s) missing` });
      if (!coverage.ok)
        checks.push({ ok: false, soft: true, check: "citation coverage", why: `${(coverage.citation_coverage * 100).toFixed(1)}% is below the threshold` });
    }
    if (gateFailed.length)
      checks.push({
        ok: false,
        soft: true,
        check: "section quality gate",
        why: `${gateFailed.length} of ${sections.length} kept their best draft`,
        sections: gateFailed.map((e) => e.artifact.slice(8))
      });
    return checks;
  },
  pdf: ({ entries, stat, paths, startedMs }) => {
    const checks = [ledgerResult(entries, "pdf"), fileCheck(stat, paths.bookPdf, startedMs, 10000, "book PDF")];
    const rep = entries.filter((e) => e.artifact === "md_repair").pop();
    const n = rep?.ok ? Object.values(rep.fixes || {}).reduce((a, b) => a + b, 0) : 0;
    if (n)
      checks.push({ ok: false, soft: true, check: "fence repair", why: `${n} fence fix(es): ${Object.entries(rep.fixes).map(([k, v]) => `${v} ${k}`).join(", ")}` });
    return checks;
  }
};

// Pure: everything it reads is injected, so the tests drive it with fakes.
//   ledger: parsed ledger entries; stat(path) → {size, mtimeMs} | null
export function checkPhase(id, { exitOk, startedMs, ledger = [], stat = () => null, paths = {} }) {
  const entries = since(ledger, id, startedMs);
  const checks = [];
  if (!exitOk) checks.push({ ok: false, check: "process exit", why: "non-zero exit" });
  const crash = entries.find((e) => e.action === "phase_error");
  if (crash) checks.push({ ok: false, check: "phase error", why: String(crash.error || "phase_error").slice(0, 300) });
  const contract = CONTRACTS[id];
  if (contract) checks.push(...contract({ entries, stat, paths, startedMs }));
  const hard = checks.filter((c) => !c.ok && !c.soft);
  const soft = checks.filter((c) => !c.ok && c.soft);
  const verdict = hard.length ? "fail" : soft.length ? "warn" : "pass";
  return {
    id,
    verdict,
    contract: contract ? "outputs" : "exit-code only",
    checks,
    problem: hard.length ? hard.map((c) => `${c.check}: ${c.why}`).join("; ") : null,
    warnings: soft.map((c) => `${c.check}: ${c.why}`)
  };
}

export const PHASES_WITH_CONTRACTS = Object.keys(CONTRACTS);
