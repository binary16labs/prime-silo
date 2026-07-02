# Judge calibration — measured, not assumed (2026-06-29)

Honest record of how the available local judge models actually behave, so we pick
on evidence (memo-ray token-audit lesson). **Small sample — directional, not
definitive.** Re-run when models change.

## Method

Task: `slugify(s)` — lowercase, strip, collapse non-alphanumeric runs to a single
hyphen, trim. Two artifacts scored by each judge via `gate.run_judge` (forced
`response_format: json_object`, think-off, one retry, last-balanced-JSON parse):

- **GOOD** — a correct implementation (want score **high**, ≥0.7)
- **BAD** — `def make_slug(text): return text.replace(" ", "-")` (want **low**, <0.5)

## Results

| Judge (lemonade/…)          | GOOD       | BAD          | Speed   | Failure mode                                    |
| --------------------------- | ---------- | ------------ | ------- | ----------------------------------------------- |
| `Qwen2.5-0.5B-Instruct-CPU` | 0.95 ✓     | 0.9 ✗ / None | ~5–6 s  | **false positive** (passes bad)                 |
| `Phi-4-mini-instruct-NPU`   | None/0.0 ✗ | 0.0 ✓        | ~5–16 s | **false negative** (escalates good)             |
| `deepseek-r1-8b-FLM`        | —          | —            | ~68 s   | never emits JSON (reasoning) → always escalates |

## Decision

**Default judge = `Phi-4-mini-instruct-NPU`.** For a gate, _never passing bad work_
beats _never escalating good work_: a false positive ships a defect; a false
negative just bounces good work back to the planner (safe, wasteful). The 0.5B
rubber-stamped clearly-broken code (0.9) — disqualifying. Reasoning models (R1) are
unusable as judges.

## Honest consequence

With the current local judges, **YELLOW (judged `generate`) tasks will frequently
escalate** even when the work is good — so they save few tokens today. **Reliable
savings come from GREEN tasks** (`shell`/deterministic codemods the gate can prove)
and from writing `verify` commands into acceptance criteria wherever possible. The
LLM judge is an _advisory_ tier on top of the trustworthy deterministic gate, not a
replacement for it. A more capable non-reasoning instruct model that loads on this
box would lift yellow-task savings — that's the gating dependency.
