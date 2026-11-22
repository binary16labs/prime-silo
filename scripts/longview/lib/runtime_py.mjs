// One Python for every LONGVIEW phase that shells into the Benny runtime.
//
// Why this exists (C0, 2026-11-21): `code` and `enrich` spawned the bare
// `python` on PATH (a system 3.12 with no pydantic) while `sad` used the
// bundled runtime python that carries the benny deps. Both phases died on
// import in 0.0 min and the pipeline still printed ✓. One resolver, used by
// all three, plus a preflight that imports benny_cli before the run starts.
import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";

// Same precedence runSad always used: explicit override → bundled runtime →
// (only if no bundle exists) the PATH python, flagged so preflight says so.
export function runtimePython({ env = process.env, exists = fs.existsSync } = {}) {
  const bundle =
    env.PRIME_SILO_RUNTIME_BUNDLE ||
    path.join(
      env.APPDATA || path.join(env.USERPROFILE || "", "AppData", "Roaming"),
      "space-agent",
      "runtime-bundle"
    );
  if (env.PRIME_SILO_RUNTIME_PY)
    return { py: env.PRIME_SILO_RUNTIME_PY, bundle, source: "PRIME_SILO_RUNTIME_PY" };
  const bundled = path.join(bundle, "python", process.platform === "win32" ? "python.exe" : "bin/python3");
  if (exists(bundled)) return { py: bundled, bundle, source: "runtime-bundle" };
  return { py: "python", bundle: null, source: "PATH (no runtime bundle found)" };
}

// Env for a runtime python child: PYTHONPATH = runtime dir + the bundle's site
// packages, UTF-8 stdio (the enrich CLI prints braille glyphs that crash cp1252).
export function runtimeEnv(runtimeDir, rp, base = process.env, extra = {}) {
  const site = rp.bundle ? path.join(rp.bundle, "site") : null;
  return {
    ...base,
    PYTHONPATH: [runtimeDir, site, base.PYTHONPATH].filter(Boolean).join(path.delimiter),
    PYTHONIOENCODING: "utf-8",
    PYTHONUTF8: "1",
    ...extra
  };
}

// Preflight: can this python actually load the benny CLI? Importing it is the
// honest test — a module list would drift from what benny_cli really imports.
export function checkRuntimePython(runtimeDir, { env = process.env, spawn = spawnSync } = {}) {
  const rp = runtimePython({ env });
  const r = spawn(rp.py, ["benny_cli.py", "--help"], {
    cwd: runtimeDir,
    env: runtimeEnv(runtimeDir, rp, env),
    encoding: "utf8",
    timeout: 120000
  });
  const ok = r.status === 0;
  const err = ((r.stderr || "") + (r.error ? String(r.error) : ""))
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(-1)[0];
  return { ok, py: rp.py, source: rp.source, error: ok ? null : err || `exit ${r.status}` };
}
