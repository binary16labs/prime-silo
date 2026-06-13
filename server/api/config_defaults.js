// Workspace configuration defaults — the read side of the wizard manifest.
//
// The configuration wizard (site/) generates `prime-silo.config.json` at the
// repo root. This endpoint surfaces the *model* block of that manifest so the
// onscreen agent can seed its first-run settings from it instead of falling
// back to hard-coded cloud defaults. The operator configures once, in the
// wizard; every fresh agent profile inherits it.
//
// Sanitisation contract: this endpoint NEVER returns secret material. The
// wizard manifest itself stores no secrets (cloud mode records only the NAME
// of the env var that holds the key), and on top of that this route
// whitelists the exact fields it forwards.

import fs from "node:fs/promises";
import path from "node:path";

export const allowAnonymous = true;

const CONFIG_MANIFEST_FILENAME = "prime-silo.config.json";

function sanitizeModelBlock(model) {
  if (!model || typeof model !== "object") {
    return null;
  }

  const endpoint = String(model.endpoint || "").trim();
  const modelName = String(model.model || "").trim();

  if (!endpoint || !modelName) {
    return null;
  }

  const sanitized = {
    endpoint,
    model: modelName,
    mode: model.mode === "cloud" ? "cloud" : "local"
  };

  const apiKeyEnvVar = String(model.api_key_env_var || "").trim();
  if (apiKeyEnvVar) {
    sanitized.api_key_env_var = apiKeyEnvVar;
  }

  return sanitized;
}

// Phase M1 — Memo-Ray block. Same whitelist contract as the model block:
// only the two declared knobs are forwarded, never anything else that may
// land in the manifest later. base_url is a localhost service address, not
// secret material.
function sanitizeMemorayBlock(memoray) {
  if (!memoray || typeof memoray !== "object") {
    return null;
  }

  const sanitized = {
    enabled: memoray.enabled !== false
  };

  const baseUrl = String(memoray.base_url || "").trim();
  if (baseUrl) {
    sanitized.base_url = baseUrl;
  }

  return sanitized;
}

export async function get(context) {
  const manifestPath = path.join(context.projectRoot, CONFIG_MANIFEST_FILENAME);

  let raw;
  try {
    raw = await fs.readFile(manifestPath, "utf8");
  } catch {
    return {
      headers: { "Cache-Control": "no-store" },
      status: 200,
      body: { found: false }
    };
  }

  let manifest;
  try {
    manifest = JSON.parse(raw);
  } catch {
    return {
      headers: { "Cache-Control": "no-store" },
      status: 200,
      body: { found: false, error: "config manifest is not valid JSON" }
    };
  }

  const model = sanitizeModelBlock(manifest?.model);
  const memoray = sanitizeMemorayBlock(manifest?.memoray);

  if (!model) {
    return {
      headers: { "Cache-Control": "no-store" },
      status: 200,
      body: memoray ? { found: false, memoray } : { found: false }
    };
  }

  return {
    headers: { "Cache-Control": "no-store" },
    status: 200,
    body: {
      found: true,
      schema: String(manifest.schema || ""),
      model,
      ...(memoray ? { memoray } : {})
    }
  };
}
