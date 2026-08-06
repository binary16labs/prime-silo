#!/usr/bin/env python3
"""P5 QLoRA — LONGVIEW distillation of gemma-4-E4B (student) from the 12B teacher.

Separate from train_qlora.py (the proven qwen house-method trainer) because gemma-4-E4B is a
MULTIMODAL `Gemma4ForConditionalGeneration`: it loads via unsloth `FastModel` (not FastLanguageModel),
its tokenizer is a Processor whose inner `.tokenizer` (GemmaTokenizer) is what text training uses, and
it must run bf16 (the documented gemma4 fp16-NaN grad issue). Everything else — response-only masking
via the shared `format.encode_nll`, plain HF Trainer over pre-tokenized rows (Unsloth SFTTrainer's
dataset.map dies on Windows spawn) — matches the house method so the eval NLL scores identical tokens.

Data: scripts/train/dataset/longview_distill/longview_distill.train.jsonl (stream "L"; window->12B
fragment). Built + privacy-gated by build_longview_distill.mjs (leak gate PASS; the held-out eval-p5
cards are excluded so the ladder measures the tuned model honestly).

Run from a vcvars64 shell in the UPGRADED copy venv (D:\gemma4-venv), transformers==5.5.0 +
unsloth==2026.8.5:
    T5_BASE=unsloth/gemma-4-E4B-it-unsloth-bnb-4bit python scripts/train/qlora/train_qlora_p5.py
"""

import json
import os
import time
from pathlib import Path

os.environ.setdefault("HF_HOME", r"D:/t3-merge/hf")
os.environ.setdefault("HF_HUB_OFFLINE", "1")

import torch

HERE = Path(__file__).resolve().parent
DATA = HERE.parent / "dataset" / "longview_distill"
OUT = Path(os.environ.get("P5_QLORA_DIR", HERE / "out_p5"))
ADAPTER_DIR = OUT / "adapter"

BASE_MODEL = os.environ.get("P5_BASE", "unsloth/gemma-4-E4B-it-unsloth-bnb-4bit")
TRAIN_FILE = os.environ.get("P5_TRAIN", str(DATA / "longview_distill.train.jsonl"))
MAX_SEQ = int(os.environ.get("P5_MAX_SEQ", "5120"))   # 12k-char windows ~3.5k tok + fragment; drop if VRAM wedges
EPOCHS = float(os.environ.get("P5_EPOCHS", "1"))
BATCH = int(os.environ.get("P5_BATCH", "1"))
GRAD_ACCUM = int(os.environ.get("P5_GRAD_ACCUM", "8"))
SEED = 3407

import format as fmt  # noqa: E402  shared with eval — identical encode_nll


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
        raise SystemExit("[p5] torch.cuda not available — attach the eGPU; aborting")
    props = torch.cuda.get_device_properties(0)
    arch = getattr(props, "gcnArchName", "") or ""
    vram = round(props.total_memory / 1024**3, 2)
    print(f"[p5] device={arch} vram={vram}GiB torch={torch.__version__} hip={torch.version.hip}")

    from unsloth import FastModel  # multimodal loader; patches transformers/trl first
    from datasets import Dataset
    from transformers import DataCollatorForSeq2Seq, Trainer, TrainingArguments

    model, processor = FastModel.from_pretrained(
        model_name=BASE_MODEL, max_seq_length=MAX_SEQ, load_in_4bit=True,
        dtype=torch.bfloat16, full_finetuning=False,
    )
    # text-only training: the Processor wraps the GemmaTokenizer
    tokenizer = getattr(processor, "tokenizer", processor)
    model = FastModel.get_peft_model(
        model, r=16, lora_alpha=16, lora_dropout=0.0, bias="none",
        target_modules=["q_proj", "k_proj", "v_proj", "o_proj",
                        "gate_proj", "up_proj", "down_proj"],
        use_gradient_checkpointing="unsloth", random_state=SEED,
    )

    rows = load_rows(TRAIN_FILE)
    max_rows = int(os.environ.get("P5_MAX_ROWS", "0"))  # smoke cap; 0 = all
    if max_rows:
        rows = rows[:max_rows]
        print(f"[p5] SMOKE: capped to {len(rows)} rows")
    examples, truncated = [], 0
    for r in rows:
        input_ids, labels = fmt.encode_nll(r, tokenizer, MAX_SEQ)
        if len(input_ids) >= MAX_SEQ:
            truncated += 1
        examples.append({"input_ids": input_ids, "labels": labels,
                         "attention_mask": [1] * len(input_ids)})
    ds = Dataset.from_list(examples)
    print(f"[p5] rows={len(rows)} (stream L) | max_seq={MAX_SEQ} truncated={truncated} "
          f"epochs={EPOCHS} bs={BATCH} ga={GRAD_ACCUM}")

    collator = DataCollatorForSeq2Seq(tokenizer, label_pad_token_id=fmt.IGNORE, padding=True)
    trainer = Trainer(
        model=model, train_dataset=ds, data_collator=collator,
        args=TrainingArguments(
            num_train_epochs=EPOCHS,
            per_device_train_batch_size=BATCH, gradient_accumulation_steps=GRAD_ACCUM,
            warmup_ratio=0.05, learning_rate=2e-4, logging_steps=10,
            optim="adamw_8bit", weight_decay=0.01, lr_scheduler_type="cosine",
            seed=SEED, dataloader_num_workers=0, bf16=True, fp16=False,
            # Periodic checkpoints: a ~4.6h eGPU run has real transient-wedge risk (house-trainer
            # lesson: a DPO run sat wedged 6h). save_steps lets a wedge past step 100 resume instead
            # of losing everything.
            save_strategy="steps", save_steps=100, save_total_limit=2,
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
        "base_model": BASE_MODEL, "task": "longview.window_fragment distillation (teacher gemma-4-12b)",
        "rocm_build": f"torch {torch.__version__} / hip {torch.version.hip}",
        "device": arch, "vram_gib": vram,
        "rows": len(rows), "truncated_at_max_seq": truncated,
        "hparams": {"rank": 16, "lora_alpha": 16, "lr": 2e-4, "schedule": "cosine",
                    "max_seq": MAX_SEQ, "epochs": EPOCHS, "batch": BATCH,
                    "grad_accum": GRAD_ACCUM, "seed": SEED, "masking": "responses_only",
                    "dtype": "bf16", "loader": "unsloth.FastModel"},
        "logged_losses": losses,
        "first_loss": losses[0] if losses else None,
        "final_loss": losses[-1] if losses else None,
        "wall_s": round(wall, 1), "adapter_dir": str(ADAPTER_DIR),
    }
    (OUT / "train_result.json").write_text(json.dumps(result, indent=2), encoding="utf-8")
    print(f"[p5] done in {wall/60:.1f} min — loss {result['first_loss']} -> {result['final_loss']}; "
          f"adapter -> {ADAPTER_DIR}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
