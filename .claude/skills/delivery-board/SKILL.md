---
name: delivery-board
description: Operate the Prime-Silo delivery board (delivery/) autonomously — select, claim, execute, verify, and log work contracts without frontier supervision. Use whenever picking up a task from delivery/board/BOARD.md, authoring a gate script, verifying another agent's task, or deciding which model tier should take which contract.
---

# Delivery-board operator — run the board without supervision

The board at `delivery/board/BOARD.md` is the single source of work. `delivery/README.md` is the
law — read it once per session, follow it exactly. This skill adds what README assumes you know:
the mechanics, the tier routing, and the traps that have actually burned agents in this repo.

## 1. The loop (memorize this shape)

```
read README → read BOARD → take TOPMOST READY item → claim (board edit + LOG line + commit)
→ read ONLY your contract (delivery/tasks/<ID>.md) → make a worktree if sandbox: worktree
→ TDD: failing test/gate FIRST, watch it fail → implement inside the allowlist → gate green
→ move board line to VERIFY + LOG `ready-for-verify` + commit → STOP (never self-DONE)
```

- **Claim commit message:** `chore(delivery): claim <ID>` · **work commits:** `feat(<ID>): <what>` /
  `test(<ID>): <scenario name>` · **verify handoff:** `chore(delivery): <ID> ready-for-verify`.
- **LOG format (append-only, never edit):** `<ISO-ts> | <ID> | <event> | <agent> | <note>`
  Events: `claimed`, `ready-for-verify`, `verified-by`, `blocked`, `unblocked`, `note`.
- **Agent identity:** use `<harness>-<tier>` (e.g. `claude-sonnet`, `claude-haiku-verifier`).
- **Promotion rule:** when the last dep of an AUTHORED item is verified DONE, move it to the
  BOTTOM of READY with a note `(dep <X> DONE — entered READY <date>)`. Anyone may promote;
  only the human reorders READY.
- **Two strikes → blocked.** Same failure twice: log `blocked` with the exact error and what you
  tried. Do not redesign around the contract. Do not brute-force a third attempt.

## 2. Model-tier routing (who takes what)

| Tier | Takes | Never takes |
|---|---|---|
| **haiku** | Independent VERIFICATION of others' tasks (re-run gate from clean checkout, tick BDD scenarios, move VERIFY→DONE), mechanical single-surface contracts (grep-and-replace passes like C4 execution, LOG/board hygiene, running gates) | Contract authoring, anything with design judgment, multi-file architecture, writing new gates |
| **sonnet** | Standard contracts: layout/CSS work (C1), SSE/API endpoints (B1), keyframe+binding work (C5), test suites, gate scripts from a spec, docs passes | Contract authoring/splitting, taste-defining UI (first impressions), cross-workstream tradeoffs |
| **opus** | Design-taste flagships (C3 login/first-run, D1 Studio spec, E-workstream visual), contract authoring/splitting at plan checkpoints, anything touching >2 workstreams, unblocking a task two tiers failed | Bulk mechanical work (wasteful) |

Verification is ALWAYS a different identity than the author — a fresh session/agent with no shared
context, reading only the contract + README, from a clean checkout. Haiku is the default verifier;
escalate to sonnet if the gate involves preview/screenshot judgment.

## 3. Worktree recipe (sandbox: worktree)

The repo lives under OneDrive; put worktrees OUTSIDE it so sync doesn't thrash:

```bash
git -C /c/Users/nsdha/OneDrive/binary16/prime-silo worktree add \
  /c/Users/nsdha/.ps-worktrees/<ID> -b task/<ID> main
```

Work + commit there. When the gate is green, hand off; the merger (or verifier) does
`git merge --no-ff task/<ID>` on main after verification, then
`git worktree remove /c/Users/nsdha/.ps-worktrees/<ID>`.
Board/LOG edits are made on MAIN directly (they are coordination, not task payload) —
claim before creating the worktree so the claim is visible to everyone immediately.
If `node_modules` are needed in the worktree: `npm ci --prefix server` (only if your gate
actually requires the server; static-analysis gates should stay zero-dep).

## 4. Gate-script craft (scripts/gates/*.mjs)

