"""`benny agentamp` CLI subcommand handlers (AAMP-001 Phases 1 + 6).

Subcommands registered here:
  benny agentamp scaffold-skin <id>  [--drafts-dir D]
      Emit a deterministic unsigned draft skin under drafts_dir/<id>/ (AAMP-F33).

  benny agentamp pack <draft_dir>  --out <path.aamp>
      Zip a draft directory into a .aamp file.

  benny agentamp sign <path.aamp>
      HMAC-sign the pack in-place, writing the signature into skin.manifest.json (AAMP-SEC4).

  benny agentamp install <path.aamp>  [--workspace W]  [--dev-mode]
      Load, verify, and register a pack (AAMP-F1, AAMP-F35).

  benny agentamp enqueue <manifest.json>  [--workspace W]  [--api-base URL]
      POST a manifest to the existing /api/run endpoint (AAMP-F12).

  benny agentamp export-cockpit <out.aamp.cockpit>
      Bundle cockpit user state (active skin, knob locks, window positions)
      into a portable zip (AAMP-F19).

  benny agentamp import-cockpit <in.aamp.cockpit>
      Restore cockpit user state from a .aamp.cockpit bundle (AAMP-F19).

Feature-flag guard: ``aamp.enabled`` must be True. Callers check the flag
before dispatching to ``cmd_agentamp``; the flag is NOT re-checked here so
tests can call handlers directly.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import zipfile
from pathlib import Path
from typing import Optional


# ---------------------------------------------------------------------------
# Subparser registration (called from benny_cli.py build_parser)
# ---------------------------------------------------------------------------


def add_subparser(sub: argparse._SubParsersAction) -> None:
    p = sub.add_parser(
        "agentamp",
        help="AgentAmp skin-pack tools (scaffold, pack, sign, install)",
    )
    aa = p.add_subparsers(dest="agentamp_cmd", required=True)

    # scaffold-skin
    p_scaffold = aa.add_parser(
        "scaffold-skin",
        help="Create a deterministic unsigned draft skin directory",
    )
    p_scaffold.add_argument("skin_id", help="Skin identifier (alphanumeric + hyphens)")
    p_scaffold.add_argument(
        "--drafts-dir",
        default=None,
        help="Parent directory for drafts (default: ${BENNY_HOME}/agentamp/drafts)",
    )

    # pack
    p_pack = aa.add_parser("pack", help="Zip a draft directory into a .aamp file")
    p_pack.add_argument("draft_dir", help="Path to the draft directory")
    p_pack.add_argument("--out", required=True, help="Output path for the .aamp file")

    # sign
    p_sign = aa.add_parser("sign", help="HMAC-sign a .aamp pack in-place")
    p_sign.add_argument("pack_path", help="Path to the .aamp file to sign")

    # install
    p_install = aa.add_parser("install", help="Verify and install a .aamp pack")
    p_install.add_argument("pack_path", help="Path to the .aamp file to install")
    p_install.add_argument("--workspace", default="default")
    p_install.add_argument(
        "--dev-mode",
        action="store_true",
        default=False,
        help="Skip signature check (for local development only; blocked at release)",
    )

    # enqueue (AAMP-F12)
    p_enqueue = aa.add_parser(
        "enqueue",
        help="POST a manifest to the /api/run endpoint (AAMP-F12)",
    )
    p_enqueue.add_argument(
        "manifest_path",
        help="Path to the manifest JSON file to enqueue",
    )
    p_enqueue.add_argument("--workspace", default="default")
    p_enqueue.add_argument(
        "--api-base",
        default="http://localhost:8000",
        help="Base URL of the Benny API (default: http://localhost:8000)",
    )
    p_enqueue.add_argument(
        "--api-key",
        default="benny-mesh-2026-auth",
        help="API key for X-Benny-API-Key header",
    )

    # export-cockpit (AAMP-F19)
    p_export = aa.add_parser(
        "export-cockpit",
        help="Bundle cockpit state into a portable .aamp.cockpit file (AAMP-F19)",
    )
    p_export.add_argument(
        "out_path",
        help="Output path for the .aamp.cockpit bundle",
    )

    # import-cockpit (AAMP-F19)
    p_import = aa.add_parser(
        "import-cockpit",
        help="Restore cockpit state from a .aamp.cockpit bundle (AAMP-F19)",
    )
    p_import.add_argument(
        "in_path",
        help="Path to the .aamp.cockpit file to import",
    )


# ---------------------------------------------------------------------------
# Command handlers
# ---------------------------------------------------------------------------


def cmd_agentamp(args: argparse.Namespace) -> int:
    cmd = args.agentamp_cmd
    if cmd == "scaffold-skin":
        return _scaffold(args)
    if cmd == "pack":
        return _pack(args)
    if cmd == "sign":
        return _sign(args)
    if cmd == "install":
        return _install(args)
    if cmd == "enqueue":
        return _enqueue(args)
    if cmd == "export-cockpit":
        return _export_cockpit(args)
    if cmd == "import-cockpit":
        return _import_cockpit(args)
    print(f"[agentamp] unknown subcommand: {cmd!r}", file=sys.stderr)
    return 1


# ---------------------------------------------------------------------------
# scaffold-skin
# ---------------------------------------------------------------------------


def _scaffold(args: argparse.Namespace) -> int:
    from .scaffold import scaffold_skin

    try:
        root = scaffold_skin(args.skin_id, drafts_dir=args.drafts_dir)
    except ValueError as exc:
        print(f"[agentamp scaffold-skin] error: {exc}", file=sys.stderr)
        return 1

    print(f"[agentamp] draft created: {root}")
    print(f"  skin.manifest.json  (signature: null — sign before installing)")
    print(f"  shaders/post_glow.frag.glsl")
    print(f"")
    print(f"Next:")
    print(f"  benny agentamp pack {root} --out {args.skin_id}.aamp")
    print(f"  benny agentamp sign {args.skin_id}.aamp")
    print(f"  benny agentamp install {args.skin_id}.aamp")
    return 0


# ---------------------------------------------------------------------------
# pack
# ---------------------------------------------------------------------------


def _pack(args: argparse.Namespace) -> int:
    draft_dir = Path(args.draft_dir)
    out_path = Path(args.out)

    if not draft_dir.is_dir():
        print(f"[agentamp pack] not a directory: {draft_dir}", file=sys.stderr)
        return 1

    manifest_path = draft_dir / "skin.manifest.json"
    if not manifest_path.exists():
        print(
            f"[agentamp pack] skin.manifest.json not found in {draft_dir}",
            file=sys.stderr,
        )
        return 1

    out_path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(out_path, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for file in sorted(draft_dir.rglob("*")):
            if file.is_file():
                arcname = file.relative_to(draft_dir).as_posix()
                zf.write(file, arcname)

    print(f"[agentamp] packed: {out_path}  ({out_path.stat().st_size} bytes)")
    return 0


# ---------------------------------------------------------------------------
# sign
# ---------------------------------------------------------------------------


def _sign(args: argparse.Namespace) -> int:
    from .signing import sign_skin_pack

    pack_path = Path(args.pack_path)
    if not pack_path.exists():
        print(f"[agentamp sign] file not found: {pack_path}", file=sys.stderr)
        return 1

    # Read manifest from zip
    try:
        with zipfile.ZipFile(pack_path, "r") as zf:
            raw = zf.read("skin.manifest.json").decode("utf-8")
    except KeyError:
        print(
            f"[agentamp sign] skin.manifest.json not found in {pack_path}",
            file=sys.stderr,
        )
        return 1
    except Exception as exc:
        print(f"[agentamp sign] could not open pack: {exc}", file=sys.stderr)
        return 1

    # Compute signature
    sig = sign_skin_pack(raw)
    manifest_data = json.loads(raw)
    manifest_data["signature"] = sig.model_dump(mode="json")
    signed_raw = json.dumps(manifest_data, indent=2, ensure_ascii=False)

    # Rewrite the zip with updated manifest (copy all other entries)
    tmp_path = pack_path.with_suffix(".aamp.tmp")
    try:
        with zipfile.ZipFile(pack_path, "r") as src_zf:
            with zipfile.ZipFile(tmp_path, "w", compression=zipfile.ZIP_DEFLATED) as dst_zf:
                for info in src_zf.infolist():
                    if info.filename == "skin.manifest.json":
                        dst_zf.writestr(info, signed_raw.encode("utf-8"))
                    else:
                        dst_zf.writestr(info, src_zf.read(info.filename))
        tmp_path.replace(pack_path)
    except Exception as exc:
        tmp_path.unlink(missing_ok=True)
        print(f"[agentamp sign] failed to rewrite pack: {exc}", file=sys.stderr)
        return 1

    print(f"[agentamp] signed: {pack_path}")
    print(f"  algorithm: {sig.algorithm}")
    print(f"  signed_at: {sig.signed_at}")
    return 0


# ---------------------------------------------------------------------------
# install
# ---------------------------------------------------------------------------


def _install(args: argparse.Namespace) -> int:
    from .skin import load, SkinSignatureMissing, SkinSignatureInvalid, SkinPathEscape

    pack_path = Path(args.pack_path)
    dev_mode: bool = getattr(args, "dev_mode", False)

    try:
        manifest, zf = load(pack_path, dev_mode=dev_mode)
        zf.close()
    except SkinSignatureMissing as exc:
        print(f"[agentamp install] REJECTED — {exc}", file=sys.stderr)
        return 2
    except SkinSignatureInvalid as exc:
        print(f"[agentamp install] REJECTED — {exc}", file=sys.stderr)
        return 2
    except SkinPathEscape as exc:
        print(f"[agentamp install] REJECTED (path traversal) — {exc}", file=sys.stderr)
        return 2
    except FileNotFoundError as exc:
        print(f"[agentamp install] error — {exc}", file=sys.stderr)
        return 1
    except Exception as exc:
        print(f"[agentamp install] error — {exc}", file=sys.stderr)
        return 1

    # Register in local registry under $BENNY_HOME/agentamp/registry/<skin_id>/
    benny_home = os.environ.get("BENNY_HOME", ".")
    registry_dir = Path(benny_home) / "agentamp" / "registry" / manifest.id
    registry_dir.mkdir(parents=True, exist_ok=True)

    # Copy pack into registry
    import shutil
    dest = registry_dir / pack_path.name
    shutil.copy2(pack_path, dest)

    # Write install receipt
    receipt_path = registry_dir / "install.json"
    receipt_path.write_text(
        json.dumps(
            {
                "skin_id": manifest.id,
                "pack": str(pack_path),
                "schema_version": manifest.schema_version,
                "dev_mode": dev_mode,
                "workspace": args.workspace,
            },
            indent=2,
        ),
        encoding="utf-8",
    )

    print(f"[agentamp] installed: {manifest.id}  →  {registry_dir}")
    return 0


# ---------------------------------------------------------------------------
# enqueue (AAMP-F12)
# ---------------------------------------------------------------------------


def _enqueue(args: argparse.Namespace) -> int:
    """POST a manifest file to the Benny /api/run endpoint (AAMP-F12)."""
    from .playlist import enqueue_manifest

    manifest_path = Path(args.manifest_path)
    if not manifest_path.exists():
        print(f"[agentamp enqueue] file not found: {manifest_path}", file=sys.stderr)
        return 1

    try:
        manifest_dict = json.loads(manifest_path.read_text(encoding="utf-8"))
    except Exception as exc:
        print(f"[agentamp enqueue] could not parse manifest: {exc}", file=sys.stderr)
        return 1

    try:
        run_id = enqueue_manifest(
            manifest_dict,
            workspace=args.workspace,
            api_base=args.api_base,
            api_key=args.api_key,
        )
    except Exception as exc:
        print(f"[agentamp enqueue] failed: {exc}", file=sys.stderr)
        return 1

    print(f"[agentamp] enqueued: run_id={run_id}")
    return 0


# ---------------------------------------------------------------------------
# export-cockpit (AAMP-F19)
# ---------------------------------------------------------------------------


def _export_cockpit(args: argparse.Namespace) -> int:
    """Bundle cockpit state into a .aamp.cockpit zip (AAMP-F19)."""
    from .user_state import export_cockpit

    out_path = Path(args.out_path)
    benny_home = Path(os.environ.get("BENNY_HOME", Path.home() / ".benny"))

    try:
        export_cockpit(out_path, benny_home)
    except Exception as exc:
        print(f"[agentamp export-cockpit] failed: {exc}", file=sys.stderr)
        return 1

    print(f"[agentamp] cockpit exported: {out_path}  ({out_path.stat().st_size} bytes)")
    print("  Contains: cockpit.json, eq.json, bundle.json")
    print(f"\nTo restore on another host:")
    print(f"  benny agentamp import-cockpit {out_path}")
    return 0


# ---------------------------------------------------------------------------
# import-cockpit (AAMP-F19)
# ---------------------------------------------------------------------------


def _import_cockpit(args: argparse.Namespace) -> int:
    """Restore cockpit state from a .aamp.cockpit bundle (AAMP-F19)."""
    from .user_state import import_cockpit

    in_path = Path(args.in_path)
    benny_home = Path(os.environ.get("BENNY_HOME", Path.home() / ".benny"))

    try:
        state = import_cockpit(in_path, benny_home)
    except FileNotFoundError as exc:
        print(f"[agentamp import-cockpit] {exc}", file=sys.stderr)
        return 1
    except Exception as exc:
        print(f"[agentamp import-cockpit] failed: {exc}", file=sys.stderr)
        return 1

    print(f"[agentamp] cockpit restored from: {in_path}")
    print(f"  Active skin: {state.active_skin_id}")
    print(f"  Knob locks:  {len(state.knob_locks)} path(s)")
    print(f"  Windows:     {len(state.window_positions)} position(s)")
    return 0
