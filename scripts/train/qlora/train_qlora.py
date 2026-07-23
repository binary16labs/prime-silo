#!/usr/bin/env python3
"""T3 QLoRA training — the first real house-method fine-tune.

Trains a LoRA (rank 16, lr 2e-4, cosine) on the T2 Stream A+B *train* splits over the
T0-proven gfx1200 eGPU. Loss is computed on responses only (prompt masked via
`train_on_responses_only`) so the objective matches the eval NLL instrument exactly.
The eval splits are never loaded here — held out by construction (T2).

Privacy: reads only scripts/train/dataset/*.train.jsonl, which passed the T2 leak gate
(0 personal-context hits). No CV/job-application content by construction.

Run inside the Unsloth venv from a vcvars64 developer shell (Triton needs the MSVC/SDK
headers, per T0):
    python scripts/train/qlora/train_qlora.py
"""

import json
import os
import time
from pathlib import Path

import torch

HERE = Path(__file__).resolve().parent
DATA = HERE.parent / "dataset"
OUT = Path(os.environ.get("T3_QLORA_DIR", HERE / "out"))
ADAPTER_DIR = OUT / "adapter"

BASE_MODEL = os.environ.get("T3_BASE", "unsloth/Qwen2.5-Coder-7B-Instruct-bnb-4bit")
MAX_SEQ = int(os.environ.get("T3_MAX_SEQ", "2048"))
EPOCHS = float(os.environ.get("T3_EPOCHS", "3"))
BATCH = int(os.environ.get("T3_BATCH", "1"))          # parallelism-1 infra: keep it low
GRAD_ACCUM = int(os.environ.get("T3_GRAD_ACCUM", "8"))
SEED = 3407

import format as fmt  # noqa: E402  scripts/train/qlora/format.py — shared with eval


def load_rows(path):
    rows = []
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                rows.append(json.loads(line))
    return rows


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    if not torch.cuda.is_available():
        raise SystemExit("[train] torch.cuda not available — attach the eGPU; aborting")
    props = torch.cuda.get_device_properties(0)
    arch = getattr(props, "gcnArchName", "") or ""
    vram = round(props.total_memory / 1024**3, 2)
    print(f"[train] device={arch} vram={vram}GiB torch={torch.__version__} hip={torch.version.hip}")

    from unsloth import FastLanguageModel  # patches transformers/trl first
    from unsloth.chat_templates import train_on_responses_only
    from datasets import Dataset
    from trl import SFTConfig, SFTTrainer

    model, tokenizer = FastLanguageModel.from_pretrained(
        model_name=BASE_MODEL, max_seq_length=MAX_SEQ, load_in_4bit=True, dtype=None,
    )
    model = FastLanguageModel.get_peft_model(
        model, r=16, lora_alpha=16, lora_dropout=0, bias="none",
        target_modules=["q_proj", "k_proj", "v_proj", "o_proj",
                        "gate_proj", "up_proj", "down_proj"],
        use_gradient_checkpointing="unsloth", random_state=SEED,
    )

    rows = load_rows(DATA / "stream_a.train.jsonl") + load_rows(DATA / "stream_b.train.jsonl")
    texts = [{"text": fmt.to_text(r, tokenizer)} for r in rows]
    ds = Dataset.from_list(texts)
    n_a = sum(1 for r in rows if r.get("stream") == "A")
    n_b = sum(1 for r in rows if r.get("stream") == "B")
    print(f"[train] rows: A={n_a} B={n_b} total={len(rows)} | max_seq={MAX_SEQ} "
          f"epochs={EPOCHS} bs={BATCH} ga={GRAD_ACCUM}")

    trainer = SFTTrainer(
        model=model, tokenizer=tokenizer, train_dataset=ds,
        args=SFTConfig(
            dataset_text_field="text", max_seq_length=MAX_SEQ,
            packing=False,  # keep sequences separate so response-only masking is exact
            num_train_epochs=EPOCHS,
            per_device_train_batch_size=BATCH, gradient_accumulation_steps=GRAD_ACCUM,
            warmup_ratio=0.05, learning_rate=2e-4, logging_steps=5,
            optim="adamw_8bit", weight_decay=0.01, lr_scheduler_type="cosine",
            seed=SEED, dataset_num_proc=1, dataloader_num_workers=0,
            output_dir=str(OUT / "trainer"), report_to="none",
        ),
    )
    # Loss on assistant turns only — Qwen chat markers. Matches eval's prompt masking.
    trainer = train_on_responses_only(
        trainer,
        instruction_part="<|im_start|>user\n",
        response_part="<|im_start|>assistant\n",
    )

    t0 = time.time()
    trainer.train()
    wall = time.time() - t0

    losses = [round(float(h["loss"]), 5) for h in trainer.state.log_history if "loss" in h]
    model.save_pretrained(str(ADAPTER_DIR))
    tokenizer.save_pretrained(str(ADAPTER_DIR))

    result = {
        "base_model": BASE_MODEL,
        "rocm_build": f"torch {torch.__version__} / hip {torch.version.hip}",
        "device": arch, "vram_gib": vram,
        "rows": {"A": n_a, "B": n_b, "total": len(rows)},
        "hparams": {"rank": 16, "lora_alpha": 16, "lr": 2e-4, "schedule": "cosine",
                    "max_seq": MAX_SEQ, "epochs": EPOCHS, "batch": BATCH,
                    "grad_accum": GRAD_ACCUM, "seed": SEED, "masking": "responses_only"},
        "logged_losses": losses,
        "first_loss": losses[0] if losses else None,
        "final_loss": losses[-1] if losses else None,
        "wall_s": round(wall, 1),
        "adapter_dir": str(ADAPTER_DIR),
    }
    (OUT / "train_result.json").write_text(json.dumps(result, indent=2), encoding="utf-8")
    print(f"[train] done in {wall/60:.1f} min — loss "
          f"{result['first_loss']} -> {result['final_loss']}; adapter -> {ADAPTER_DIR}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
