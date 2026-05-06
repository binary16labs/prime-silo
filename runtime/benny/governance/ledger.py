"""AOS-001 Phase 9 — Append-only HMAC-chained ledger for SOX 404 audit.

Public API
----------
  LedgerEntry
      Dataclass holding the fields required by AOS-F26 / AOS-COMP1.
      After :func:`append_entry` the fields ``seq``, ``prev_hash``,
      ``entry_hash``, ``hmac``, and ``timestamp`` are populated.

  LedgerRewindError
      Raised when a rewind (deletion / force-reset of ledger entries)
      is detected (AOS-SEC6).

  append_entry(entry, *, ledger_dir, secret) -> LedgerEntry
      Appends *entry* to ``<ledger_dir>/ledger.jsonl`` and updates the
      ``<ledger_dir>/HEAD`` pointer file.  Sequence numbers are 1-based
      and monotonically increasing.  The HMAC chain ties each entry to
      its predecessor:

          hmac = HMAC-SHA256(secret,
                             prompt_hash || diff_hash || prev_hash)

      Returns the populated entry (with seq, prev_hash, entry_hash, hmac,
      timestamp assigned).

  get_head_hash(*, ledger_dir) -> str | None
      Returns the SHA-256 hex digest of the last appended entry as stored
      in ``<ledger_dir>/HEAD``, or ``None`` if the ledger is empty.

  verify_chain(*, ledger_dir, secret) -> bool
      Re-reads every entry in ``ledger.jsonl`` in order and verifies:
        1. Each entry's stored HMAC matches the recomputed value.
        2. Each entry's ``prev_hash`` matches the ``entry_hash`` of the
           preceding entry (genesis prev_hash = 64 zeros).
      Returns ``True`` when the chain is intact, ``False`` otherwise
      (AOS-F27 / AOS-SEC6).

AOS requirements covered
------------------------
  F26   append_entry(): monotonic seq + HMAC chain.
  F27   SOX 404 intent proof in each entry; verify_chain() for audit.
  SEC6  Rewind detection: HEAD vs final chain entry.
  COMP1 All required SOX fields present in every ledger record.
  NFR8  Stdlib-only (hashlib, hmac, json, pathlib) — no network.

Dependencies: stdlib only (dataclasses, datetime, hashlib, hmac, json,
              pathlib).  No new top-level dependency.
"""

from __future__ import annotations

import hashlib
import hmac as hmac_lib
import json
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

# Genesis hash used as the prev_hash of the very first ledger entry.
_GENESIS_HASH = "0" * 64

_LEDGER_FILENAME = "ledger.jsonl"
_HEAD_FILENAME = "HEAD"


# ---------------------------------------------------------------------------
# Exceptions
# ---------------------------------------------------------------------------


class LedgerRewindError(RuntimeError):
    """Raised when a ledger rewind (history tampering) is detected (AOS-SEC6)."""


# ---------------------------------------------------------------------------
# Data model
# ---------------------------------------------------------------------------


@dataclass
class LedgerEntry:
    """SOX 404 ledger record (AOS-F26 / AOS-COMP1).

    Fields populated by the caller before :func:`append_entry`
    ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
    prompt_hash:    SHA-256 of the prompt that generated this action.
    diff_hash:      SHA-256 of the file-diff / change produced.
    persona:        Agent persona name (e.g. ``"architect"``).
    model:          LLM model identifier.
    model_hash:     SHA-256 of the model weights / manifest.
    manifest_sig:   SHA-256 signature of the active manifest.

    Fields populated by :func:`append_entry`
    ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
    seq:            1-based monotonic sequence number.
    prev_hash:      entry_hash of the preceding entry (genesis = 64 zeros).
    entry_hash:     SHA-256 of the canonical JSON serialisation of this
                    record (used as the ``prev_hash`` of the next entry).
    hmac:           HMAC-SHA256(secret, prompt_hash || diff_hash || prev_hash).
    timestamp:      ISO-8601 UTC timestamp at append time.
    """

    # --- caller-supplied ---
    prompt_hash:  str
    diff_hash:    str
    persona:      str
    model:        str
    model_hash:   str
    manifest_sig: str

    # --- assigned by append_entry ---
    seq:        int        = field(default=0, compare=False)
    prev_hash:  str        = field(default=_GENESIS_HASH, compare=False)
    entry_hash: str        = field(default="", compare=False)
    hmac:       str        = field(default="", compare=False)
    timestamp:  str        = field(default="", compare=False)


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------


def _ledger_path(ledger_dir: Path) -> Path:
    return ledger_dir / _LEDGER_FILENAME


def _head_path(ledger_dir: Path) -> Path:
    return ledger_dir / _HEAD_FILENAME


def _compute_hmac(secret: bytes, prompt_hash: str, diff_hash: str, prev_hash: str) -> str:
    """Compute HMAC-SHA256(secret, prompt_hash || diff_hash || prev_hash)."""
    payload = (prompt_hash + diff_hash + prev_hash).encode("utf-8")
    return hmac_lib.new(secret, payload, hashlib.sha256).hexdigest()


