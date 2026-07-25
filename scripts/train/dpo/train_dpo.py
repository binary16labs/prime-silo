#!/usr/bin/env python3
"""T5 — DPO on the SFT adapter. Preference-tune the T3 v3 model so it prefers the house
reference over its own hard-negative answers (scripts/train/dpo/out/prefs.jsonl).

Policy init = the SFT adapter (continues training the same LoRA). Reference = the frozen
SFT policy (Unsloth handles ref internally when ref_model=None — adapter disabled). Prompts
are formatted with the SAME chat template as SFT/eval (shared format.py) so the objective
matches the T3 instrument.

Hyperparameters (frozen before the run, recorded in the report):
  beta 0.1, lr 5e-6 (DPO is far more sensitive than SFT's 2e-4), cosine, 1 epoch,
  batch 1 x grad-accum 8, max_seq 2048, seed 3407.

Run in the Unsloth venv from a vcvars64 shell (Triton), with LM Studio UNLOADED (the eGPU
is needed for training — parallelism 1):
    python scripts/train/dpo/train_dpo.py
"""

import json
import os
import time
from pathlib import Path

import torch

HERE = Path(__file__).resolve().parent
QLORA = HERE.parent / "qlora"
OUT = Path(os.environ.get("T5_DPO_DIR", HERE / "out"))
ADAPTER_DIR = OUT / "adapter"
SFT_ADAPTER = Path(os.environ.get("T5_SFT_ADAPTER", QLORA / "out" / "adapter"))
PREFS = Path(os.environ.get("T5_PREFS", OUT / "prefs.jsonl"))

