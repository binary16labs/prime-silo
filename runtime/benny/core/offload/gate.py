"""The evaluation gate — cheapest check first.

1. **Deterministic** (free): every command in the manifest's deterministic plan
   (plus each acceptance-criterion ``verify``) must exit 0. Most failures stop
   here and never reach the planner or a model.
2. **LLM judge** (yellow only, only if deterministic passed): scores the artifact
   against the acceptance criteria, returns ``score`` + ``rationale``.

Anti-collusion (ADR-004): the judge model SHOULD differ from the executor model.
If they are identical the gate flags it and treats the judgment as low-confidence
— the deterministic checks remain the hard backstop the judge can never override.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, List, Optional

from .manifest import OffloadManifest
from .paths import repo_root

logger = logging.getLogger(__name__)


@dataclass
class CheckResult:
    command: str
    ok: bool
    exit_code: int
    output_tail: str = ""


@dataclass
class GateResult:
    passed: bool
    deterministic_ok: bool
    checks: List[CheckResult] = field(default_factory=list)
    judge_ran: bool = False
    judge_score: Optional[float] = None
    judge_rationale: str = ""
    judge_low_confidence: bool = False
    collusion_flag: bool = False
    escalate: bool = False
    summary: str = ""


async def _run_check(cmd: str, cwd: Path, timeout: int) -> CheckResult:
    try:
        proc = await asyncio.create_subprocess_shell(
            cmd,
            cwd=str(cwd),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
        )
        out, _ = await asyncio.wait_for(proc.communicate(), timeout=timeout)
        tail = (out or b"").decode("utf-8", "replace")[-400:]
        return CheckResult(cmd, proc.returncode == 0, proc.returncode or 0, tail)
    except asyncio.TimeoutError:
        return CheckResult(cmd, False, 124, f"timeout after {timeout}s")
    except Exception as exc:  # pragma: no cover - defensive
        return CheckResult(cmd, False, 1, str(exc)[-400:])


async def run_deterministic(manifest: OffloadManifest, timeout: int = 600) -> List[CheckResult]:
    root = repo_root()
    results: List[CheckResult] = []
    for cmd in manifest.deterministic_checks:
        results.append(await _run_check(cmd, root, timeout))
    return results


_THINK_RE = re.compile(r"<think>.*?</think>", re.DOTALL | re.IGNORECASE)


def _extract_last_json(text: str) -> Optional[dict]:
    """Pull the LAST balanced JSON object out of a model reply.

    Reasoning models emit prose (sometimes <think>...</think>) BEFORE the answer,
    so a greedy first-{-to-last-} match captures garbage. We strip any think
    block, then scan from the end for the last balanced ``{...}`` that parses.
    """
    if not text:
        return None
    cleaned = _THINK_RE.sub("", text)
    # find candidate closing braces from the end; for each, walk back to its match
    for close in range(len(cleaned) - 1, -1, -1):
        if cleaned[close] != "}":
            continue
        depth = 0
        for open_ in range(close, -1, -1):
            ch = cleaned[open_]
            if ch == "}":
                depth += 1
            elif ch == "{":
                depth -= 1
                if depth == 0:
                    try:
                        return json.loads(cleaned[open_ : close + 1])
                    except json.JSONDecodeError:
                        break  # not parseable from here; try an earlier close
    return None


async def run_judge(manifest: OffloadManifest, artifact: str, judge_model: str) -> Dict:
    """Score the artifact against acceptance criteria. Returns {score, rationale}.

    Robust to reasoning judges (R1/qwen-thinking): we ask for thinking off, give a
    larger token budget so the model can finish, and parse the LAST JSON object so
    leading chain-of-thought does not poison the result. NOTE: a fast non-reasoning
    instruct model is still the recommended judge — reasoning models are slow and
    spend their budget thinking instead of scoring (see ADR-004 §5)."""
    from ..local_executor import (
        resolve_executor,  # deferred: keeps the deterministic gate importable without httpx/tiktoken
    )

    executor = resolve_executor(judge_model)
    if executor is None:
        return {
            "score": None,
            "rationale": f"judge model '{judge_model}' unavailable",
            "available": False,
        }
    criteria = "\n".join(f"- [{c.id}] {c.statement}" for c in manifest.acceptance_criteria)
    prompt = (
        "You are a strict reviewer. Score how well the DELIVERABLE satisfies EVERY "
        "acceptance criterion for the task. Be skeptical; partial credit only when "
        "earned.\n\n"
        f"## Task intent\n{manifest.intent}\n\n"
        f"## Acceptance criteria\n{criteria}\n\n"
        f"## Deliverable\n```\n{artifact[:12000]}\n```\n\n"
        "Respond with ONLY a JSON object: "
        '{"score": <float 0..1>, "rationale": "<one sentence>", '
        '"unmet": ["<criterion ids not satisfied>"]}'
    )
    # extra_body: force a JSON envelope (Lemonade honors response_format on the
    # local instruct models — measured 2026-06-29) and ask thinking-capable recipes
    # to skip chain-of-thought. Both are harmless if a server ignores them.
    extra = {
        "response_format": {"type": "json_object"},
        "chat_template_kwargs": {"enable_thinking": False},
    }
    raw = ""
    data = None
    # one retry: small local judges intermittently emit unparseable output
    for attempt in range(2):
        try:
            raw = await executor.generate(
                prompt,
                system="Return only JSON.",
                temperature=0.0,
                max_tokens=800,
                extra_body=extra,
            )
        except Exception as exc:
            return {"score": None, "rationale": f"judge error: {exc}", "available": True}
        data = _extract_last_json(raw)
        if data is not None and "score" in data:
            break
    if data is None or "score" not in data:
        return {
            "score": None,
            "rationale": f"judge returned no parseable JSON verdict after retry "
            f"(reasoning model, or model too small to follow format): "
            f"{(raw or '')[:160]}",
            "available": True,
        }
    try:
        score = float(data.get("score"))
        return {
            "score": max(0.0, min(1.0, score)),
            "rationale": str(data.get("rationale", ""))[:300],
            "unmet": data.get("unmet", []),
            "available": True,
        }
    except (TypeError, ValueError) as exc:
        return {"score": None, "rationale": f"judge parse error: {exc}", "available": True}


async def evaluate(
    manifest: OffloadManifest, artifact: str, final_tier: str, executor_model: str, judge_model: str
) -> GateResult:
    """Run the full gate and decide pass / escalate for a non-red task."""
    checks = await run_deterministic(manifest)
    det_ok = all(c.ok for c in checks)  # vacuously True with no checks

    result = GateResult(passed=False, deterministic_ok=det_ok, checks=checks)

    if not det_ok:
        failed = [c.command for c in checks if not c.ok]
        result.escalate = manifest.escalation_policy != "never"
        result.summary = f"deterministic gate failed: {len(failed)} check(s)"
        return result

    # A generate task is an unapplied proposal — deterministic checks ran against
    # the live repo, not the artifact, so they CANNOT auto-pass it. Require a judge;
    # if none is configured, escalate honestly rather than report a false pass.
    if manifest.executor_mode == "generate" and (
        final_tier == "green" or not manifest.judge_enabled
    ):
        result.escalate = manifest.escalation_policy != "never"
        result.summary = (
            "generate proposal cannot be validated by deterministic checks on the "
            "live repo (ADR-001); no judge configured — escalating"
        )
        return result

    # green (shell, acts in place): deterministic-only, auto-pass
    if final_tier == "green" or not manifest.judge_enabled:
        result.passed = True
        result.summary = "passed (deterministic gate)" + (
            "" if not manifest.judge_enabled else "; judge disabled"
        )
        return result

    # yellow: judge
    verdict = await run_judge(manifest, artifact, judge_model)
    result.judge_ran = True
    result.judge_score = verdict.get("score")
    result.judge_rationale = verdict.get("rationale", "")
    result.collusion_flag = bool(judge_model) and judge_model == executor_model

    threshold = manifest.judge_threshold
    if result.judge_score is None:
        # judge unavailable -> cannot auto-approve a yellow task; escalate
        result.escalate = manifest.escalation_policy != "never"
        result.summary = f"deterministic passed; judge unavailable ({result.judge_rationale})"
        return result

    near = abs(result.judge_score - threshold) <= 0.1
    result.judge_low_confidence = near or result.collusion_flag

    if result.judge_score >= threshold and not (
        result.collusion_flag and manifest.escalation_policy in ("on_low_confidence", "always")
    ):
        result.passed = True
        result.summary = f"passed (judge {result.judge_score:.2f} >= {threshold:.2f})"
        if result.collusion_flag:
            result.summary += " [collusion-flagged: judge==executor]"
    else:
        policy = manifest.escalation_policy
        result.escalate = policy != "never" and (
            policy in ("always", "on_fail")
            or (policy == "on_low_confidence" and result.judge_low_confidence)
            or result.judge_score < threshold
        )
        result.summary = (
            f"judge {result.judge_score:.2f} < {threshold:.2f}"
            if result.judge_score < threshold
            else f"judge {result.judge_score:.2f} low-confidence"
        )
    return result
