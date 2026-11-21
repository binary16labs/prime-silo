// Provenance for LONGVIEW cards (2026-11-21): which MACHINE a session came from, which
// PROMPTS made its card, and one entity per real session.
//
// Every machine uses the same `C:\Users\nsdha\...` paths, and memo-ray ids a Claude session
// by the hash of its file path, so the same session imported from two copies (an old July
// pull and today's satellite merge) becomes two entities. These helpers are pure so the
// rules are testable; the IO wrappers at the bottom read the hub's provenance map.
import fs from "fs";
import path from "path";
import crypto from "crypto";

/** The real session id behind a memo-ray Session entity (machine-independent). */
export function sessionKey(entity) {
  const md = entity?.metadata || {};
  if (entity?.agent === "Antigravity" && md.sessionPath)
    return path.basename(String(md.sessionPath).replace(/[\\/]+$/, "")).toLowerCase();
  if (md.filePath) {
    const base = path.basename(String(md.filePath)).replace(/\.jsonl$/i, "");
    // <uuid>.jsonl and subagent agent-<hex>.jsonl names ARE the session id. Generic names
    // (Claude Desktop's audit.jsonl) are not — use the logged session id, else the entity.
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(base) || /^agent-[0-9a-f]+$/i.test(base)) return base;
    return md.logSessionId ? String(md.logSessionId) : entity?.id || null;
  }
  if (md.logSessionId) return String(md.logSessionId);
  return entity?.id || null;
}

/**
 * Collapse entities that are copies of the same session. Keeps the most complete copy
 * (most events, then the one already carded, then latest timestamp, then lowest id —
 * deterministic). If ANY copy is
 * quarantined the whole group is held back, so a duplicate can never re-admit a
 * quarantined session under a fresh id.
 */
export function dedupeSessions(sessions, quarantined = new Set(), hasCard = () => false) {
  const groups = new Map();
  for (const s of sessions) {
    const k = `${s.agent}|${sessionKey(s) ?? s.id}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(s);
  }
  const keep = [];
  const dropped = []; // { id, kept, reason }
  for (const g of groups.values()) {
    if (g.length > 1 && g.some((s) => quarantined.has(s.id))) {
      for (const s of g)
        if (!quarantined.has(s.id)) dropped.push({ id: s.id, kept: null, reason: "copy_of_quarantined" });
      continue; // the quarantined id itself is filtered later as usual
    }
    g.sort(
      (a, b) =>
        (b.children_ids || []).length - (a.children_ids || []).length ||
        // equal content: keep the copy that already has a card (no needless re-carding)
        Number(hasCard(b.id)) - Number(hasCard(a.id)) ||
        (b.timestamp || 0) - (a.timestamp || 0) ||
        String(a.id).localeCompare(String(b.id))
    );
    keep.push(g[0]);
    for (const s of g.slice(1)) dropped.push({ id: s.id, kept: g[0].id, reason: "duplicate_copy" });
  }
  return { keep, dropped };
}

/**
 * Which machine a session came from. The hub's provenance map (built from the backup
 * copies by estate_satellite_merge.mjs) is authoritative; a transcript that still exists
 * on THIS machine is this machine's; anything else is "unknown" — never guessed.
 */
export function hostOf(entity, prov, { localHost, localExists = () => false } = {}) {
  const k = sessionKey(entity);
  if (k && prov?.keys?.[k]) return prov.keys[k];
  const p = entity?.metadata?.filePath || entity?.metadata?.sessionPath;
  if (p && localExists(p)) return localHost || "local";
  return "unknown";
}

/** Short content hash of a prompts folder: changes whenever any prompt changes. */
export function promptVersion(dir) {
  const h = crypto.createHash("sha1");
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
  } catch {
    return null;
  }
  for (const f of files) {
    h.update(f + "\0");
    h.update(fs.readFileSync(path.join(dir, f), "utf8").replace(/\r\n/g, "\n"));
    h.update("\0");
  }
  return `prompts@${h.digest("hex").slice(0, 12)}`;
}

/** The hub's provenance map, or an empty one when the backup drive isn't attached. */
export function loadProvenance(root = process.env.ESTATE_BACKUP_ROOT || "F:\\backups") {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, "provenance.json"), "utf8"));
  } catch {
    return { keys: {}, counts: {}, missing: true };
  }
}
