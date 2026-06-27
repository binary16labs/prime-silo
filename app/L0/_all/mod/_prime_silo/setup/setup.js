// Phase 2 — Setup page (#/_prime_silo/setup).
//
// Native port of memo-ray's SetupWizard.jsx: configure where the memory graph
// scans for agent activity (Claude / Antigravity / Gemini / opencode log + config
// paths), with per-field auto-detect status, probing diagnostics, and "open in
// file manager" buttons. In memo-ray this gated first launch; here it is a
// first-class config screen reachable any time from the nav.
//
// Part of the decoupled memo-ray screen architecture (MEMORAY-MERGE.md Phase 2):
// thin Alpine view over the shared memoray-client data layer; earth-tone
// memo-ray theme via the `mray-theme` class. Read is GET /setup/status; mutations
// are POST /setup/save + POST /open-folder (both whitelisted in the shell proxy).

import {
  memorayFetch,
  readMemorayJson,
  isMemorayOffline,
  isMemorayDisabled
} from "../memoray_client/memoray-client.js";

// Field metadata — label + whether the value is a multi-path (textarea) field.
// Order matches memo-ray's wizard. Rendered generically from /setup/status.
const FIELDS = [
  { key: "CLAUDE_SESSIONS_DIR", label: "Claude Sessions Directory", isArray: false },
  { key: "CLAUDE_LOG_DIRS", label: "Claude Code Log Directories", isArray: true },
  { key: "CLAUDE_WORKTREES_PATH", label: "Claude Worktrees Track File", isArray: false },
  { key: "CLAUDE_CONFIG_PATH", label: "Claude Desktop Configuration File", isArray: false },
  { key: "ANTIGRAVITY_BRAIN_DIRS", label: "Antigravity IDE Brain Directories", isArray: true },
  { key: "GEMINI_CONFIG_DIR", label: "Gemini Agent Config Directory", isArray: false },
  { key: "OPENCODE_STORAGE_DIRS", label: "opencode Storage Directories", isArray: true },
  { key: "OPENCODE_CONFIG_PATH", label: "opencode Configuration File", isArray: false }
];

function valueToText(value) {
  if (Array.isArray(value)) return value.join("\n");
  return value || "";
}

function textToValue(text, isArray) {
  if (isArray) {
    return String(text || "")
      .split("\n")
      .map((p) => p.trim())
      .filter(Boolean);
  }
  return String(text || "").trim();
}

window.setupPage = function setupPage() {
  return {
    state: "loading", // loading | ready | offline | disabled | error
    error: "",
    fields: FIELDS,
    report: null,
    form: {},
    troubleshoot: {},
    saving: false,
    saveError: "",

    async init() {
      await this.fetchStatus();
    },

    async fetchStatus() {
      this.state = "loading";
      this.saveError = "";
      try {
        const report = await readMemorayJson(await memorayFetch("/setup/status"));
        this.report = report;
        const form = {};
        for (const { key } of FIELDS) {
          form[key] = valueToText(report.results?.[key]?.value);
        }
        this.form = form;
        this.state = "ready";
      } catch (err) {
        this.applyErrorState(err);
      }
    },

    applyErrorState(err) {
      if (isMemorayDisabled(err)) {
        this.state = "disabled";
      } else if (isMemorayOffline(err)) {
        this.state = "offline";
      } else {
        this.state = "error";
        this.error = err && err.message ? err.message : String(err);
      }
    },

    info(key) {
      return (this.report && this.report.results && this.report.results[key]) || {};
    },

    sourceBadge(source) {
      switch (source) {
        case "saved_config":
          return { label: "Saved Config", cls: "is-saved" };
        case "auto_detected":
          return { label: "Auto-Detected", cls: "is-detected" };
        default:
          return { label: "Default Guess", cls: "is-guess" };
      }
    },

    // The live, parsed list of paths for an array field (for the per-path rows).
    pathsOf(key) {
      return textToValue(this.form[key], true);
    },

    pathExists(key, p) {
      const probed = this.info(key).probed || [];
      const hit = probed.find((pr) => pr.path === p);
      return Boolean(hit && hit.exists);
    },

    toggleTroubleshoot(key) {
      this.troubleshoot[key] = !this.troubleshoot[key];
    },

    async save() {
      this.saving = true;
      this.saveError = "";
      const payload = {};
      for (const { key, isArray } of FIELDS) {
        payload[key] = textToValue(this.form[key], isArray);
      }
      try {
        const res = await readMemorayJson(
          await memorayFetch("/setup/save", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
          })
        );
        if (res && res.status === "ok") {
          await this.fetchStatus();
        } else {
          this.saveError = (res && res.error) || "Save failed.";
        }
      } catch (err) {
        this.saveError = err && err.message ? err.message : String(err);
      } finally {
        this.saving = false;
      }
    },

    async openPath(p) {
      if (!p) return;
      try {
        await readMemorayJson(
          await memorayFetch("/open-folder", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ path: p })
          })
        );
      } catch {
        // Best-effort reveal; memo-ray rejects paths it can't open.
      }
    },

    retry() {
      this.init();
    }
  };
};

export const __testing = { FIELDS, valueToText, textToValue };
