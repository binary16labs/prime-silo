# Kanban board (canonical until Bridge B3 renders the ledger)

> Rules: agents take the TOPMOST item in READY. WIP limit: 1 per agent. Moves are commits.
> Only the non-author verifier moves VERIFY → DONE. Order in READY = priority (human-edited only).
> AUTHORED = contract exists in tasks/ but dependencies are not DONE yet; items move to READY
> (bottom, owner may reorder) when their last dep is verified DONE. Gate: scripts/gates/w0.mjs.

## READY  (take from the top)
- B1 — coordination server API + SSE  *(dep B0 DONE — entered READY 2026-07-07)*
- Q1 — reproducible supply chain  *(dep Q0 DONE — entered READY 2026-07-07)*
- E0 — website design brief + claims registry  *(zero-dep — entered READY 2026-07-07; human-signed)*
- L4 — delta engine (per-content-hash cursors)  *(dep L0 DONE — entered READY 2026-07-25)*
- L2 — inbound integrity gate  *(dep L1 DONE — entered READY 2026-07-25)*
- L3 — backup/replication  *(dep L1 DONE — entered READY 2026-07-25; human-signed)*

## CLAIMED (agent · date)

## VERIFY (awaiting non-author verification)
- T4 — wire tuned model behind Benny's router + offload · author claude-opus · in-place @ main @ HEAD · 2026-07-24 *(GATE GREEN: additive candidate house/qwen2.5-coder-tuned registered, default qwen3_5_9b unchanged, resolver additive, unhealthy->fallback no crash; LIVE on the eGPU via LM Studio — tuned engine ran a real ADR-004 offload task, gemma-3-4b judge scored 1.0 (anti-collusion), status=passed honest ledger, no-regression vs qwen3.5-9b. Allowlist amended (+gate.py): fixed run_judge response_format:json_object which LM Studio 400s — provider-agnostic retry-without. Tests: router 5/5, offload judge-compat+calibration pass. Verifier: python scripts/gates/t4.py with LM Studio serving the tuned model on the eGPU)*
- C3 — login + first-run retheme · author claude-opus · branch task/C3 @ f94830f · 2026-07-12 *(budget amended 300→1100 by owner directive — flagship scope, see LOG)*

