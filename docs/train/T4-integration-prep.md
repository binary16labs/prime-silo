# T4 contract review — prep notes for the executor (2026-07-24)

Reviewed `delivery/tasks/T4.md` against post-T3 reality. The contract holds; these notes
close the gaps between its pointers (written 2026-07-21, pre-T3) and what actually exists.

## What changed since the contract was written

1. **The artifact exists and is proven.** Serve
   `D:\t3-merge\gguf_gguf\qwen2.5-coder-7b-instruct.Q4_K_M.gguf` (4.47 GB q4_k_m, arch
   qwen2, 339 tensors). It already passes a real `llama-server.exe /health` load (twice:
   author + verifier). **Recommendation:** copy it to a stable serving path first —
   `D:\benny-home\benny\models\` exists in the home clone — and register that path;
   `t3-merge/` is a build-staging dir, not a serving location. Record the copy's sha256 in
   T4-integration.md. **Note:** a v3 (and later T5/DPO) GGUF will supersede it — make the
   engine artifact path config/env-driven so swaps are config-only, never code.
2. **Serving options on this box, in order of proven-ness:**
   - `~\.unsloth\llama.cpp\build\bin\Release\llama-server.exe` (ROCm gfx120X) — T3-proven
     load; serves an OpenAI-compatible API (`/v1/chat/completions`), which is what Benny's
     model layer speaks. CPU load was the smoke; for real serving offload to the eGPU
     (`-ngl 99 -c <ctx>`), one instance only (parallelism-1 rule).
   - LM Studio — owner-tested on the eGPU for inference (EP-T shootout); import the GGUF.
   - The contract's LAN repoint (`192.168.68.125:1234`, desktop LM Studio) works for a
     desktop-served variant, but T1 made the trainer self-sufficient — prefer local.
3. **"runtime/benny/router/" is greenfield** — no such directory exists. The real routing
   seam is `runtime/benny/core/models.py`: `_get_active_model_raw` (A8 run-affinity +
   loaded-model preference via `_loaded_model_from_health` reading `all_models_loaded[]`),
   `BENNY_DEFAULT_MODEL`, and `model_profiles.py`. The executor can either (a) create the
   contract's `router/` package wrapping this seam (allowlist already covers it), or
   (b) amend the allowlist to `runtime/benny/core/` — (a) is cleaner and additive.
   The tuned engine registers as one more OpenAI-compatible endpoint + model id; the
   A8 affinity machinery then already handles preference/fallback semantics.
4. **Fallback scenario** (unhealthy tuned endpoint → current engine, log, no crash) can
   reuse the A8 health-probe shape work verbatim — `all_models_loaded[]` parsing is done.
5. **Gate is live-verification, not hermetic** (A0 precedent): `t4.py` needs the tuned
   endpoint served. Verifier needs: eGPU attached, D: attached, endpoint up. Say so in
   the gate's failure text (reason `endpoint_down` distinct from real failures).
6. **Judged offload comparison**: reuse the A0 judge harness (10/10 calibration precedent)
   for the tuned-vs-current comparison; do not invent a new judge.

## Risks to watch

- 16 GB VRAM serves a 4.5 GB q4_k_m + ctx comfortably, but NOT concurrently with a
  training run — T4's live gate must not run while a T3/T5 train is on the GPU.
- OneDrive worktrees: contract says `sandbox: worktree` — worktrees on OneDrive were a
  known footgun (`/.worktrees/` is gitignored for a reason); create the worktree outside
  the OneDrive tree if sync interference appears.
- The offload ledger entry must record WHICH artifact (path+sha256) served the run — the
  artifact will be superseded by v3/T5 merges.
