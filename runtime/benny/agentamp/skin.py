"""AAMP-001 Phase 1 — Skin-pack loader (AAMP-F1, AAMP-F35, AAMP-SEC3).

Public API
----------
  load(path, *, dev_mode=False) -> tuple[SkinManifest, ZipFile]
      Open a ``.aamp`` zip, validate it, and return the parsed manifest
      together with the open archive (caller is responsible for closing it,
      e.g. via a ``with`` statement).

      Raises
      ------
      SkinPathEscape        A zip member name contains a path-traversal sequence (AAMP-SEC3).
      SkinSignatureMissing  The manifest ``signature`` field is ``None`` and ``dev_mode`` is False (AAMP-F35).
      SkinSignatureInvalid  The manifest ``signature`` does not verify under HMAC (AAMP-F35).
      FileNotFoundError     ``skin.manifest.json`` is absent from the zip.
      ValueError            The manifest JSON does not parse as a valid :class:`SkinManifest`.
"""

from __future__ import annotations

import json
import os
import re
import zipfile
from pathlib import PurePosixPath
from typing import Tuple

from .contracts import SkinManifest
from .signing import verify_skin_pack


# ---------------------------------------------------------------------------
# Exceptions
# ---------------------------------------------------------------------------


class SkinPathEscape(ValueError):
    """A zip member name contains a path-traversal sequence (AAMP-SEC3)."""


class SkinSignatureMissing(ValueError):
    """The skin manifest has no signature and dev_mode is False (AAMP-F35)."""


class SkinSignatureInvalid(ValueError):
    """The skin manifest signature does not verify (AAMP-F35)."""


# ---------------------------------------------------------------------------
# Path-traversal guard (AAMP-SEC3)
# ---------------------------------------------------------------------------

_TRAVERSAL_RE = re.compile(r"\.\.[/\\]|\.\.$|^\.\.$|^[A-Za-z]:[/\\]|^//|^\\\\")


def _check_member(name: str) -> None:
    """Raise :exc:`SkinPathEscape` if *name* could escape the zip root."""
    if _TRAVERSAL_RE.search(name):
        raise SkinPathEscape(
            f"zip member {name!r} contains a path-traversal sequence — pack rejected"
        )
    # Absolute POSIX paths
    if PurePosixPath(name).is_absolute():
        raise SkinPathEscape(
            f"zip member {name!r} is an absolute path — pack rejected"
        )


# ---------------------------------------------------------------------------
# Loader
# ---------------------------------------------------------------------------

_MANIFEST_ENTRY = "skin.manifest.json"


def load(
    path: os.PathLike | str,
    *,
    dev_mode: bool = False,
) -> Tuple[SkinManifest, zipfile.ZipFile]:
    """Open *path* as a ``.aamp`` zip, validate it, and return ``(manifest, zf)``.

    Parameters
    ----------
    path:
        Filesystem path to the ``.aamp`` file.
    dev_mode:
        When ``True``, signature verification is skipped.  MUST be ``False``
        in production (AAMP-F1, GATE-AAMP-DEVMODE-1).

    Returns
    -------
    (SkinManifest, zipfile.ZipFile)
        The caller owns the ZipFile and must close it (e.g. ``with load(...) as (m, zf):``).
    """
    zf = zipfile.ZipFile(path, "r")
    try:
        # 1. Path-traversal guard over all member names (AAMP-SEC3)
        for info in zf.infolist():
            _check_member(info.filename)

        # 2. Read manifest
        try:
            raw = zf.read(_MANIFEST_ENTRY).decode("utf-8")
        except KeyError:
            zf.close()
            raise FileNotFoundError(
                f"{_MANIFEST_ENTRY!r} not found in {path!r}"
            )

        # 3. Parse manifest
        try:
            manifest = SkinManifest.model_validate(json.loads(raw))
        except Exception as exc:
            zf.close()
            raise ValueError(f"skin manifest parse error in {path!r}: {exc}") from exc

        # 4. Signature check (AAMP-F1, AAMP-F35)
        if not dev_mode:
            if manifest.signature is None:
                zf.close()
                raise SkinSignatureMissing(
                    f"skin pack {path!r} has no signature — "
                    "sign with 'benny agentamp sign <pack.aamp>' before installing"
                )
            if not verify_skin_pack(raw, manifest.signature):
                zf.close()
                raise SkinSignatureInvalid(
                    f"skin pack {path!r} signature verification failed — "
                    "pack may be tampered or signed with a different key"
                )

    except (SkinPathEscape, SkinSignatureMissing, SkinSignatureInvalid, FileNotFoundError, ValueError):
        raise
    except Exception:
        zf.close()
        raise

    return manifest, zf
