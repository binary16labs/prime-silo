# T0 — Trainer evidence (RDNA4 eGPU QLoRA proven)

**Status:** 🟢 GATE GREEN on real hardware — author-complete, **ready-for-verify**
(author = claude; independent verifier must re-run `scripts/gates/t0.py` from a
clean checkout, per author≠verifier). Date: 2026-07-22.

This resolves the plan's open OS decision (`architecture/PLAN-local-power-unified-ui.md`
§2.5, T0 handoff): **native-Windows ROCm works for RDNA4** — WSL2 not required.

---

## Verdict

The RX 9060 XT (gfx1200 / RDNA4) in the Razer Core X eGPU over Thunderbolt-3 runs a
real **30-step 4-bit QLoRA** under native-Windows ROCm, proven **two ways**, both
passing `scripts/gates/t0.py` (exit 0):

| Path | Kernels | Base | Loss (step 1 → 30) | Adapter | Gate |
|---|---|---|---|---|---|
| `run_smoke_vanilla.py` | transformers + peft + bitsandbytes, **eager** | llama-3.2-1b (bnb-4bit) | 2.2888 → 1.4959 | ✅ `adapter_model.safetensors` | 🟢 exit 0 |
| `run_smoke.py` | **Unsloth + Triton** (fused) | Llama-3.2-1B-Instruct | 2.2208 → 1.4511 | ✅ 45 MB safetensors | 🟢 exit 0 |

Both loss curves decrease overall (first-quarter mean > last-quarter mean) on a tiny
batch (bs 2 × grad-accum 2 = 4), which is the expected noisy-but-downward shape for a
30-step smoke.

---

## Hardware + software stack (measured)

```
GPU (torch)      : AMD Radeon RX 9060 XT — gcnArchName = gfx1200 — 15.92 GiB VRAM
Enclosure        : Razer Core X (Thunderbolt-3) → Lenovo T480 (i5-8th, 16 GB RAM), Windows 11
torch            : 2.11.0+rocm7.13.0
hip              : 7.13.99004  (ROCm Toolkit 7.13; RDNA4 wants ROCm 7.0.2+)
bitsandbytes     : 0.50.0.dev0  (libbitsandbytes_rocm714.dll, BNB_ROCM_VERSION=714)
transformers     : 4.57.6   peft 0.18.1   trl 0.23.1   Triton 3.7.1
Trainer venv     : C:\Users\nsdha\.unsloth\studio\unsloth_studio  (Python 3.12, uv-managed, isolated)
```

## Gate output (both artifacts)

```
# eager artifact (scripts/train/smoke/out/)
[t0] gpu: gfx1200 via torch — 15.9 GiB VRAM
[t0] smoke: base=unsloth/llama-3.2-1b-instruct-unsloth-bnb-4bit steps=30 loss 2.2888 -> 1.4959
[t0] GATE GREEN

# Unsloth artifact (scripts/train/smoke/out_unsloth/)
[t0] gpu: gfx1200 via torch — 15.9 GiB VRAM
[t0] smoke: base=unsloth/Llama-3.2-1B-Instruct steps=30 loss 2.2208 -> 1.4511
[t0] GATE GREEN
```

Per-step loss (Unsloth run): 2.221, 1.888, 1.420, 1.424, 1.668, 2.017, 2.376, 1.527,
2.445, 1.556, 1.507, 1.542, 1.882, 1.975, 0.940, 1.524, 1.642, 1.509, 1.870, 1.542,
1.092, 1.518, 1.434, 2.096, 2.572, 1.147, 1.343, 1.504, 1.843, 1.451.

---

## How the environment was built (owner-driven, human-signed gate)

1. **Native-Windows ROCm + Unsloth** — `irm https://unsloth.ai/install.ps1 | iex`
   (reviewed first). Creates an isolated uv venv, installs AMD's **bundled-runtime**
   ROCm PyTorch wheels from `repo.amd.com/rocm/whl/gfx120X-all/` (**no separate HIP
   SDK needed**), pinning `torch>=2.11,<2.12` to avoid a known `_grouped_mm` bug on
   RDNA4. Ran with `UNSLOTH_ROCM_GFX_ARCH=gfx1200`, `UNSLOTH_PYTHON=3.12`,
   `UNSLOTH_SKIP_AUTOSTART=1`.
2. **VS Build Tools 2022** (MSVC 14.44.35207 + Windows SDK 10.0.26100) via winget —
   required so Triton can JIT-compile its HIP driver stub. Run the Unsloth path from a
   `vcvars64` developer shell so `clang-cl` finds the CRT/SDK headers.

## Gotchas (carry into T2/T3)

- **torchao has no working Windows-ROCm build** (its import references a c10d
  functional op absent from the ROCm wheel), yet transformers imports it eagerly. The
  eager path needs the metaclass torchao stub in `run_smoke_vanilla.py`. Unsloth stubs
  this itself, so the Unsloth path doesn't need it.
- **Triton needs the VS toolchain on `INCLUDE`** — real training must launch from a
  `vcvars64` shell, else Triton fails with `hip_runtime.h: 'stdlib.h' file not found`
  and the run dies at the first fused kernel.
- **AMD bundled-runtime wheels ship no `rocm-smi`/`hipInfo`** — the gate therefore
  falls back to a torch probe (`gcnArchName`/`total_memory`) via `$T0_VENV_PY`.
- The earlier LM Studio ROCm path showed `rocblaslt: TensileLibrary_lazy_gfx1200.dat`
  missing — irrelevant to training (separate PyTorch-ROCm stack), noted for context.

## Privacy

Training data was **public `unsloth/alpaca-cleaned` only** — no code corpus, no
LONGVIEW, no CV/job-application content. This is a hardware smoke; the real
method/trajectory corpus arrives at T2/T3 behind `scripts/longview/lib/leak_gate.mjs`.

## Verifier handoff

1. Attach the eGPU; open a **VS Developer** shell (`vcvars64.bat`).
2. `T0_VENV_PY=<unsloth venv python> python scripts/gates/t0.py` → expect GATE GREEN.
   - (Optional) regenerate: `python scripts/train/smoke/run_smoke.py` (Unsloth) or
     `run_smoke_vanilla.py` (eager); artifacts land in `scripts/train/smoke/out*/`.
3. Confirm device string `gfx1200`, ~16 GiB, 30 steps, decreasing loss, reloadable
   adapter — then move T0 to `verified` / `done` on the board.

Smoke artifact dirs (`out/`, `out_unsloth/`) are git-ignored — regenerate locally.
