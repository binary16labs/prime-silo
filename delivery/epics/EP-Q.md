# EP-Q — Security, SRE & quality pipeline

**Objective:** O4 · **Goals:** P7 · **Milestone:** M1 (Q0 is task #1 of everything)
**Plan source:** `../../architecture/PLAN-local-power-unified-ui.md` (workstream Q)

Fix live vulns now; reproducible supply chain; CI quality wall incl. path/encoding lint (top measured failure class); boot-verified releases; runbook.

## Phases → task contracts

- [ ] `Q0` — security remediation (lodash/js-yaml, burned mesh key, loopback default, ADR-003 residual)
- [ ] `Q1` — lockfiles + SBOM + dependabot
- [ ] `Q2` — CI wall (pytest in CI, audits, secrets scan, CodeQL, coverage ratchet, path/encoding lint, plan-gate runner)
- [ ] `Q3` — release SRE (boot-the-artifact smoke, /healthz, structured logs, RUNBOOK-release)

## Exit

All phase gates green, verified by non-author agent; close with a VISION-CHECK note (plan §0.5):
which KRs moved, measured evidence, one honest sentence on drift.
