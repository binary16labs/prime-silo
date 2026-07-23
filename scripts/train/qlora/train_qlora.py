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
# Stream A (method/voice, ~60 rows) vs Stream B (trajectories, up to ~2500): without
# rebalancing the voice signal drowns. Repeat each A row this many times in the train set.
A_OVERSAMPLE = int(os.environ.get("T3_A_OVERSAMPLE", "4"))
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
    from datasets import Dataset
    from transformers import DataCollatorForSeq2Seq, Trainer, TrainingArguments

    model, tokenizer = FastLanguageModel.from_pretrained(
        model_name=BASE_MODEL, max_seq_length=MAX_SEQ, load_in_4bit=True, dtype=None,
    )
    model = FastLanguageModel.get_peft_model(
        model, r=16, lora_alpha=16, lora_dropout=0, bias="none",
        target_modules=["q_proj", "k_proj", "v_proj", "o_proj",
                        "gate_proj", "up_proj", "down_proj"],
        use_gradient_checkpointing="unsloth", random_state=SEED,
    )

    a_rows = load_rows(DATA / "stream_a.train.jsonl")
    b_rows = load_rows(DATA / "stream_b.train.jsonl")
    rows = a_rows * max(1, A_OVERSAMPLE) + b_rows  # Trainer shuffles per-epoch (seeded)
    # Pre-tokenize with response-only masking via the SAME fmt.encode_nll the eval uses, so the
    # training objective and the eval NLL score the identical completion tokens. Passing an
    # already-tokenized dataset to a plain HF Trainer also sidesteps Unsloth SFTTrainer's
    # dataset.map, whose Windows `spawn`/dill workers cannot import the runtime-generated
    # UnslothSFTTrainer module (the map dies before a single step).
    examples = []
    for r in rows:
        input_ids, labels = fmt.encode_nll(r, tokenizer, MAX_SEQ)
        examples.append({"input_ids": input_ids, "labels": labels,
                         "attention_mask": [1] * len(input_ids)})
    ds = Dataset.from_list(examples)
    n_a, n_b = len(a_rows), len(b_rows)  # unique rows; A is repeated A_OVERSAMPLE x in training
    print(f"[train] rows: A={n_a} B={n_b} total={len(rows)} | max_seq={MAX_SEQ} "
          f"epochs={EPOCHS} bs={BATCH} ga={GRAD_ACCUM}")

    collator = DataCollatorForSeq2Seq(
        tokenizer, label_pad_token_id=fmt.IGNORE, padding=True,
    )
    trainer = Trainer(
        model=model, train_dataset=ds, data_collator=collator,
        args=TrainingArguments(
            num_train_epochs=EPOCHS,
            per_device_train_batch_size=BATCH, gradient_accumulation_steps=GRAD_ACCUM,
            warmup_ratio=0.05, learning_rate=2e-4, logging_steps=5,
            optim="adamw_8bit", weight_decay=0.01, lr_scheduler_type="cosine",
            seed=SEED, dataloader_num_workers=0, bf16=True, fp16=False,
            output_dir=str(OUT / "trainer"), report_to="none",
        ),
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
        "rows": {"A": n_a, "B": n_b, "A_oversample": A_OVERSAMPLE,
                 "train_examples": len(rows)},
        "hparams": {"rank": 16, "lora_alpha": 16, "lr": 2e-4, "schedule": "cosine",
                    "max_seq": MAX_SEQ, "epochs": EPOCHS, "batch": BATCH,
                    "grad_accum": GRAD_ACCUM, "seed": SEED, "masking": "responses_only",
                    "a_oversample": A_OVERSAMPLE},
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
