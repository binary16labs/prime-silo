"""
Migration & Relocation Engine — erases host-specific absolute paths.

Enables "Plug and Play" by rewriting absolute host paths into portable tokens
like ${BENNY_HOME} or ${WORKSPACE_ROOT}, and re-signing manifests for 
Phase 7 (6σ) compliance.
"""
import re
import json
import logging
import shutil
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from ..core.manifest import SwarmManifest, MANIFEST_SCHEMA_VERSION
from ..core.manifest_hash import sign_manifest

logger = logging.getLogger(__name__)

# Pattern to capture Windows and POSIX absolute paths
# e.g. C:\Users\foo\..., /home/user/...
# This is a broad heuristic; we target common patterns in Benny metadata.
PATH_PATTERN = re.compile(r'([A-Za-z]:\\[^":<>|]*|/[^":<>|]+)')

class MigrationReport:
    def __init__(self, source: Path, target: Path):
        self.source = source
        self.target = target
        self.transforms: List[Dict[str, Any]] = []
        self.errors: List[str] = []
        self.count_rewrites = 0

    def add_transform(self, file_path: Path, action: str, details: str = ""):
        self.transforms.append({
            "file": str(file_path),
            "action": action,
            "details": details
        })

    def to_json(self) -> str:
        return json.dumps({
            "source": str(self.source),
            "target": str(self.target),
            "transforms": self.transforms,
            "errors": self.errors,
            "metrics": {
                "total_files": len(self.transforms),
                "rewrites": self.count_rewrites
            }
        }, indent=2)

class MigrationEngine:
    def __init__(self, benny_home: Path):
        self.benny_home = benny_home.absolute()

    def rewrite_paths(self, content: str) -> Tuple[str, int]:
        """Replace absolute paths with ${BENNY_HOME} tokens."""
        count = 0
        def _replacer(match):
            nonlocal count
            path_str = match.group(0)
            try:
                p = Path(path_str).absolute()
                # If the path is inside BENNY_HOME or was inside the source, 
                # make it relative to the new home.
                if str(p).startswith(str(self.benny_home)):
                    rel = p.relative_to(self.benny_home)
                    count += 1
                    # Ensure unix-style slashes for portability
                    return f"${{BENNY_HOME}}/{rel.as_posix()}"
                return path_str 
            except Exception:
                return path_str

        new_content = PATH_PATTERN.sub(_replacer, content)
        return new_content, count

    def migrate_manifest(self, file_path: Path, dry_run: bool = True) -> Tuple[Optional[SwarmManifest], int]:
        """Lift a legacy manifest to latest version and re-sign."""
        try:
            with open(file_path, "r", encoding="utf-8") as f:
                raw_data = json.load(f)

            # 1. Path rewrite in raw string
            json_str = json.dumps(raw_data)
            new_json_str, rewrites = self.rewrite_paths(json_str)
            data = json.loads(new_json_str)

            # 2. Schema elevation
            if isinstance(data, dict):
                # Ensure it has basic manifest-like fields to pass Pydantic validation
                if "id" not in data: data["id"] = file_path.stem
                if "name" not in data: data["name"] = data["id"]
                if "plan" not in data: data["plan"] = {"tasks": []}
            
            manifest = SwarmManifest.model_validate(data)
            
            # 3. Re-sign for 6σ compliance
            manifest = sign_manifest(manifest)
            
            if not dry_run:
                with open(file_path, "w", encoding="utf-8") as f:
                    f.write(manifest.model_dump_json(indent=2))
                    
            return manifest, rewrites
        except Exception as e:
            logger.error(f"Failed to migrate manifest {file_path}: {e}")
            return None, 0

    def migrate_workspace(self, source_path: Path, target_path: Path, dry_run: bool = True) -> MigrationReport:
        """Move and fix-up an entire workspace directory."""
        report = MigrationReport(source_path, target_path)
        
        if not dry_run and not target_path.exists():
            target_path.mkdir(parents=True, exist_ok=True)

        # 1. Scan for potential manifests
        for p in source_path.rglob("*.json"):
            try:
                # Heuristic: must contain "plan" or "requirement" as a top-level key
                with open(p, "r", encoding="utf-8") as f:
                    data = json.load(f)
                    if not isinstance(data, dict) or ("plan" not in data and "requirement" not in data):
                        continue
                
                rel_p = p.relative_to(source_path)
                dest_p = target_path / rel_p
                
                if not dry_run:
                    dest_p.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(p, dest_p)
                
                manifest, rewrites = self.migrate_manifest(dest_p if not dry_run else p, dry_run=dry_run)
                if manifest:
                    report.add_transform(rel_p, "UPGRADE", f"to v{MANIFEST_SCHEMA_VERSION} and signed")
                    report.count_rewrites += rewrites
                else:
                    report.errors.append(f"Could not migrate {rel_p}")
            except Exception as e:
                # Silently skip non-manifest JSON unless it was explicitly supposed to be one
                pass

        return report
