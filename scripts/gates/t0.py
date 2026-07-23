#!/usr/bin/env python3
"""Gate T0 — prove the QLoRA trainer on real RDNA4 eGPU hardware.

The make-or-break hardware gate for EP-T. Two things must be true:

  1. eGPU enumerates for compute — a ROCm/HIP tool reports gfx1200 (RDNA4)
     with ~16 GB VRAM. Probed via hipInfo / rocminfo / rocm-smi (first that
     answers). No compute device reporting gfx1200 => exit non-zero,
     reason=gpu_absent, and nothing is marked passed.

  2. A real ~30-step 4-bit QLoRA smoke actually ran — a saved artifact holds
     the per-step loss (decreasing overall) + step count, and a LoRA adapter
     is on disk and structurally reloadable. Absent/short/non-decreasing =>
     reason=no_smoke_run / smoke_too_few_steps / smoke_no_decrease.

Read-only: this gate installs nothing and starts no training. Bringing the
hardware up (AMD driver + ROCm 6.4.2+ for RDNA4, or the WSL2-ROCm fallback)
and running the smoke are the owner-driven, human-signed part of T0. The gate
just tells the truth about whether both are real yet.

Smoke artifact (default `scripts/train/smoke/out/`, override with $T0_SMOKE_DIR):
    smoke_result.json  {base_model, rocm_build, device, vram_gib, steps,
                        loss:[...per step...], final_loss, adapter_dir}
    <adapter_dir>/     adapter_config.json + adapter_model.safetensors

Exit 0 = gate green. Non-zero = red, with a one-line reason on stdout.
"""

import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SMOKE_DIR = Path(os.environ.get("T0_SMOKE_DIR", ROOT / "scripts" / "train" / "smoke" / "out"))

TARGET_ARCH = "gfx1200"          # RX 9060 XT / RDNA4
MIN_VRAM_GIB = 15.0              # ~16 GB card, allow headroom for reserved/reported delta
MIN_STEPS = 30                   # the contract's ~30-step smoke


def _fail(reason: str, detail: str = "") -> int:
    print(f"[t0] reason={reason}{(' — ' + detail) if detail else ''}")
    print("[t0] GATE RED")
    return 1


def _run(cmd: list) -> str:
    """Run a probe tool, return combined stdout (empty string if it can't run)."""
    exe = shutil.which(cmd[0])
    if not exe:
        return ""
    try:
        p = subprocess.run(
            [exe, *cmd[1:]], capture_output=True, text=True, timeout=60,
            errors="replace",
        )
        return (p.stdout or "") + "\n" + (p.stderr or "")
    except (subprocess.SubprocessError, OSError):
        return ""


def probe_gpu() -> dict | None:
    """Return {tool, arch, vram_gib, raw} if a compute device reports gfx1200, else None."""
    # hipInfo: 'gcnArchName:  gfx1200' + 'totalGlobalMem:  NNNN' (bytes or MB, varies)
    out = _run(["hipInfo"])
    if TARGET_ARCH in out:
        vram = _vram_from_bytes(re.search(r"totalGlobalMem:\s*([0-9]+)", out))
        return {"tool": "hipInfo", "arch": TARGET_ARCH, "vram_gib": vram, "raw": out[:2000]}

    # rocminfo: 'Name: gfx1200' + a 'Size: NNNN(KB)' under the GPU agent's global pool
    out = _run(["rocminfo"])
    if TARGET_ARCH in out:
        vram = _vram_from_kb(re.search(r"Size:\s*([0-9]+)\(KB\)", out))
        return {"tool": "rocminfo", "arch": TARGET_ARCH, "vram_gib": vram, "raw": out[:2000]}

    # rocm-smi: product name + VRAM total (MB)
    out = _run(["rocm-smi", "--showproductname", "--showmeminfo", "vram"])
    if TARGET_ARCH in out or "9060" in out:
        m = re.search(r"(?:vram|VRAM).*?Total.*?([0-9]+)\s*(?:MB|MiB)", out, re.S | re.I)
        vram = round(int(m.group(1)) / 1024, 1) if m else None
        return {"tool": "rocm-smi", "arch": TARGET_ARCH, "vram_gib": vram, "raw": out[:2000]}

    # Fallback: AMD's bundled-runtime ROCm PyTorch wheels ship no HIP SDK CLI
    # tools, so ask torch itself. torch.cuda under ROCm reports the HIP device.
    torch_probe = probe_gpu_via_torch()
    if torch_probe:
        return torch_probe

    return None


def probe_gpu_via_torch() -> dict | None:
    """Query the training stack's torch for a gfx1200 HIP device.

    Runs in the trainer venv when the gate can't import torch itself — set
    $T0_VENV_PY, else the default Unsloth venv python is tried.
    """
    snippet = (
        "import json,torch\n"
        "d=None\n"
        "if torch.cuda.is_available():\n"
        " p=torch.cuda.get_device_properties(0)\n"
        " d={'arch':getattr(p,'gcnArchName','') or '','vram_gib':round(p.total_memory/1024**3,1)}\n"
        "print(json.dumps(d))\n"
    )
    pys = [sys.executable,
           os.environ.get("T0_VENV_PY", ""),
           str(Path.home() / ".unsloth" / "studio" / "unsloth_studio" / "Scripts" / "python.exe")]
    for py in pys:
        if not py or not Path(py).exists():
            continue
        try:
            p = subprocess.run([py, "-c", snippet], capture_output=True, text=True, timeout=120)
        except (subprocess.SubprocessError, OSError):
            continue
        line = (p.stdout or "").strip().splitlines()[-1:] or [""]
        try:
            info = json.loads(line[0])
        except (ValueError, IndexError):
            continue
        if info and TARGET_ARCH in (info.get("arch") or ""):
            return {"tool": f"torch({Path(py).parent.name})", "arch": TARGET_ARCH,
                    "vram_gib": info.get("vram_gib"), "raw": info.get("arch", "")}
    return None


