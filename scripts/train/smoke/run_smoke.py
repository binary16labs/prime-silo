#!/usr/bin/env python3
"""T0 smoke — a real ~30-step 4-bit QLoRA on the RDNA4 eGPU.

Proves the trainer end-to-end: loads a small base in 4-bit, attaches a LoRA,
runs 30 QLoRA steps on a tiny public toy set (unsloth/alpaca-cleaned — the
combo already reported working on RX 9060 XT / gfx1200 / ROCm-on-Windows),
records per-step loss, and writes a reloadable adapter. Emits the artifact the
T0 gate (`scripts/gates/t0.py`) checks: <out>/smoke_result.json + adapter/.

Privacy: alpaca-cleaned is public instruction data — no house corpus, no
LONGVIEW, no CV/job-application content. This is a hardware smoke, not a real
training run (that corpus arrives at T2/T3 behind the leak gate).

Run inside the Unsloth venv:
    C:\\Users\\<you>\\.unsloth\\studio\\unsloth_studio\\Scripts\\python.exe run_smoke.py
"""

import json
import os
from pathlib import Path

import torch

BASE_MODEL = os.environ.get("T0_SMOKE_BASE", "unsloth/Llama-3.2-1B-Instruct")
OUT = Path(os.environ.get("T0_SMOKE_DIR", Path(__file__).resolve().parent / "out"))
ADAPTER_DIR = OUT / "adapter"
MAX_STEPS = int(os.environ.get("T0_SMOKE_STEPS", "30"))
MAX_SEQ = 1024


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)

    if not torch.cuda.is_available():
        raise SystemExit("[smoke] torch.cuda not available — ROCm device not visible; aborting")
    props = torch.cuda.get_device_properties(0)
    arch = getattr(props, "gcnArchName", "") or ""
    vram_gib = round(props.total_memory / 1024 ** 3, 1)
    print(f"[smoke] device={arch} vram={vram_gib}GiB torch={torch.__version__} hip={torch.version.hip}")

    # Unsloth first (it patches transformers/trl before they import).
    from unsloth import FastLanguageModel
    from datasets import load_dataset
    from trl import SFTConfig, SFTTrainer

    model, tokenizer = FastLanguageModel.from_pretrained(
        model_name=BASE_MODEL, max_seq_length=MAX_SEQ, load_in_4bit=True, dtype=None,
    )
    model = FastLanguageModel.get_peft_model(
        model, r=16, lora_alpha=16, lora_dropout=0, bias="none",
        target_modules=["q_proj", "k_proj", "v_proj", "o_proj",
                        "gate_proj", "up_proj", "down_proj"],
        use_gradient_checkpointing="unsloth", random_state=3407,
    )

    ds = load_dataset("unsloth/alpaca-cleaned", split="train[:256]")
    eos = tokenizer.eos_token or ""

    def fmt(ex):
        inp = ("\n\n### Input:\n" + ex["input"]) if ex.get("input") else ""
        return {"text": f"### Instruction:\n{ex['instruction']}{inp}"
                        f"\n\n### Response:\n{ex['output']}{eos}"}

    ds = ds.map(fmt)

    trainer = SFTTrainer(
        model=model, tokenizer=tokenizer, train_dataset=ds,
        args=SFTConfig(
            dataset_text_field="text", max_seq_length=MAX_SEQ,
            max_steps=MAX_STEPS, per_device_train_batch_size=2,
            gradient_accumulation_steps=2, warmup_steps=5,
            learning_rate=2e-4, logging_steps=1, optim="adamw_8bit",
            weight_decay=0.01, lr_scheduler_type="linear", seed=3407,
            output_dir=str(OUT / "trainer"), report_to="none",
        ),
    )

    trainer.train()

    losses = [round(float(h["loss"]), 5) for h in trainer.state.log_history if "loss" in h]
    if not losses:
        raise SystemExit("[smoke] no per-step loss captured — aborting")

    model.save_pretrained(str(ADAPTER_DIR))
    tokenizer.save_pretrained(str(ADAPTER_DIR))

    result = {
        "base_model": BASE_MODEL,
        "rocm_build": f"torch {torch.__version__} / hip {torch.version.hip}",
        "device": arch,
        "vram_gib": vram_gib,
        "steps": len(losses),
        "loss": losses,
        "final_loss": losses[-1],
        "adapter_dir": str(ADAPTER_DIR),
    }
    (OUT / "smoke_result.json").write_text(json.dumps(result, indent=2), encoding="utf-8")
    print(f"[smoke] wrote {OUT / 'smoke_result.json'} — loss {losses[0]:.4f} -> {losses[-1]:.4f} "
          f"over {len(losses)} steps; adapter -> {ADAPTER_DIR}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
