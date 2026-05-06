"""Conversational risk-analyst harness — multi-turn drill-down on a finished run.

Where ``agent_report`` is one-shot ("write me a narrative"), this module is
interactive: the user opens a REPL against a specific pypes run id, and the
risk-analyst agent keeps full conversation context across turns. Every reply
is grounded against the same gold artifacts that the deterministic pipeline
already produced — the agent never mutates data and never invents numbers.

Slash commands inside the REPL:
    /facts              show the gold tables the agent has access to
    /receipt            print the run receipt as JSON
    /clear              clear the conversation history (facts stay loaded)
    /history            print the current conversation history
    /save <path>        write the conversation to a Markdown file
    /models             list locally-available LLM ids (probes Lemonade / Ollama)
    /model <id>         switch the active model for the rest of the session
    /help               show this help
    /exit  | /quit      leave the harness  (Ctrl-C also works)

The harness deliberately mirrors ``agent_report.RiskAnalystAgent`` so a
narrative session can flow into a chat session and vice-versa.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import sys
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional

from rich.console import Console
from rich.panel import Panel
from rich.rule import Rule
from rich.table import Table

from .agent_report import RiskAnalystAgent, _collect_facts, _load_run_manifest
from .models import RunReceipt

log = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# CONVERSATION TURN
# ---------------------------------------------------------------------------


@dataclass
class ChatTurn:
    role: str  # "user" or "assistant"
    content: str
    ts: str = field(default_factory=lambda: datetime.utcnow().isoformat() + "Z")


# ---------------------------------------------------------------------------
# HARNESS
# ---------------------------------------------------------------------------


class ChatHarness:
    """A multi-turn REPL bound to a single pypes run.

    Construction loads the run receipt, manifest snapshot and gold facts
    once. ``run_loop()`` then enters the interactive shell. Each user turn
    is sent to the LLM with the *full* facts payload + a sliding window
    of conversation history (capped by ``max_history``).
    """

    def __init__(
        self,
        *,
        workspace_root: Path,
        run_id: str,
        model: Optional[str] = None,
        system_override: Optional[str] = None,
        max_history: int = 20,
        agent: Optional[RiskAnalystAgent] = None,
        console: Optional[Console] = None,
    ) -> None:
        self.workspace_root = workspace_root
        self.run_id = run_id
        self.max_history = max(2, max_history)
        self.agent = agent or RiskAnalystAgent()
        self.console = console or Console()
        self.history: List[ChatTurn] = []

        run_dir = workspace_root / "runs" / f"pypes-{run_id}"
        receipt_path = run_dir / "receipt.json"
        if not receipt_path.exists():
            raise FileNotFoundError(f"Receipt not found: {receipt_path}")
        self.receipt = RunReceipt.model_validate_json(receipt_path.read_text(encoding="utf-8"))

        manifest = _load_run_manifest(run_dir)
        if manifest is None:
            raise FileNotFoundError(f"Manifest snapshot missing for run {run_id}")
        self.manifest = manifest

        self.facts = _collect_facts(run_dir, manifest, self.receipt)
        self.model = model or self._resolve_model()
        self.system_prompt = system_override or self._build_system_prompt()

    # ------------------------------------------------------------------
    # Public REPL
    # ------------------------------------------------------------------

    def run_loop(self) -> None:
        self._banner()
        try:
            while True:
                try:
                    user = self._prompt()
                except (EOFError, KeyboardInterrupt):
                    self.console.print()
                    self.console.print("[muted]session ended[/]")
                    return
                if not user.strip():
                    continue
                if user.startswith("/"):
                    if self._handle_slash(user):
                        return
                    continue
                self.history.append(ChatTurn("user", user))
                try:
                    with self.console.status("[cyan]Risk-analyst thinking...[/]", spinner="dots"):
                        reply = self._call_llm(user)
                except Exception as exc:
                    self.console.print(self._llm_failure_panel(exc))
                    # Drop the orphaned user turn so retry isn't double-counted.
                    if self.history and self.history[-1].role == "user":
                        self.history.pop()
                    continue
                self.history.append(ChatTurn("assistant", reply))
                self.console.print()
                self.console.print(Panel(reply, title="[bold green] Risk Analyst [/]",
                                          border_style="green", padding=(1, 2)))
        finally:
            pass

    # ------------------------------------------------------------------
    # Internals
    # ------------------------------------------------------------------

    def _banner(self) -> None:
        gold_steps = [k for k in self.facts.keys() if not k.startswith("__")]
        breaches = self.facts.get("__threshold_breaches__", {}).get("breaches", [])
        local_hints = self._banner_local_hints()
        local_line = (
            f"\n[bold white]Local models[/] [muted]{local_hints}[/]"
            if local_hints else ""
        )
        warn_line = ""
        if isinstance(self.model, str) and self.model.endswith("/default"):
            warn_line = (
                "\n[bold yellow]!! Active model id is generic ('/default') and may 404 on first call.[/]"
                "\n[muted]   Run [/][accent]/models[/][muted] then [/][accent]/model <id>[/][muted] before sending a message.[/]"
            )
        self.console.print()
        self.console.print(Panel.fit(
            f"[bold white]Run id[/]      [accent]{self.run_id}[/]\n"
            f"[bold white]Manifest[/]    [accent]{self.manifest.id}[/]  [muted]({self.manifest.name})[/]\n"
            f"[bold white]Workspace[/]   [accent]{self.manifest.workspace}[/]\n"
            f"[bold white]Status[/]      [accent]{self.receipt.status}[/]  [muted]({self.receipt.duration_ms or '?'} ms)[/]\n"
            f"[bold white]Agent[/]       [accent]{self.agent.name}[/]  [muted]({self.model})[/]\n"
            f"[bold white]Gold facts[/]  [white]{len(gold_steps)}[/] tables, "
            f"[white]{len(breaches)}[/] breach(es)\n"
            f"[bold white]History cap[/] [muted]{self.max_history} turns[/]"
            f"{local_line}{warn_line}",
            title="[bold cyan]  Benny Pypes — Risk-Analyst Chat [/]",
            border_style="cyan", padding=(0, 2),
        ))
        self.console.print("[muted]Ask anything about the run. Type[/] [accent]/help[/] "
                            "[muted]for slash commands,[/] [accent]/exit[/] [muted]to leave.[/]")
        self.console.print()

    def _prompt(self) -> str:
        # Rich's input rendering is fine on cooked Windows terminals.
        return self.console.input("[bold cyan]you[/] [muted]>[/] ").strip()

    def _handle_slash(self, line: str) -> bool:
        """Return True iff the loop should exit."""
        cmd, _, rest = line.partition(" ")
        cmd = cmd.lower().strip()
        rest = rest.strip()
        if cmd in ("/exit", "/quit"):
            self.console.print("[muted]bye[/]")
            return True
        if cmd == "/help":
            self.console.print(Panel(
                "[bold]Slash commands[/]\n"
                "  /facts            show loaded gold tables and a row sample\n"
                "  /receipt          print the run receipt JSON\n"
                "  /history          show current conversation history\n"
                "  /clear            clear conversation history (facts remain loaded)\n"
                "  /save <path>      save the chat transcript to a Markdown file\n"
                "  /models           list locally-available LLM ids (probes Lemonade / Ollama)\n"
                "  /model <id>       switch the active model for the rest of the session\n"
                "  /help             show this help\n"
                "  /exit | /quit     leave the harness",
                border_style="dim", padding=(0, 1),
            ))
            return False
        if cmd == "/models":
            self._render_local_models_table()
            return False
        if cmd == "/model":
            if not rest:
                self.console.print("[red]usage: /model <id>   e.g. /model lemonade/Gemma-4-E4B-it-GGUF[/]")
                return False
            old, self.model = self.model, rest
            self.console.print(f"[green]model switched: [bold]{old}[/] -> [bold]{self.model}[/][/]")
            return False
        if cmd == "/facts":
            tbl = Table(box=None, show_header=True, header_style="bold cyan", expand=True)
            tbl.add_column("Table",     style="bold white", min_width=22)
            tbl.add_column("Rows",      justify="right")
            tbl.add_column("Columns",   justify="right", style="muted")
            tbl.add_column("Stage",     style="muted")
            for name, payload in self.facts.items():
                if name.startswith("__"):
                    continue
                tbl.add_row(name, f"{payload.get('row_count', 0):,}",
                            str(len(payload.get("columns", []))),
                            payload.get("stage", "-"))
            self.console.print(tbl)
            breaches = self.facts.get("__threshold_breaches__", {}).get("breaches", [])
            if breaches:
                self.console.print(f"[yellow]Plus {len(breaches)} threshold breach(es)[/]")
            return False
        if cmd == "/receipt":
            self.console.print(self.receipt.model_dump_json(indent=2))
            return False
        if cmd == "/history":
            for t in self.history:
                color = "cyan" if t.role == "user" else "green"
                self.console.print(f"[{color}][{t.role}][/] [muted]{t.ts}[/]")
                self.console.print(f"  {t.content}")
            return False
        if cmd == "/clear":
            self.history.clear()
            self.console.print("[muted]conversation history cleared[/]")
            return False
        if cmd == "/save":
            if not rest:
                self.console.print("[red]usage: /save <path.md>[/]")
                return False
            path = Path(rest).expanduser().resolve()
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(self._render_transcript_md(), encoding="utf-8")
            self.console.print(f"[green]transcript saved -> {path}[/]")
            return False
        self.console.print(f"[red]unknown slash command:[/] {cmd}  [muted](try /help)[/]")
        return False

    # ------------------------------------------------------------------
    # LLM
    # ------------------------------------------------------------------

    def _build_system_prompt(self) -> str:
        skills_block = "\n".join(f"  - {s}" for s in self.agent.skills)
        # Local FLM/GGUF chat models commonly cap context at 4-8k tokens. The
        # default operating-manual augmentation that ``call_model()`` injects
        # adds ~2-3k chars on top of whatever we put here, so keep our own
        # facts blob lean. Override with BENNY_PYPES_FACTS_CHAR_BUDGET if a
        # bigger model (e.g. cloud) is in use.
        budget = int(os.environ.get("BENNY_PYPES_FACTS_CHAR_BUDGET", "5000"))
        facts_json = json.dumps(self.facts, indent=2, default=str)
        if len(facts_json) > budget:
            facts_json = (
                facts_json[:budget]
                + f"\n... [truncated to {budget} chars for local-model context window — "
                + "raise BENNY_PYPES_FACTS_CHAR_BUDGET for bigger models]"
            )

        return (
            f"{self.agent.persona}\n\n"
            f"FRAMEWORK CONTEXT:\n{self.agent.framework_context}\n\n"
            f"AUTHORISED SKILLS:\n{skills_block}\n\n"
            f"CHAT MODE INSTRUCTIONS:\n"
            f"  - You are in an interactive drill-down session with a risk officer.\n"
            f"  - Answer their questions using ONLY the facts below. Quote specific\n"
            f"    counterparty ids, ISINs, segments, dates, and USD values from the\n"
            f"    JSON. Do NOT invent rows or values.\n"
            f"  - Keep replies concise and structured. Use Markdown bullet lists or\n"
            f"    short Markdown tables when comparing more than two items.\n"
            f"  - If the answer needs a fact NOT in the JSON, say so explicitly\n"
            f"    instead of guessing — and propose which gold step to drill into.\n"
            f"  - Never recommend code or pipeline changes; you are advisory only.\n\n"
            f"RUN CONTEXT:\n"
            f"  - Manifest: {self.manifest.id} ({self.manifest.name})\n"
            f"  - Workspace: {self.manifest.workspace}\n"
            f"  - Run id: {self.receipt.run_id}\n"
            f"  - Status: {self.receipt.status} (duration {self.receipt.duration_ms or '?'} ms)\n"
            f"  - Compliance: {', '.join(self.manifest.governance.compliance_tags) or '-'}\n\n"
            f"GOLD-LAYER FACTS (top rows per table):\n```json\n{facts_json}\n```\n"
        )

    def _resolve_model(self) -> str:
        env = os.environ.get("BENNY_DEFAULT_MODEL")
        if env:
            return env
        try:
            from ..core.models import get_active_model

            mid = asyncio.run(get_active_model(workspace_id=self.manifest.workspace, role="chat"))
        except Exception as exc:
            log.debug("chat: get_active_model failed (%s)", exc)
            mid = ""
        # ``get_active_model`` falls back to ``lemonade/default`` when its
        # heartbeat probe fails (its URL math is wrong for ``/api/v1`` bases).
        # Detect that fallback and substitute a real Lemonade model id.
        if not mid or mid.endswith("/default"):
            real = _first_chat_capable_lemonade_model()
            if real:
                return f"lemonade/{real}"
        if not mid:
            real = _first_ollama_model()
            if real:
                return f"ollama/{real}"
            return "ollama/llama3.1"
        return mid

    # ------------------------------------------------------------------
    # Local-provider discovery
    # ------------------------------------------------------------------

    def _render_local_models_table(self) -> None:
        """Hit Lemonade + Ollama and show what's actually loadable."""
        from rich.table import Table as _T
        tbl = _T(box=None, show_header=True, header_style="bold cyan", expand=True)
        tbl.add_column("Provider", style="muted")
        tbl.add_column("Model id (use as `/model <id>`)", style="bold white", min_width=42)
        tbl.add_column("Labels", style="muted")
        tbl.add_column("Size GB", justify="right", style="muted")
        any_rows = False
        for raw_id, labels, size in _list_lemonade_models():
            tbl.add_row("lemonade", f"lemonade/{raw_id}", ",".join(labels[:3]), f"{size:.1f}" if size else "-")
            any_rows = True
        for raw_id, _, size in _list_ollama_models():
            tbl.add_row("ollama", f"ollama/{raw_id}", "", f"{size:.1f}" if size else "-")
            any_rows = True
        if not any_rows:
            self.console.print("[yellow]No local providers reachable. Try Ctrl-C and pass --model openai/gpt-4o-mini[/]")
            return
        self.console.print(tbl)
        self.console.print("[muted]Tip:[/] [accent]/model lemonade/Gemma-4-E4B-it-GGUF[/]  [muted](or any id from above)[/]")

    def _call_llm(self, latest_user_message: str) -> str:
        """Send system + windowed history + new user message to call_model()."""
        from ..core.models import call_model

        # Sliding window of conversation history (excluding the just-pushed user turn).
        prior = self.history[-(self.max_history * 2 + 1):-1]
        msgs: List[Dict[str, str]] = [{"role": "system", "content": self.system_prompt}]
        for t in prior:
            msgs.append({"role": t.role, "content": t.content})
        msgs.append({"role": "user", "content": latest_user_message})

        # Cap completion length: small local models stall when asked to emit
        # 1500 tokens and the prompt already chews most of their window.
        max_out = int(os.environ.get("BENNY_PYPES_CHAT_MAX_TOKENS", "800"))
        coro = call_model(model=self.model, messages=msgs, temperature=0.3, max_tokens=max_out)
        try:
            return asyncio.run(coro)
        except RuntimeError as exc:
            if "asyncio.run() cannot be called" in str(exc):
                loop = asyncio.new_event_loop()
                try:
                    return loop.run_until_complete(coro)
                finally:
                    loop.close()
            raise

    def _llm_failure_panel(self, exc: Exception) -> Panel:
        """Render an actionable error panel when call_model() blows up.

        Distinguishes three failure modes so the hint actually matches the
        cause:
          * **Context-window exceeded** ("Max length reached!", "no 'choices'")
            — suggest a smaller facts budget, /clear, or a roomier model.
          * **Generic model id** (``/default``) — point to ``/model``.
          * **404 / model not loaded** — list real model ids.
          * **Anything else** — surface the raw error and offer ``/models``.
        """
        msg = str(exc)
        lower = msg.lower()
        ctx_overflow = (
            "max length reached" in lower
            or "no 'choices'" in lower
            or "context" in lower and "length" in lower
        )
        is_default_id = isinstance(self.model, str) and self.model.endswith("/default")
        body = [f"[red]{msg}[/]"]
        if ctx_overflow:
            cur_budget = os.environ.get("BENNY_PYPES_FACTS_CHAR_BUDGET", "5000")
            body.append("")
            body.append("[yellow]Likely cause:[/] this local model's context window can't hold the full facts payload.")
            body.append(f"[muted]Current facts budget:[/] [accent]{cur_budget}[/] chars")
            body.append("[muted]Try one of:[/]")
            body.append("  [accent]/clear[/]                                  drop chat history")
            body.append("  [accent]/model lemonade/Gemma-4-E4B-it-GGUF[/]     bigger window (~5GB)")
            body.append("  [accent]/model lemonade/Gemma-4-26B-A4B-it-GGUF[/] roomier (~17GB)")
            body.append("  [accent]$env:BENNY_PYPES_FACTS_CHAR_BUDGET=2500[/] (PowerShell) then restart chat")
        elif is_default_id:
            body.append("")
            body.append("[muted]Active model id is the placeholder [/][accent]'/default'[/][muted].[/]")
            body.append("[muted]Switch in-session:[/] [accent]/models[/][muted] then [/][accent]/model <id>[/]")
        elif isinstance(self.model, str) and self.model.startswith("lemonade/"):
            ids = [m[0] for m in _list_lemonade_models()]
            chat_ids = [i for i in ids if not any(x in i.lower() for x in ("embed", "whisper", "kokoro", "nomic"))]
            if chat_ids:
                body.append("")
                body.append("[muted]Try a different Lemonade chat model:[/]")
                body.append(f"  [accent]{', '.join(chat_ids[:4])}[/]")
                body.append(f"[muted]Switch in-session:[/] [accent]/model lemonade/{chat_ids[0]}[/]")
                body.append("[muted]List all:[/] [accent]/models[/]")
            else:
                body.append("[muted]Run [/][accent]/models[/][muted] to see locally-available ids.[/]")
        else:
            body.append("[muted]Run [/][accent]/models[/][muted] to see what local providers expose, then [/][accent]/model <id>[/][muted] to switch.[/]")
        return Panel("\n".join(body), title="[bold red] LLM call failed [/]",
                     border_style="red", padding=(0, 1))

    def _banner_local_hints(self) -> Optional[str]:
        """Build a 'local models available' line for the startup banner."""
        if not isinstance(self.model, str):
            return None
        if not self.model.startswith(("lemonade/", "ollama/")):
            return None
        models = _list_lemonade_models() if self.model.startswith("lemonade/") else _list_ollama_models()
        chat_models = [
            m for m in models
            if not any(x in m[0].lower() for x in ("embed", "whisper", "kokoro", "nomic"))
        ]
        if not chat_models:
            return None
        return ", ".join(m[0] for m in chat_models[:4])

    def _render_transcript_md(self) -> str:
        lines = [
            f"# Risk-Analyst Chat — {self.manifest.name}",
            "",
            f"- Run id: `{self.run_id}`",
            f"- Manifest: `{self.manifest.id}`",
            f"- Workspace: `{self.manifest.workspace}`",
            f"- Model: `{self.model}`",
            f"- Saved: {datetime.utcnow().isoformat()}Z",
            "",
            "---",
            "",
        ]
        for t in self.history:
            tag = "**You**" if t.role == "user" else "**Risk Analyst**"
            lines.append(f"### {tag}  _{t.ts}_")
            lines.append("")
            lines.append(t.content)
            lines.append("")
        return "\n".join(lines)


