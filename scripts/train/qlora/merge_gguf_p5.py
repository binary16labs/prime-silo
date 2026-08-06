#!/usr/bin/env python3
"""P5 merge — fold the tuned LoRA into the base and export a 16-bit HF model for GGUF conversion.

gemma-4-E4B is multimodal (Gemma4ForConditionalGeneration); the bundled llama.cpp converter DOES
support it (conversion/gemma.py registers Gemma4ForConditionalGeneration -> Gemma4Model(Gemma3Model)),
so after this merge the pipeline is:
    python merge_gguf_p5.py            # -> D:/t3-merge/gguf/p5-merged-16bit  (fp16 safetensors)
    python ~/.unsloth/llama.cpp/convert_hf_to_gguf.py D:/t3-merge/gguf/p5-merged-16bit \
        --outfile D:/t3-merge/gguf/gemma-4-e4b-longview-f16.gguf --outtype f16
    ~/.unsloth/llama.cpp/build/bin/Release/llama-quantize.exe <f16.gguf> <q4_k_m.gguf> Q4_K_M
    # copy the Q4_K_M into ~/.lmstudio/models/<pub>/<repo>-GGUF/ ; lms load ; run the ladder

Staged on D: (~15-30GB peak). Run in the upgraded copy venv from a vcvars shell.
"""
import os
from pathlib import Path

os.environ.setdefault("HF_HOME", r"D:/t3-merge/hf")
os.environ.setdefault("HF_HUB_OFFLINE", "1")

import torch

ADAPTER = os.environ.get("P5_ADAPTER",
                         r"C:/Users/nsdha/OneDrive/binary16/prime-silo/scripts/train/qlora/out_p5_4096/adapter")
OUT = Path(os.environ.get("P5_MERGE_OUT", r"D:/t3-merge/gguf/p5-merged-16bit"))


def main() -> int:
    from unsloth import FastModel
    print(f"[merge] loading tuned model from adapter {ADAPTER}")
    model, processor = FastModel.from_pretrained(
        model_name=ADAPTER, max_seq_length=5120, load_in_4bit=True,
        dtype=torch.bfloat16, full_finetuning=False,
    )
    tokenizer = getattr(processor, "tokenizer", processor)
    OUT.mkdir(parents=True, exist_ok=True)
    print(f"[merge] merging LoRA -> 16bit -> {OUT}")
    # merged_16bit: dequantize the 4bit base, fold the LoRA, save fp16 safetensors the converter reads.
    model.save_pretrained_merged(str(OUT), tokenizer, save_method="merged_16bit")
    print(f"[merge] done -> {OUT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