MAX_SEQ = int(os.environ.get("T5_MAX_SEQ", "2048"))
BETA = float(os.environ.get("T5_BETA", "0.1"))
LR = float(os.environ.get("T5_LR", "5e-6"))
EPOCHS = float(os.environ.get("T5_EPOCHS", "1"))
BATCH = int(os.environ.get("T5_BATCH", "1"))
GRAD_ACCUM = int(os.environ.get("T5_GRAD_ACCUM", "8"))
SEED = 3407


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    if not SFT_ADAPTER.exists():
        raise SystemExit(f"[dpo] SFT adapter not found at {SFT_ADAPTER} — run T3 train first")
    if not PREFS.exists():
        raise SystemExit(f"[dpo] prefs not found at {PREFS} — run build_prefs.py first")
    if not torch.cuda.is_available():
        raise SystemExit("[dpo] torch.cuda not available — attach the eGPU")
    props = torch.cuda.get_device_properties(0)
    print(f"[dpo] device={props.gcnArchName} vram={round(props.total_memory/1024**3,2)}GiB "
          f"torch={torch.__version__} hip={torch.version.hip}")

    from unsloth import FastLanguageModel, PatchDPOTrainer

    PatchDPOTrainer()
    from datasets import Dataset
    from trl import DPOConfig, DPOTrainer

    # policy = base + SFT adapter (continue training the same LoRA)
    model, tokenizer = FastLanguageModel.from_pretrained(
        model_name=str(SFT_ADAPTER), max_seq_length=MAX_SEQ, load_in_4bit=True, dtype=None,
    )
    # DPO doubles sequences (chosen+rejected). Unsloth's "unsloth" checkpointing offloads
    # activations to HOST RAM — on this 16 GB box that exhausted RAM and swap-thrashed a run
    # to a crawl near the end (pagefile peaked 9.4 GB). Use standard checkpointing (True) which
    # keeps activations in VRAM (~11 GB free after the 4-bit model) — trade spare VRAM for the
    # scarce host RAM. Override with T5_GRAD_CKPT.
    grad_ckpt = os.environ.get("T5_GRAD_CKPT", "true")
    grad_ckpt = True if grad_ckpt.lower() == "true" else grad_ckpt
    model = FastLanguageModel.get_peft_model(
        model, r=16, lora_alpha=16, lora_dropout=0, bias="none",
        target_modules=["q_proj", "k_proj", "v_proj", "o_proj",
                        "gate_proj", "up_proj", "down_proj"],
        use_gradient_checkpointing=grad_ckpt, random_state=SEED,
    )
    eos = tokenizer.eos_token or ""

    def fmt_prompt(user):
        return tokenizer.apply_chat_template(
            [{"role": "user", "content": user}], tokenize=False, add_generation_prompt=True
        )

    # Design-aligned filtering (method in weights, facts in RAG): keep tool-SELECTION errors
    # (wrong tool name) and VOICE drift — both teach method. DROP args_mismatch (right tool,
    # different arg values): preferring the reference's exact args = memorising session facts,
    # which fights the RAG design and won't generalise. Override with T5_PREF_REASONS.
    keep = set((os.environ.get("T5_PREF_REASONS") or "tool_mismatch,voice_drift").split(","))
    all_rows = [json.loads(l) for l in open(PREFS, encoding="utf-8") if l.strip()]
    rows = [p for p in all_rows if p.get("reason") in keep]
    if not rows:
        raise SystemExit(f"[dpo] no pairs after reason filter {keep} (of {len(all_rows)})")
    ds = Dataset.from_list([
        {"prompt": fmt_prompt(p["prompt"]),
         "chosen": p["chosen"] + eos,
         "rejected": p["rejected"] + eos}
        for p in rows
    ])
    n_a = sum(1 for p in rows if p.get("stream") == "A")
    n_b = sum(1 for p in rows if p.get("stream") == "B")
    print(f"[dpo] pairs: A={n_a} B={n_b} total={len(rows)}/{len(all_rows)} "
          f"(reasons kept: {sorted(keep)}) | beta={BETA} lr={LR} epochs={EPOCHS}")

    trainer = DPOTrainer(
        model=model,
        ref_model=None,  # Unsloth uses the base (adapter-disabled) SFT policy as reference
        args=DPOConfig(
            beta=BETA,
            per_device_train_batch_size=BATCH, gradient_accumulation_steps=GRAD_ACCUM,
            warmup_ratio=0.1, num_train_epochs=EPOCHS, learning_rate=LR,
            lr_scheduler_type="cosine", optim="adamw_8bit", weight_decay=0.0,
            logging_steps=5, seed=SEED, max_length=MAX_SEQ, max_prompt_length=MAX_SEQ // 2,
            dataloader_num_workers=0, output_dir=str(OUT / "trainer"), report_to="none",
            bf16=True, fp16=False,
        ),
        train_dataset=ds,
        processing_class=tokenizer,
    )

    t0 = time.time()
    trainer.train()
    wall = time.time() - t0
    losses = [round(float(h["loss"]), 5) for h in trainer.state.log_history if "loss" in h]
    model.save_pretrained(str(ADAPTER_DIR))
    tokenizer.save_pretrained(str(ADAPTER_DIR))

    (OUT / "dpo_result.json").write_text(json.dumps({
        "sft_adapter": str(SFT_ADAPTER),
        "pairs": {"A": n_a, "B": n_b, "total": len(rows), "available": len(all_rows),
                  "reasons_kept": sorted(keep)},
        "hparams": {"beta": BETA, "lr": LR, "epochs": EPOCHS, "batch": BATCH,
                    "grad_accum": GRAD_ACCUM, "max_seq": MAX_SEQ, "seed": SEED,
                    "schedule": "cosine"},
        "logged_losses": losses,
        "first_loss": losses[0] if losses else None,
        "final_loss": losses[-1] if losses else None,
        "wall_s": round(wall, 1),
        "adapter_dir": str(ADAPTER_DIR),
    }, indent=2), encoding="utf-8")
    print(f"[dpo] done in {wall/60:.1f} min — loss {losses[0] if losses else '?'} -> "
          f"{losses[-1] if losses else '?'}; adapter -> {ADAPTER_DIR}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
