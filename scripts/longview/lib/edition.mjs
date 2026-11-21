// Edition manifest (2026-11-21) — every book/SAD run says exactly what it is.
//
// "Which is the latest?" kept being answered from folder names ("v5" was the workspace,
// not the book; "gemma12b" out-ranked "v5" on its digits). An edition now carries a
// MANIFEST.json beside its files — METHOD (the generator: TOGAF EPIC V7, AI Vampire V2)
// separate from EDITION (this run: date + machines) — and data_out/LATEST.json names
// the current edition of each deliverable. A later audit edition (another model) sits
// beside it with the same inputs block, so the two compare directly.
import fs from "fs";
import path from "path";
import crypto from "crypto";

export const METHODS = {
  sad: { id: "togaf_epic_v7", label: "TOGAF EPIC V7 SAD" },
  book: { id: "ai_vampire_v2", label: "The AI Vampire — V2 method" }
};

const tally = (xs, f) => {
  const o = {};
  for (const x of xs) {
    const k = f(x);
    o[k] = (o[k] || 0) + 1;
  }
  return o;
};

/** Pure: the manifest body from what the run used and produced. */
export function buildEditionManifest({
  edition,
  generated,
  release,
  agent,
  items,
  cardMeta,
  promptVersion,
  produced,
  files
}) {
  const carded = items.filter((i) => cardMeta.has(i.id));
  const metas = carded.map((i) => cardMeta.get(i.id));
  return {
    schema: "longview.edition/1",
    edition,
    generated,
    methods: Object.fromEntries(produced.map((k) => [k, METHODS[k]])),
    code: {
      tag: release?.tag ?? null,
      commit: release?.commit ?? null,
      head: release?.head ?? null,
      dirty: Boolean(release?.dirty)
    },
    model: { generation: agent?.model ?? null, ingest: agent?.ingest_model ?? null, embed: agent?.embed_model ?? null },
    prompts: {
      current: promptVersion,
      // Older cards predate the field: shown as "unrecorded", never back-filled.
      on_cards: tally(metas, (m) => m.prompt_version || "unrecorded")
    },
    inputs: {
      sessions_or_episodes: items.length,
      carded: carded.length,
      by_machine_agent: tally(carded, (i) => `${i.host || "unknown"}/${i.agent}`),
      card_models: tally(metas, (m) => m.model || "unrecorded")
    },
    files
  };
}

const sha256 = (p) => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");

/**
 * IO: copy this run's SAD into the edition folder (the SAD generator writes a fixed
 * name in data_out and would otherwise be overwritten next run), write MANIFEST.json,
 * and point data_out/LATEST.json at it. Returns the manifest.
 */
export function writeEdition({ dataOut, opusDir, produced, inventory, cardsDir, ...rest }) {
  const editionDir = path.join(dataOut, ...opusDir.split("/"));
  fs.mkdirSync(editionDir, { recursive: true });
  if (produced.includes("sad"))
    for (const ext of ["pdf", "md"]) {
      const src = path.join(dataOut, `TOGAF_EPIC_V7_SAD_binary16.${ext}`);
      if (fs.existsSync(src)) fs.copyFileSync(src, path.join(editionDir, path.basename(src)));
    }
  const cardMeta = new Map();
  for (const i of inventory) {
    const m = path.join(cardsDir, `${i.id}.meta.json`);
    if (fs.existsSync(path.join(cardsDir, `${i.id}.json`)))
      try {
        cardMeta.set(i.id, JSON.parse(fs.readFileSync(m, "utf8")));
      } catch {
        cardMeta.set(i.id, {});
      }
  }
  const files = fs
    .readdirSync(editionDir)
    .filter((f) => /\.(pdf|md)$/i.test(f))
    .sort()
    .map((f) => {
      const p = path.join(editionDir, f);
      return { name: f, bytes: fs.statSync(p).size, sha256: sha256(p) };
    });
  const edition = path.basename(editionDir);
  const manifest = buildEditionManifest({ ...rest, edition, produced, items: inventory, cardMeta, files });
  fs.writeFileSync(path.join(editionDir, "MANIFEST.json"), JSON.stringify(manifest, null, 2));

  const latestPath = path.join(dataOut, "LATEST.json");
  let latest = {};
  try {
    latest = JSON.parse(fs.readFileSync(latestPath, "utf8"));
  } catch {
    /* first edition */
  }
  for (const k of produced)
    latest[k] = {
      method: METHODS[k].label,
      edition,
      generated: manifest.generated,
      folder: path.relative(dataOut, editionDir).replace(/\\/g, "/"),
      manifest: path.relative(dataOut, path.join(editionDir, "MANIFEST.json")).replace(/\\/g, "/")
    };
  latest.updated = manifest.generated;
  fs.writeFileSync(latestPath, JSON.stringify(latest, null, 2));
  return { manifest, editionDir };
}