Study `scripts/gates/c0.mjs` and `w0.mjs` before writing one. House style:
- Zero-dep Node ESM (`node:fs`, `node:path`, `node:child_process` only). Exit 0 = pass,
  non-zero = fail **naming the file and the rule violated** (a gate that fails silently is a defect).
- Prefer static analysis (grep/parse the source) over spinning up servers. If a preview is
  unavoidable (C1 screenshots), make the gate degrade honestly: check what it can statically,
  print `MANUAL: <what the verifier must eyeball>` for the rest.
- Ratchet pattern for pre-existing violations: record the floor inline (`VIOLATION_FLOOR`),
  fail only if the count RISES or a new file offends (see c0.mjs).
- A gate must fail-as-designed first: run it against the pre-change tree and watch it exit
  non-zero before you implement. That IS the TDD red step for infra tasks.

## 5. Traps that have actually burned agents here

1. **`.env` contains `BENNY_HMAC_KEY` — never staged, never committed.** Same for `logs/`,
   `brain/`, `scratch/`, `site/` (unrelated WIP), and any live run workspace. Stage files BY NAME,
   never `git add -A`.
2. **The tree usually has unrelated uncommitted changes** (owner's WIP). Do not touch, stash,
   or commit them. Worktrees sidestep this — another reason to use them.
3. **Allowlist is literal.** Needing one file outside it = `blocked`, not improvisation. Tests
   for your scenarios are implied-allowed (put them in `tests/` or next to the gate).
4. **Budget = changed lines excluding tests/lockfiles.** Over budget → log `blocked: needs split`.
5. **Governed CSS is linted by c0.mjs on every commit** — no hex outside `colors.css`, no
   `text-align: justify`, base font ≥16px, exactly 3 elevation tokens. Read
   `architecture/DESIGN-SYSTEM.md` before touching any CSS. Your task's gate should CALL c0
   if you touched governed CSS.
6. **Windows + Git Bash:** shell scripts run under Git Bash (`/c/Users/...` paths); Node is the
   portable choice for gates. PowerShell 5.1 has no `&&`.
7. **Do not call the LAN LM host** (192.168.68.125:1234) — a LONGVIEW run may be in flight and
   concurrent probes wedge the engine. UI/board tasks never need it.
8. **Old routes keep working** — every UI change ships behind a flag or is additive
   (protocol rule: `PRIME_SILO_NEW_SHELL` pattern). Breaking the default experience = blocked.
9. **UI tasks read `.claude/skills/prime-silo-experience/SKILL.md`** (identity, motion doctrine,
   progressive discovery) and, if animating, `.claude/skills/animejs-scrollcraft/SKILL.md`
   (the verified anime.js v4 API — API drift is the #1 historical failure source).

## 6. Repo map for board work (verified paths)

- Board/law: `delivery/board/BOARD.md`, `delivery/board/LOG.md`, `delivery/README.md`
- Contracts: `delivery/tasks/<ID>.md` · template: `delivery/tasks/_TEMPLATE.md`
- Plan narrative: `architecture/PLAN-local-power-unified-ui.md` (§ per workstream)
- Design law: `architecture/DESIGN-SYSTEM.md` + `app/L0/_all/mod/_core/framework/css/{colors,layout,type}.css`
- Gates: `scripts/gates/` · Login page: `server/pages/login.html` (+ enter.html, index.html)
- Mascot/onscreen agent: `app/L0/_all/mod/_core/onscreen_agent/panel.html`
- Prime-Silo modules: `app/L0/_all/mod/_prime_silo/` · widgets: `app/L0/_all/mod/_core/widgets/`
- UI-UX findings: `architecture/REQUIREMENTS-ui-ux-refactor.md` (C3/C5 source — don't re-audit)
- Launch configs for preview: `../.claude/launch.json` (binary16 root; `shell` = the app on :3000)

## 7. Definition of done (verifier checklist)

All BDD scenarios have named tests · `verify` exits 0 from a clean checkout · lint/format clean ·
allowlist respected (diff audit) · budget respected · board+LOG updated at every transition ·
docs/skills updated if the contract's Handoff says so · author ≠ verifier.