# ---------------------------------------------------------------------------
# LOCAL-PROVIDER PROBES (Lemonade + Ollama)
#
# These hit the *real* OpenAI-compatible model-list endpoints and return a
# tuple of (id, labels, size_gb). Cached for the lifetime of the process
# so the REPL stays snappy when the user spams /models.
# ---------------------------------------------------------------------------


_LEMONADE_BASE = os.environ.get("BENNY_LEMONADE_BASE", "http://127.0.0.1:13305/api/v1")
_OLLAMA_BASE   = os.environ.get("BENNY_OLLAMA_BASE",   "http://127.0.0.1:11434")

_lemonade_cache: Optional[List[tuple]] = None
_ollama_cache: Optional[List[tuple]] = None


def _list_lemonade_models() -> List[tuple]:
    """Return [(id, labels, size_gb), ...] from Lemonade — empty list if unreachable."""
    global _lemonade_cache
    if _lemonade_cache is not None:
        return _lemonade_cache
    out: List[tuple] = []
    try:
        import urllib.request

        with urllib.request.urlopen(f"{_LEMONADE_BASE}/models", timeout=2.0) as r:
            payload = json.loads(r.read().decode("utf-8"))
        for m in payload.get("data", []):
            out.append((m.get("id", ""), m.get("labels", []) or [], float(m.get("size") or 0)))
    except Exception as exc:
        log.debug("chat: lemonade probe failed (%s)", exc)
    _lemonade_cache = out
    return out


