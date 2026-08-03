# OKRs — Prime-Silo unification (H2 2026)

> North star: **a local-first AI workbench — plan strategically with a frontier agent while local models
> execute deterministically: offline-capable, auditable, calm to use.**
> Objectives map the plan's goal tree (P1–P9). Key results are measured, never vibes; each names its instrument.

## O1 — Local AI does the heavy lifting _(P1, P9)_

- **KR1.1** ADR-004 offload path verified green against real qwen3.5-9B-FLM @16k (gate `a0.py`) — currently UNVERIFIED.
- **KR1.2** 9 dev+knowledge task types run offline end-to-end with judge acceptance (gates `a2/a3/a5`).
- **KR1.3** A frontier agent delegates work mid-session and receives honest results incl. honest failures (gate `a4`).
- **KR1.4** Sovereignty gradient live: zero-capable-hardware user still gets full data sovereignty (gate `a6`).
- **KR1.5** A **house-method QLoRA model**, trained on the code + LONGVIEW corpus, **measurably beats its base**
  on a held-out method/agent eval and **drives the offload path** — currently UNTRAINED (gates `t3`/`t4`, EP-T/M3).
- **KR1.6** Two or more candidate engines are **ranked on the same instrument** over the estate's own
  agent loop, every metric either measured or explicitly `unmeasured`; the incumbent is displaced only
  on evidence (gates `p1/p4`). Added by plan rev 2026-08-03 — KR1.5 is closed and covers beating a
  base, not comparing engines.

## O2 — One coordinated, deterministic delivery system _(P2, P3, P9)_

- **KR2.1** 3+ agents (Claude, Antigravity, Benny) share one ledger; zero double-claims across 20-race test (gate `b0`).
- **KR2.2** Every run is one event stream = progress + telemetry + lineage; TUI and Bridge render it identically (gates `g0/g1/g2`).
- **KR2.3** A full plan phase delivered end-to-end via `work next` with no read of the plan file (gate `w3`).
- **KR2.4** 100% of DONE tasks were verified by a non-author agent (audit of `board/LOG.md` / ledger).

## O3 — One calm, accessible product _(P5, P8)_

- **KR3.1** New shell parity flip complete; zero "Space Agent" user-facing strings (gates `c4/c6`).
- **KR3.2** Graph views fill ≥90% of pane at 1280/1920/3840 — squashed-graphs defect dead (gate `c1`).
- **KR3.3** WCAG 2.2 AA audit passes at parity flip (C6); Readable-font + progressive-disclosure rules enforced by lint (gate `c0`).
- **KR3.4** Studio: grounded chat with passage-jump citations + 4 output types incl. Audio Overview (gates `d2/d3`).

## O4 — Trust is the feature _(P4, P6, P7)_

- **KR4.1** Security wall in CI: audits, secrets scan, CodeQL, path/encoding lint ratchet — canary PRs rejected (gate `q2`).
- **KR4.2** Every release artifact boots before publish; runbook executed by a fresh agent from doc alone (gate `q3`).
- **KR4.3** Website ships zero unvalidated claims — claims.json gate green; real MCP-captured demo (gates `e0/e2`).
- **KR4.4** Reverse-engineering: fixture SAD 100% citation-grounded, interface catalog set-equal to graph (gate `r2`).

## Scoring

Quarterly (or at each milestone close): each KR scored 0.0–1.0 by its gate/instrument output, recorded in
`board/LOG.md` as `okr-score` events. Target ≥0.7 average per objective; a KR that can't be measured scores 0.