## DONE (id · verified-by · date)
- L1 — portable CAS staging on D: · verified-by claude-l1-verifier · 2026-07-25 *(INDEPENDENT: gate GREEN reproduced from a clean task/L1 checkout — `node scripts/gates/l1.mjs` 5/5 (all 4 BDD scenarios + content-addressed path). NEGATIVE probes fired via own scratch script importing staging.mjs: de-dup keys on CONTENT not sid (two different contents → two distinct blobs; identical content from different sids/machines → ONE blob, second deduped:true, both index records reference the same sha256:<hash>); plug-and-play (openStaging(root) returns resolved roots + staged sids with no env/config); KEL binding (session_staged subject.content_hash === sha256:<blob hash>, readKelEvents ok:true chain intact); content-integrity (stored blob bytes re-hash to the addressed hash). MUTATION test proves non-vacuous: broke casStore to always-write/never-dedup → gate RED (de-dup scenario fails, exit 1), `git checkout --` reverted → gate GREEN again. Allowlist-clean: only architecture/SPEC-knowledge-eventlog.md (ADDITIVE +Staging section, no L0 rewrite), server/coordination/lib/staging.mjs, tests/staging/, scripts/gates/l1.mjs (304 insertions, no out-of-list files). Merged @ 2cdb369; post-merge l1+w0 both GREEN. CAVEAT: fresh-context subagent verify, same harness/model family as author (not a cross-harness verify); human-signed contract, owner authorized execution 2026-07-25.)*
- L0 — knowledge event log (KEL) · verified-by claude-l0-verifier · 2026-07-25 *(INDEPENDENT: gate GREEN reproduced from clean task/L0 checkout — `node scripts/gates/l0.mjs` 7/7 (all 5 BDD scenarios + envelope missing-field/bad-enum). NEGATIVE probes fired via own scratch script importing kel.mjs: tamper the MIDDLE line of a 3-event log → readKelEvents ok:false badLine=3 (successor of edit); missing required field / forged enum / empty subject.id → validateKelEvent rejects; tombstoned event removes subject from foldProjection (as-of-before still shows it). MUTATION test proves non-vacuous: disabled the chain check in kel.mjs → gate RED (chain-betrays test fails, exit 1), `git checkout --` reverted → gate GREEN again. Allowlist-clean (SPEC-knowledge-eventlog.md, kel-event.schema.json, kel.mjs, tests/kel/, gates/l0.mjs — 473 insertions, no out-of-list files). Merged @ 1604dec; post-merge l0+w0 both GREEN. CAVEAT: fresh-context subagent verify, same harness/model family as author (not a cross-harness verify); human-signed contract, owner authorized execution 2026-07-25.)*
- T5 — DPO on the SFT adapter · verified-by claude-t5-verifier · 2026-07-25 *(INDEPENDENT: reproduced the DPO NLL fresh (run_eval on the DPO adapter) => agg_nll 1.121841 matches author to 6 decimals; DPO 1.1218 <= SFT 1.1253 confirmed (+0.0035, MARGINAL +0.3%). Prefs verified genuine — 749 hard-negatives, 0 chosen==rejected, ALL from train split, 0 eval leakage. NEGATIVE tests fire: swapped reports => RED dpo_worse, missing GGUF => RED gguf_missing (gate not vacuous). Own llama-server /health smoke on the DPO q4_k_m GGUF = OK. Gate GREEN. HONEST: DPO beats SFT but marginally — SFT v3 already captured most signal; ranking gains (margins 0->4.47) dont show in NLL. Hardware finding recorded: DPO on 7B needs VRAM-ckpt+max_seq512 for the 16GB host. Closes KR1.5 with T3+T4.)*
- T3 — first QLoRA run + base-vs-tuned eval · verified-by claude-t3-verifier · 2026-07-24 *(INDEPENDENT reproduction: re-ran the NLL instrument fresh on both models — base 2.3153 / tuned 0.8678 agg_nll, matches author to 6 decimals; own disjointness check overlap=0 both streams; NEGATIVE tests — swapped reports → RED tuned_worse, missing GGUF → RED gguf_missing (gate not vacuous); t2 leak gate re-run 0 hits on all 2563 rows; own llama-server /health smoke on the q4_k_m GGUF = OK; gate re-run GREEN exit 0. KR1.5 evidence stands: tuned beats base −62.5% agg NLL, RAG disabled, frozen rubric. Caveats carried: same-session author-verify (fresh separate session could re-verify); tool-name greedy pass not re-run (secondary metric; NLL is the gate rule); re-verify needs eGPU + D: attached. Unblocks T4.)*
- T2 — instruction+trajectory dataset · verified-by claude-t2-verifier · 2026-07-23 *(reproduced GREEN: deleted the author's dataset, `node scripts/gates/t2.mjs` rebuilt it fresh from the corpus and validated — A 63 + B 500, split disjoint, leak-gate 0 hits, deterministic same result. Independent checks: 4/4 unit tests; NEGATIVE test — injected a "curriculum vitae" row → gate went RED (leak fires, not vacuously green); own disjoint check overlap=0 both streams. Rows verified present-but-git-ignored. Non-blocking caveats: hand-audited ~200-row gold subset still open before T3; bounded trace slice (6000/500, env-tunable); author worked in-place on main not the contract worktree; same-session author-verify (fresh separate agent could re-verify). Unblocks T3 (now has T0+T2).)*
- T1 — clone Benny home to trainer · verified-by claude-t1-verifier · 2026-07-23 *(reproduced GREEN from a clean session on the T480: `node scripts/gates/t1.mjs` — Node+Python resolvers both resolve D:\benny-home (via persisted prime-silo-config.json, no env set), and independent cross-checks matched the gate exactly (61 cards, 572 chroma vectors, 80,554 memo-ray entities / 278 sessions), all read LOCAL, zero remote-host env → no desktop/LAN dependency. benny-home runs off external D: (C: too small); memo-ray on canonical .mem0ray. Non-blocking caveats: full Neo4j/server boot deferred (repo .env still hardcodes old C:\ paths, outside T1 allowlist); provenance records timestamp + file/byte counts, not per-store cryptographic checksums. Re-verify needs D: attached.)*
- T0 — prove RDNA4 eGPU QLoRA trainer · verified-by claude-t0-verifier · 2026-07-23 *(reproduced GREEN on the T480 gfx1200 eGPU from a fresh session: author artifacts moved to *.author-bak, smoke regenerated in trainer venv, gate re-run — gfx1200 / 15.9 GiB, steps=30, loss 2.2888→1.4939 decreasing, reloadable adapter, exit 0. Honest caveat: smoke used Llama-3.2-1B eager path per owner verifier instruction, not the BDD's Qwen2.5-Coder-7B — RDNA4 4-bit QLoRA capability is proven; base model is a smoke fixture. Unblocks T3's T0-dep; T3 still needs T2.)*
- C1 — adaptive layout contract · verified-by claude-sonnet-verifier · 2026-07-12 *(merged to main 2026-07-12 @ 1c0a19e; MANUAL 3-res screenshot deferred to post-merge preview — orchestrator; follow-up candidate: resizable-splits + localStorage persistence, prose-only in contract, never codified as a scenario)*
- C5 — mascot micro-states · verified-by claude-haiku-verifier · 2026-07-12 *(merged to main 2026-07-12 @ 77a3edd; open follow-up: one-line initMascotState() wire in onscreen_agent/panel.html — outside C5 allowlist)*
- A0 — verify real offload path · verified-by claude-verifier · 2026-07-08 *(merged to main 2026-07-08 — live-verification contract; qwen3.5-9B-FLM @16k proven, judge 10/10, phi4-roulette hard-guard in place)*
- G0 — unified run-event stream spec · verified-by claude-verifier · 2026-07-08 *(merged to main 2026-07-08)*
- C0 — design system contract · verified-by claude-verifier · 2026-07-08 *(merged to main 2026-07-08)*
- W0 — work-contract format + full backlog conversion · verified-by claude-verifier · 2026-07-07 *(merged to main 2026-07-07)*
- B0 — coordination ledger spec + validator · verified-by claude-verifier · 2026-07-07 *(merged to main 2026-07-07)*
- Q0 — security remediation · verified-by claude-verifier · 2026-07-07 *(merged to main 2026-07-07 — LONGVIEW run stopped by owner; NOTE: resuming LONGVIEW now requires BENNY_API_KEY in env or state/hmac-key keystore, fail-fast by design)*
- A9 — server-side call deadlines · verified-by claude-verifier · 2026-07-07 *(on main, released v1.12.6; OPEN follow-up A9.1 tracked — enricher/clustering await-inventory + sync chroma.add, see LOG 2026-07-08T11:45, ready for pickup)*
- A8 — model-routing hygiene + ingest resilience · verified-by claude-verifier · 2026-07-07 *(on main, v1.12.3-5; known residual: lemonade health-probe shape, see LOG 2026-07-06T15:20 + A8.3 probe-shape residual closed 2026-07-08)*

## BLOCKED (id · reason · date)
*(empty)*

## AUTHORED (contracts in tasks/, waiting on deps — W0 conversion 2026-07-07)
A1 A2 A3 A4 A5 A6 A7 ·
B2 B3 ·
W1 W2 W3 ·
G1 G2 G3 ·
C2 C4 C6 C7 ·
D1 D2 D3 ·
E1 E2 ·
F1 F2 F3 F4 F5 F6 F7 F8 ·
Q2 Q3 ·
R0 R1 R2 R3 ·
M2-1 M2-2 M2-3 M2-4 M2-5 M2-6 M2-7 M2-8 ·
L5 L6 L7 L8 L9 L10 L11 L12 L13 L14 ·