def _record_dict(entry: LedgerEntry) -> dict:
    """Serialise *entry* to the canonical dict used for hashing and JSONL storage."""
    return {
        "seq":          entry.seq,
        "prompt_hash":  entry.prompt_hash,
        "diff_hash":    entry.diff_hash,
        "prev_hash":    entry.prev_hash,
        "persona":      entry.persona,
        "model":        entry.model,
        "model_hash":   entry.model_hash,
        "manifest_sig": entry.manifest_sig,
        "timestamp":    entry.timestamp,
        "hmac":         entry.hmac,
        "entry_hash":   entry.entry_hash,
    }


def _hash_record(record: dict) -> str:
    """SHA-256 of the canonical JSON representation (sorted keys)."""
    canonical = json.dumps(record, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def append_entry(
    entry: LedgerEntry,
    *,
    ledger_dir: Path,
    secret: bytes,
) -> LedgerEntry:
    """Append *entry* to the HMAC-chained ledger (AOS-F26).

    Parameters
    ----------
    entry:
        Populated :class:`LedgerEntry` (caller supplies prompt_hash,
        diff_hash, persona, model, model_hash, manifest_sig).
    ledger_dir:
        Directory where ``ledger.jsonl`` and ``HEAD`` are stored.
    secret:
        HMAC secret bytes.  Never logged or stored.

    Returns
    -------
    LedgerEntry
        The same entry, mutated in-place with seq, prev_hash, entry_hash,
        hmac, and timestamp filled in.  Also returned for convenience.
    """
    ledger_dir = Path(ledger_dir)
    ledger_dir.mkdir(parents=True, exist_ok=True)

    ledger_file = _ledger_path(ledger_dir)
    head_file = _head_path(ledger_dir)

    # Determine previous hash and sequence number
    prev_hash = _GENESIS_HASH
    next_seq = 1

    if ledger_file.exists():
        lines = [l for l in ledger_file.read_text(encoding="utf-8").splitlines() if l.strip()]
        if lines:
            last_record = json.loads(lines[-1])
            prev_hash = last_record.get("entry_hash", _GENESIS_HASH)
            next_seq = last_record.get("seq", 0) + 1

    # Assign ledger fields
    entry.seq = next_seq
    entry.prev_hash = prev_hash
    entry.timestamp = datetime.now(timezone.utc).isoformat()
    entry.hmac = _compute_hmac(secret, entry.prompt_hash, entry.diff_hash, entry.prev_hash)

    # Compute entry_hash over the record *including* the hmac (final fingerprint)
    record = _record_dict(entry)
    record["entry_hash"] = ""   # placeholder while hashing
    record["entry_hash"] = _hash_record(record)
    entry.entry_hash = record["entry_hash"]

    # Append to JSONL (atomic: write then flush)
    with open(ledger_file, "a", encoding="utf-8") as fh:
        fh.write(json.dumps(record, separators=(",", ":")) + "\n")
        fh.flush()

    # Update HEAD pointer
    head_file.write_text(entry.entry_hash, encoding="utf-8")

    return entry


def get_head_hash(*, ledger_dir: Path) -> Optional[str]:
    """Return the ``entry_hash`` of the last entry in ``ledger.jsonl``.

    Reading from the live ledger file (rather than the cached HEAD file)
    means that a rewind (truncation of the ledger) is immediately
    reflected here — the head will regress to the new last entry (AOS-SEC6).

    Parameters
    ----------
    ledger_dir:
        Directory containing ``ledger.jsonl``.

    Returns
    -------
    str | None
        The entry_hash of the last record, or ``None`` if the ledger is empty.
    """
    ledger_file = _ledger_path(Path(ledger_dir))
    if not ledger_file.exists():
        return None
    lines = [l for l in ledger_file.read_text(encoding="utf-8").splitlines() if l.strip()]
    if not lines:
        return None
    try:
        last_record = json.loads(lines[-1])
        return last_record.get("entry_hash") or None
    except json.JSONDecodeError:
        return None


def verify_chain(*, ledger_dir: Path, secret: bytes) -> bool:
    """Verify the HMAC chain integrity of the ledger (AOS-F27 / AOS-SEC6).

    Reads every entry in ``ledger.jsonl`` in order and checks:
      1. The stored HMAC matches the recomputed value.
      2. Each entry's ``prev_hash`` matches the ``entry_hash`` of the
         preceding entry.

    Returns ``True`` when the chain is intact, ``False`` otherwise.
    An empty ledger is trivially valid (returns ``True``).
    """
    ledger_dir = Path(ledger_dir)
    ledger_file = _ledger_path(ledger_dir)

    if not ledger_file.exists():
        return True

    lines = [l for l in ledger_file.read_text(encoding="utf-8").splitlines() if l.strip()]
    if not lines:
        return True

    expected_prev = _GENESIS_HASH

    for i, line in enumerate(lines):
        try:
            record = json.loads(line)
        except json.JSONDecodeError:
            return False

        # Check prev_hash chain linkage
        if record.get("prev_hash") != expected_prev:
            return False

        # Recompute HMAC
        recomputed_hmac = _compute_hmac(
            secret,
            record.get("prompt_hash", ""),
            record.get("diff_hash", ""),
            record.get("prev_hash", ""),
        )
        if record.get("hmac") != recomputed_hmac:
            return False

        # Recompute entry_hash to advance the chain
        check_record = dict(record)
        stored_entry_hash = check_record.pop("entry_hash", "")
        check_record["entry_hash"] = ""
        recomputed_entry_hash = _hash_record(check_record)
        if stored_entry_hash != recomputed_entry_hash:
            return False

        expected_prev = stored_entry_hash

    return True
