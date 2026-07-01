// GET /api/home — the resolved Prime-Silo home, with provenance.
//
// One declared home (PRIME_SILO_HOME env > homeDir in prime-silo-config.json
// > per-user default) with customware/ and benny/ derived under it. This
// endpoint is the introspection surface the UI, agents, and `benny doctor`
// counterparts read instead of guessing from env vars: it reports both what
// the resolver declares AND what this server process is actually using for
// customware, flagging divergence between the two.
//
// Read-only and secret-free: paths and provenance only.

import path from "node:path";

// Shared CJS resolver (packaging/ is CommonJS; default-import interop).
import homeResolver from "../../packaging/desktop/home_resolver.js";

export const allowAnonymous = false;

function activeCustomwarePath(context) {
  const params = context.runtimeParams;
  if (params && typeof params.get === "function") {
    return String(params.get("CUSTOMWARE_PATH", "") || "").trim();
  }
  return String(process.env.CUSTOMWARE_PATH || "").trim();
}

export function get(context) {
  const resolved = homeResolver.resolveHome();
  const active = activeCustomwarePath(context);
  const warnings = [...resolved.warnings];

  if (active && path.resolve(active) !== path.resolve(resolved.customwarePath)) {
    warnings.push(
      `This server is using CUSTOMWARE_PATH=${active}, which differs from the ` +
        `resolved home's customware (${resolved.customwarePath}).`
    );
  }

  return {
    headers: { "Cache-Control": "no-store" },
    status: 200,
    body: {
      format: "prime-silo.home/1",
      root: resolved.root,
      source: resolved.source,
      bennyHome: resolved.bennyHome,
      bennyHomeSource: resolved.bennyHomeSource,
      customwarePath: resolved.customwarePath,
      customwareSource: resolved.customwareSource,
      activeCustomwarePath: active || null,
      configPath: resolved.configPath,
      warnings
    }
  };
}