def _list_ollama_models() -> List[tuple]:
    """Return [(id, [], size_gb), ...] from Ollama — empty if unreachable."""
    global _ollama_cache
    if _ollama_cache is not None:
        return _ollama_cache
    out: List[tuple] = []
    try:
        import urllib.request

        with urllib.request.urlopen(f"{_OLLAMA_BASE}/api/tags", timeout=2.0) as r:
            payload = json.loads(r.read().decode("utf-8"))
        for m in payload.get("models", []):
            size_gb = float(m.get("size", 0)) / (1024 ** 3) if m.get("size") else 0
            out.append((m.get("name", ""), [], size_gb))
    except Exception as exc:
        log.debug("chat: ollama probe failed (%s)", exc)
    _ollama_cache = out
    return out


def _first_chat_capable_lemonade_model() -> Optional[str]:
    """Pick a sensible default Lemonade chat model id, skipping embeds/tts/etc."""
    skip = ("embed", "whisper", "kokoro", "nomic")
    # Prefer smaller models for snappy REPL turns.
    candidates = sorted(
        [m for m in _list_lemonade_models() if not any(x in m[0].lower() for x in skip)],
        key=lambda m: m[2] or 999,
    )
    return candidates[0][0] if candidates else None


def _first_ollama_model() -> Optional[str]:
    models = _list_ollama_models()
    return models[0][0] if models else None
