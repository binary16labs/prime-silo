#!/usr/bin/env node
// Configure open-notebook's model roles from openstudio-models.config.json.
//
// Idempotent: re-run any time after editing the config to change models/roles.
// Upserts provider credentials + model registrations, then sets the 7 role
// defaults (chat / transformation / large-context / embedding / tools / TTS / STT).
//
// open-notebook runs inside Docker, so the config points host tools at
// host.docker.internal. No external deps (Node global fetch).
//
// Usage:  node configure-open-notebook-models.mjs [--config <path>] [--no-test]

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const cfgPath = (() => {
  const i = argv.indexOf("--config");
  return i >= 0 ? argv[i + 1] : path.join(__dirname, "openstudio-models.config.json");
})();
const NO_TEST = argv.includes("--no-test");

const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
const BASE = (cfg.openNotebookUrl || "http://localhost:5055").replace(/\/+$/, "");

async function api(method, p, body) {
  const res = await fetch(`${BASE}${p}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { ok: res.ok, status: res.status, data };
}

function pickArray(d) {
  return Array.isArray(d)
    ? d
    : d && Array.isArray(d.value)
      ? d.value
      : d && Array.isArray(d.items)
        ? d.items
        : [];
}

async function upsertCredential(key, pcfg, existing) {
  const found = existing.find((c) => c.name === pcfg.credentialName);
  if (found) {
    console.log(`[cfg] credential "${pcfg.credentialName}" exists (${found.id})`);
    return found.id;
  }
  const body = {
    name: pcfg.credentialName,
    provider: pcfg.provider,
    modalities: pcfg.modalities || ["language"],
    api_key: pcfg.apiKey || "local",
    base_url: pcfg.baseUrl
  };
  const r = await api("POST", "/api/credentials", body);
  if (!r.ok) {
    console.error(
      `[cfg] FAILED to create credential "${pcfg.credentialName}": ${r.status} ${JSON.stringify(r.data)}`
    );
    return null;
  }
  const id = r.data?.id || r.data?.credential?.id;
  console.log(`[cfg] created credential "${pcfg.credentialName}" (${id}) -> ${pcfg.baseUrl}`);
  return id;
}

async function upsertModel(m, providerType, credentialId, existing) {
  const found = existing.find(
    (x) => x.name === m.name && (x.credential === credentialId || x.provider === providerType)
  );
  if (found) {
    console.log(`[cfg] model "${m.name}" (${m.type}) exists (${found.id})`);
    return found.id;
  }
  const body = { name: m.name, provider: providerType, type: m.type, credential: credentialId };
  const r = await api("POST", "/api/models", body);
  if (!r.ok) {
    console.error(
      `[cfg] FAILED to register model "${m.name}": ${r.status} ${JSON.stringify(r.data)}`
    );
    return null;
  }
  const id = r.data?.id || r.data?.model?.id;
  console.log(`[cfg] registered model "${m.name}" (${m.type}) -> ${id}`);
  return id;
}

async function main() {
  console.log(`[cfg] open-notebook: ${BASE}`);
  const health = await api("GET", "/health");
  if (!health.ok) {
    console.error(
      `[cfg] open-notebook not reachable at ${BASE}. Start it: docker compose -f C:\\Users\\nsdha\\docker-compose.yml up -d`
    );
    process.exit(3);
  }

  // 1. Credentials (one per provider alias)
  const existingCreds = pickArray((await api("GET", "/api/credentials")).data);
  const credId = {};
  for (const [key, pcfg] of Object.entries(cfg.providers)) {
    credId[key] = await upsertCredential(key, pcfg, existingCreds);
  }

  // 2. Models
  const existingModels = pickArray((await api("GET", "/api/models")).data);
  const modelId = {}; // "providerAlias::name" -> open-notebook model id
  for (const m of cfg.models) {
    const pcfg = cfg.providers[m.provider];
    if (!pcfg) {
      console.error(`[cfg] model references unknown provider "${m.provider}"`);
      continue;
    }
    const cid = credId[m.provider];
    if (!cid) {
      console.error(`[cfg] skipping model "${m.name}" — no credential for "${m.provider}"`);
      continue;
    }
    const id = await upsertModel(m, pcfg.provider, cid, existingModels);
    if (id) modelId[`${m.provider}::${m.name}`] = id;
  }

  // 3. Defaults (the 7 roles)
  const defaults = {};
  for (const [role, ref] of Object.entries(cfg.roles)) {
    const id = modelId[`${ref.provider}::${ref.name}`];
    if (id) defaults[role] = id;
    else
      console.warn(
        `[cfg] role ${role}: model ${ref.provider}/${ref.name} not registered — left unset`
      );
  }
  if (Object.keys(defaults).length) {
    const r = await api("PUT", "/api/models/defaults", defaults);
    console.log(
      r.ok
        ? `[cfg] defaults set: ${Object.keys(defaults).join(", ")}`
        : `[cfg] FAILED to set defaults: ${r.status} ${JSON.stringify(r.data)}`
    );
  }

  // 4. Connectivity test for the RAG-critical roles (chat + embedding)
  if (!NO_TEST) {
    for (const role of ["default_chat_model", "default_embedding_model"]) {
      const id = defaults[role];
      if (!id) continue;
      const r = await api("POST", `/api/models/${encodeURIComponent(id)}/test`);
      const ok = r.ok && r.data?.success !== false;
      console.log(
        `[cfg] test ${role}: ${ok ? "OK" : "FAILED"}${r.ok ? "" : ` (${r.status})`} ${r.data ? JSON.stringify(r.data).slice(0, 200) : ""}`
      );
    }
  }

  console.log("[cfg] done. Open the UI at http://localhost:8502 → Settings → Models to confirm.");
}

main().catch((e) => {
  console.error("[cfg] FAILED:", e.message);
  process.exit(1);
});