def _vram_from_bytes(m) -> float | None:
    if not m:
        return None
    val = int(m.group(1))
    # hipInfo has reported this in bytes on some builds, MB on others — normalise.
    return round(val / (1024 ** 3), 1) if val > 10 ** 9 else round(val / 1024, 1)


def _vram_from_kb(m) -> float | None:
    return round(int(m.group(1)) / (1024 ** 2), 1) if m else None


def check_smoke() -> tuple[bool, str, dict]:
    """Verify the saved QLoRA smoke artifact. Returns (ok, reason, summary)."""
    result = SMOKE_DIR / "smoke_result.json"
    if not result.is_file():
        return False, "no_smoke_run", {}
    try:
        data = json.loads(result.read_text(encoding="utf-8"))
    except (ValueError, OSError) as e:
        return False, "smoke_unreadable", {"error": str(e)}

    loss = data.get("loss") or []
    steps = int(data.get("steps") or len(loss))
    if steps < MIN_STEPS or len(loss) < MIN_STEPS:
        return False, "smoke_too_few_steps", {"steps": steps, "loss_points": len(loss)}

    # Loss must trend down overall (mean of first quarter > mean of last quarter).
    q = max(1, len(loss) // 4)
    if (sum(loss[:q]) / q) <= (sum(loss[-q:]) / q):
        return False, "smoke_no_decrease", {"first_q": sum(loss[:q]) / q, "last_q": sum(loss[-q:]) / q}

    # Adapter must be on disk and structurally reloadable.
    adir = Path(data.get("adapter_dir") or (SMOKE_DIR / "adapter"))
    if not adir.is_absolute():
        adir = (SMOKE_DIR / adir).resolve()
    if not (adir / "adapter_config.json").is_file():
        return False, "adapter_missing", {"adapter_dir": str(adir)}
    weights = list(adir.glob("adapter_model.safetensors")) + list(adir.glob("adapter_model.bin"))
    if not weights or weights[0].stat().st_size == 0:
        return False, "adapter_missing", {"adapter_dir": str(adir)}
    if not _adapter_reloads(weights[0]):
        return False, "adapter_unloadable", {"adapter": str(weights[0])}

    return True, "", {
        "base_model": data.get("base_model"),
        "rocm_build": data.get("rocm_build"),
        "steps": steps,
        "final_loss": data.get("final_loss", loss[-1]),
        "first_loss": loss[0],
        "adapter": str(weights[0]),
    }


def _adapter_reloads(weights: Path) -> bool:
    """Best-effort structural reload: open the safetensors header / torch load.

    Passes on file integrity when the libs aren't present, so the gate doesn't
    demand torch on the probe box; a real load is exercised by the smoke itself.
    """
    if weights.suffix == ".safetensors":
        try:
            from safetensors import safe_open  # type: ignore

            with safe_open(str(weights), framework="pt") as f:
                return len(f.keys()) > 0
        except ImportError:
            # No safetensors lib here — verify the header length prefix is sane.
            try:
                with weights.open("rb") as fh:
                    n = int.from_bytes(fh.read(8), "little")
                    return 0 < n < weights.stat().st_size
            except OSError:
                return False
    try:
        import torch  # type: ignore

        return bool(torch.load(str(weights), map_location="cpu"))
    except ImportError:
        return weights.stat().st_size > 0
    except Exception:
        return False


def main() -> int:
    # Scenario: the eGPU enumerates for compute.
    gpu = probe_gpu()
    if gpu is None:
        return _fail("gpu_absent", f"no compute device reports {TARGET_ARCH} "
                     "(hipInfo/rocminfo/rocm-smi absent or silent)")
    print(f"[t0] gpu: {gpu['arch']} via {gpu['tool']} — {gpu['vram_gib']} GiB VRAM")
    if gpu["vram_gib"] is not None and gpu["vram_gib"] < MIN_VRAM_GIB:
        return _fail("vram_too_small", f"{gpu['vram_gib']} GiB < {MIN_VRAM_GIB} GiB")

    # Scenario: a real QLoRA step completed and saved.
    ok, reason, summary = check_smoke()
    if not ok:
        return _fail(reason, json.dumps(summary) if summary else f"looked in {SMOKE_DIR}")

    print(f"[t0] smoke: base={summary['base_model']} steps={summary['steps']} "
          f"loss {summary['first_loss']:.4f} -> {summary['final_loss']:.4f} "
          f"rocm={summary['rocm_build']}")
    # Machine-readable evidence line for the verifier / T0-trainer-evidence.md.
    print("[t0] evidence " + json.dumps({"device": gpu["arch"], "vram_gib": gpu["vram_gib"],
                                         "tool": gpu["tool"], **summary}))
    print("[t0] GATE GREEN")
    return 0


if __name__ == "__main__":
    sys.exit(main())
