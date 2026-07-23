#!/usr/bin/env python3
"""T0 smoke (Triton-free) — real 30-step 4-bit QLoRA on the RDNA4 eGPU.

Proves the make-or-break hardware claim without Unsloth's Triton fused kernels
(which need a C toolchain not yet on this box): plain transformers + peft +
bitsandbytes in EAGER mode. bitsandbytes' ROCm 4-bit kernels do the quantized
matmuls, torch autograd does the backward — no Triton JIT anywhere. This runs
now; the Unsloth fast path lands once VS Build Tools is installed.

Emits the artifact the T0 gate checks: <out>/smoke_result.json + adapter/.
Privacy: unsloth/alpaca-cleaned is public — no house corpus, no CV/job data.
"""

import json
import os
from pathlib import Path

os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")

# torchao has no working Windows-ROCm build (its import references a c10d
# functional op absent from the ROCm torch wheel), and transformers' quantizer
# layer imports it eagerly. Unsloth stubs it at runtime; without Unsloth we do
# the same — a meta-path finder that serves any `torchao[.*]` as an inert module
# so the import chain into transformers.modeling_utils succeeds. We never use
# torchao quantization here (4-bit is bitsandbytes), so an inert stub is safe.
import importlib.abc
import importlib.machinery
import sys
import types


def _is_dunder(name: str) -> bool:
    return name.startswith("__") and name.endswith("__")


class _StubMeta(type):
    """Metaclass so every torchao symbol is a real *class*: usable as an
    isinstance() arg (returns False), as a dict key, and callable to construct.
    Attribute access chains (`torchao.quantization.Float8WeightOnlyConfig`) each
    yield another stub class. Dunders raise AttributeError so introspection
    (inspect.getmodule, etc.) behaves normally. torchao is never actually used
    here — 4-bit is bitsandbytes — so an inert stub is safe."""

    def __getattr__(cls, name):
        if _is_dunder(name):
            raise AttributeError(name)
        return _make_stub(name)


def _make_stub(name):
    return _StubMeta(name, (), {})


def _stub_getattr(name):
    if _is_dunder(name):
        raise AttributeError(name)  # let inspect/import machinery see a real absence
    return _make_stub(name)


class _TorchaoStub(importlib.abc.MetaPathFinder, importlib.abc.Loader):
    def find_spec(self, name, path=None, target=None):
        if name == "torchao" or name.startswith("torchao."):
            return importlib.machinery.ModuleSpec(name, self)
        return None

    def create_module(self, spec):
        m = types.ModuleType(spec.name)
        m.__version__ = "0.0.0-stub"
        m.__file__ = "<torchao-stub>"
        m.__path__ = []  # mark as a package so submodules resolve through us
        m.__getattr__ = _stub_getattr
        return m

    def exec_module(self, module):
        pass


if "torchao" not in sys.modules:
    sys.meta_path.insert(0, _TorchaoStub())

import torch
from datasets import load_dataset
from peft import LoraConfig, get_peft_model, prepare_model_for_kbit_training
from transformers import (AutoModelForCausalLM, AutoTokenizer,
                          DataCollatorForLanguageModeling, Trainer, TrainingArguments)

# Pre-quantized bnb-4bit checkpoint already cached by the Unsloth smoke — reused
# so we don't re-download. transformers loads its embedded quantization_config.
BASE_MODEL = os.environ.get("T0_SMOKE_BASE", "unsloth/llama-3.2-1b-instruct-unsloth-bnb-4bit")
OUT = Path(os.environ.get("T0_SMOKE_DIR", Path(__file__).resolve().parent / "out"))
ADAPTER_DIR = OUT / "adapter"
MAX_STEPS = int(os.environ.get("T0_SMOKE_STEPS", "30"))
MAX_SEQ = 512


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    if not torch.cuda.is_available():
        raise SystemExit("[smoke] torch.cuda not available — ROCm device not visible; aborting")
    props = torch.cuda.get_device_properties(0)
    arch = getattr(props, "gcnArchName", "") or ""
    vram_gib = round(props.total_memory / 1024 ** 3, 2)
    print(f"[smoke] device={arch} vram={vram_gib}GiB torch={torch.__version__} "
          f"hip={torch.version.hip} (Triton-free eager QLoRA)", flush=True)

    tok = AutoTokenizer.from_pretrained(BASE_MODEL)
    if tok.pad_token is None:
        tok.pad_token = tok.eos_token

    model = AutoModelForCausalLM.from_pretrained(
        BASE_MODEL, device_map={"": 0}, torch_dtype=torch.bfloat16,
        attn_implementation="eager",
    )
    model.config.use_cache = False
    model = prepare_model_for_kbit_training(model, use_gradient_checkpointing=True)
    model = get_peft_model(model, LoraConfig(
        r=16, lora_alpha=16, lora_dropout=0.0, bias="none", task_type="CAUSAL_LM",
        target_modules=["q_proj", "k_proj", "v_proj", "o_proj",
                        "gate_proj", "up_proj", "down_proj"],
    ))
    model.print_trainable_parameters()

    ds = load_dataset("unsloth/alpaca-cleaned", split="train[:256]")
    eos = tok.eos_token or ""

    def fmt(ex):
        inp = ("\n\n### Input:\n" + ex["input"]) if ex.get("input") else ""
        text = f"### Instruction:\n{ex['instruction']}{inp}\n\n### Response:\n{ex['output']}{eos}"
        enc = tok(text, truncation=True, max_length=MAX_SEQ)
        return enc

    ds = ds.map(fmt, remove_columns=ds.column_names)

    args = TrainingArguments(
        output_dir=str(OUT / "trainer"), max_steps=MAX_STEPS,
        per_device_train_batch_size=2, gradient_accumulation_steps=2,
        warmup_steps=5, learning_rate=2e-4, logging_steps=1, optim="adamw_torch",
        weight_decay=0.01, lr_scheduler_type="linear", seed=3407,
        bf16=True, gradient_checkpointing=True, report_to="none",
        gradient_checkpointing_kwargs={"use_reentrant": False},
    )
    trainer = Trainer(
        model=model, args=args, train_dataset=ds,
        data_collator=DataCollatorForLanguageModeling(tok, mlm=False),
    )
    trainer.train()

    losses = [round(float(h["loss"]), 5) for h in trainer.state.log_history if "loss" in h]
    if not losses:
        raise SystemExit("[smoke] no per-step loss captured — aborting")

    model.save_pretrained(str(ADAPTER_DIR))
    tok.save_pretrained(str(ADAPTER_DIR))

    result = {
        "base_model": BASE_MODEL,
        "rocm_build": f"torch {torch.__version__} / hip {torch.version.hip} (eager peft+bnb, no Triton)",
        "device": arch,
        "vram_gib": vram_gib,
        "steps": len(losses),
        "loss": losses,
        "final_loss": losses[-1],
        "adapter_dir": str(ADAPTER_DIR),
    }
    (OUT / "smoke_result.json").write_text(json.dumps(result, indent=2), encoding="utf-8")
    print(f"[smoke] wrote {OUT / 'smoke_result.json'} — loss {losses[0]:.4f} -> {losses[-1]:.4f} "
          f"over {len(losses)} steps; adapter -> {ADAPTER_DIR}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
