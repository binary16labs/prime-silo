// The opus phase — "The AI Vampire": a book-length synthesis (200+ pages)
// built the only way a 4k-context local model can build one: hierarchically.
// One outline call (parts+chapters) → one sections call per chapter → one
// retrieval-grounded generation call per section (~90-110 sections), each
// bounded, each cited, each resume-safe (a section file on disk is done).
// Greater-than-the-sum comes from structure + retrieval, not context length.
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { config, workspaceDir } from "./config.mjs";
import { chat, lastBalancedJson } from "./llm.mjs";
import { appendLedger, writeStatus } from "./ledger.mjs";
import { evidenceFor } from "./retrieve.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const prompt = (name) =>
  fs.readFileSync(path.join(__dirname, "..", "prompts", `${name}.md`), "utf8");

const opusDir = (...p) => workspaceDir("data_out", "opus", ...p);

function readIf(p, cap = 4000) {
  try {
    return fs.readFileSync(p, "utf8").slice(0, cap);
  } catch {
    return "";
  }
}

function foundationDigest() {
  const out = workspaceDir("data_out");
  const parts = [
    `## Themes\n${readIf(path.join(out, "THEMES.md"), 5000)}`,
    `## Portfolio report (excerpt)\n${readIf(path.join(out, "PORTFOLIO-REPORT.md"), 2500)}`
  ];
  try {
    const dossiers = fs
      .readdirSync(path.join(out, "dossiers"))
      .filter((f) => f.endsWith(".md"))
      .map((f) => f.replace(/\.md$/, ""));
    parts.push(`## Projects with dossiers\n${dossiers.join(", ")}`);
  } catch {
    /* none yet */
  }
  try {
    const notes = fs
      .readdirSync(path.join(out, "discovery"))
      .filter((f) => f.endsWith(".md"))
      .map((f) => "- " + readIf(path.join(out, "discovery", f), 120).split("\n")[0]);
    if (notes.length) parts.push(`## Discovery notes\n${notes.join("\n")}`);
  } catch {
    /* none yet */
  }
  return parts.join("\n\n");
}

async function jsonCall(name, system, user, maxTokens, requiredKey = null) {
  // Two attempts: local JSON mode still sometimes truncates or wraps in prose
  // (seen live: the outline call parsed to an inner object, losing .parts).
  // The retry quotes the failure back; validity means the required key is a
  // non-empty list — every required key here (parts/chapters/sections) is one,
  // and the weaker `!= null` check let an empty/malformed value through, which
  // then blew up the strict caller check (fatal on the 2026-07-03 run).
  let lastHead = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const started = Date.now();
    const feedback =
      attempt > 0
        ? `\n\nYour previous answer was not valid (${lastHead ? `it began: ${lastHead}` : "empty"}). Return ONLY the complete JSON object, nothing else, and keep it compact.`
        : "";
    const res = await chat({
      system,
      user: user + feedback,
      maxTokens,
      json: true,
      temperature: attempt === 0 ? 0.5 : 0.3
    });
    const parsed = lastBalancedJson(res.content);
    const valid =
      Boolean(parsed) &&
      (!requiredKey || (Array.isArray(parsed[requiredKey]) && parsed[requiredKey].length > 0));
    appendLedger({
      phase: "opus",
      artifact: name,
      ms: Date.now() - started,
      prompt_tokens: res.prompt_tokens,
      completion_tokens: res.completion_tokens,
      attempt,
      ok: valid
    });
    if (valid) return parsed;
    lastHead = res.content.slice(0, 120).replace(/\s+/g, " ");
    console.log(`[opus] ${name} attempt ${attempt + 1} invalid — head: ${lastHead}`);
  }
  return null;
}

async function buildOutline(interrupted) {
  const outlinePath = opusDir("outline.json");
  let outline = null;
  try {
    outline = JSON.parse(fs.readFileSync(outlinePath, "utf8"));
  } catch {
    /* build it */
  }
  if (!outline) {
    // Parts only — a full 14-18 chapter outline overflows the output budget
    // and truncates into unparseable JSON (seen live). Hierarchy all the way:
    // parts → chapters-per-part → sections-per-chapter.
    console.log("[opus] outline: parts…");
    outline = await jsonCall(
      "outline",
      prompt("vampire_outline"),
      foundationDigest(),
      1200,
      "parts"
    );
    if (!outline?.parts?.length) throw new Error("outline did not parse — rerun the opus phase");
    fs.writeFileSync(outlinePath, JSON.stringify(outline, null, 2));
  }

  // Per-part chapter breakdown, resume-safe per part.
  let nextChapter = 1;
  for (const part of outline.parts) {
    if (Array.isArray(part.chapters) && part.chapters.length) {
      nextChapter = Math.max(nextChapter, ...part.chapters.map((c) => c.n)) + 1;
      continue;
    }
    if (interrupted()) return outline;
    console.log(`[opus] chapters for part ${part.n}: ${part.title}`);
    const spec = await jsonCall(
      `chapters:p${part.n}`,
      prompt("vampire_part_chapters"),
      [
        `## Book\n${JSON.stringify({ title: outline.title, metaphor: outline.metaphor, arc: outline.arc }).slice(0, 1200)}`,
        `## All parts\n${outline.parts.map((p) => `${p.n}. ${p.title} — ${p.theme}`).join("\n")}`,
        `## THIS part\n${JSON.stringify({ n: part.n, title: part.title, theme: part.theme })}`,
        `## Chapter numbering starts at ${nextChapter}`,
        `## Evidence available\n${foundationDigest().slice(0, 2500)}`
      ].join("\n\n"),
      1300,
      "chapters"
    );
    if (spec?.chapters?.length) {
      part.chapters = spec.chapters.map((c, i) => ({ ...c, n: nextChapter + i }));
      nextChapter += spec.chapters.length;
      fs.writeFileSync(outlinePath, JSON.stringify(outline, null, 2));
    } else {
      console.log(`[opus] WARN chapters for part ${part.n} did not parse — rerun resumes here`);
    }
  }

  // Per-chapter section breakdown, resume-safe per chapter.
  for (const part of outline.parts) {
    for (const ch of part.chapters || []) {
      if (interrupted()) return outline;
      if (Array.isArray(ch.sections) && ch.sections.length) continue;
      console.log(`[opus] sections for part ${part.n} ch ${ch.n}: ${ch.title}`);
      const spec = await jsonCall(
        `sections:p${part.n}c${ch.n}`,
        prompt("vampire_chapter_sections"),
        [
          `## Book\n${JSON.stringify({ title: outline.title, metaphor: outline.metaphor, arc: outline.arc }).slice(0, 1500)}`,
          `## Part ${part.n}: ${part.title} — ${part.theme}`,
          `## Chapter (write sections for THIS one)\n${JSON.stringify({ part: part.n, chapter: ch.n, title: ch.title, brief: ch.brief, projects: ch.projects, motifs: ch.motifs })}`,
          `## Evidence available\n${foundationDigest().slice(0, 3000)}`
        ].join("\n\n"),
        1400,
        "sections"
      );
      if (spec?.sections?.length) {
        ch.sections = spec.sections;
        fs.writeFileSync(outlinePath, JSON.stringify(outline, null, 2));
      } else {
        console.log(
          `[opus] WARN sections for p${part.n}c${ch.n} did not parse — chapter will be regenerated on rerun`
        );
      }
    }
  }
  return outline;
}

function allSections(outline) {
  const list = [];
  for (const part of outline.parts || []) {
    for (const ch of part.chapters || []) {
      for (const s of ch.sections || []) list.push({ part, ch, s });
    }
  }
  return list;
}

export async function runOpus({ interrupted = () => false } = {}) {
  fs.mkdirSync(opusDir("sections"), { recursive: true });
  const outline = await buildOutline(interrupted);
  const sections = allSections(outline);
  console.log(`[opus] ${sections.length} sections planned`);
  let done = 0,
    failed = 0;

  for (const { part, ch, s } of sections) {
    const file = opusDir("sections", `${s.id}.md`);
    if (fs.existsSync(file)) {
      done++;
      continue;
    }
    if (interrupted()) break;
    const started = Date.now();
    try {
      const evidence = await evidenceFor(s.query || `${ch.title} ${s.title}`, {
        topK: 4,
        budget: 3800
      });
      // Continuity: the tail of the previous section, if it exists.
      const idx = sections.findIndex((x) => x.s.id === s.id);
      let prevTail = "";
      if (idx > 0) {
        const prevFile = opusDir("sections", `${sections[idx - 1].s.id}.md`);
        if (fs.existsSync(prevFile)) {
          const prev = fs.readFileSync(prevFile, "utf8");
          prevTail = prev.slice(-350);
        }
      }
      const res = await chat({
        system: prompt("vampire_section"),
        user: [
          `## Book\n${JSON.stringify({ metaphor: outline.metaphor, arc: outline.arc }).slice(0, 1200)}`,
          `## Chapter ${ch.n}: ${ch.title}\n${ch.brief || ""}`,
          `## This section\n${JSON.stringify({ title: s.title, brief: s.brief })}`,
          prevTail ? `## Previous section ends…\n${prevTail}` : "",
          `## Retrieved evidence\n${evidence}`
        ]
          .filter(Boolean)
          .join("\n\n"),
        maxTokens: 1500,
        temperature: 0.65
      });
      const text = res.content.trim();
      if (text.length < 400) throw new Error(`section too short (${text.length} chars)`);
      fs.writeFileSync(file, text);
      done++;
      appendLedger({
        phase: "opus",
        artifact: `section:${s.id}`,
        ms: Date.now() - started,
        prompt_tokens: res.prompt_tokens,
        completion_tokens: res.completion_tokens,
        words: text.split(/\s+/).length
      });
      console.log(
        `[opus] ${s.id} ok (${done}/${sections.length}, ${((Date.now() - started) / 1000).toFixed(0)}s)`
      );
    } catch (e) {
      failed++;
      appendLedger({
        phase: "opus",
        artifact: `section:${s.id}`,
        ok: false,
        error: String(e.message)
      });
      console.log(`[opus] ${s.id} FAILED — ${e.message} (rerun resumes here)`);
    }
    writeStatus({
      phase: "opus",
      opus_sections_done: done,
      opus_sections_total: sections.length,
      opus_failed: failed,
      current_section: s.id
    });
  }

  // Assemble whatever exists — partial assemblies are useful previews and the
  // assembly is deterministic + idempotent.
  const words = assembleBook(outline);
  console.log(
    `[opus] assembled: ${done}/${sections.length} sections, ~${words} words (~${Math.round(words / 350)} pages)`
  );
  writeStatus({
    phase: "opus_done",
    opus_sections_done: done,
    opus_sections_total: sections.length,
    opus_words: words
  });
}

function assembleBook(outline) {
  const parts = [
    `# ${outline.title}`,
    `## ${outline.subtitle || ""}`,
    `\n*${outline.metaphor || ""}*\n`,
    `\n---\n`,
    `## Contents\n`
  ];
  for (const part of outline.parts || []) {
    parts.push(`- **Part ${part.n}: ${part.title}**`);
    for (const ch of part.chapters || []) parts.push(`  - Chapter ${ch.n}: ${ch.title}`);
  }
  let words = 0;
  for (const part of outline.parts || []) {
    parts.push(`\n\n# Part ${part.n}: ${part.title}\n\n*${part.theme || ""}*`);
    for (const ch of part.chapters || []) {
      parts.push(`\n\n## Chapter ${ch.n}: ${ch.title}\n`);
      for (const s of ch.sections || []) {
        const file = opusDir("sections", `${s.id}.md`);
        if (fs.existsSync(file)) {
          const text = fs.readFileSync(file, "utf8");
          words += text.split(/\s+/).length;
          parts.push(text);
        } else {
          parts.push(`### ${s.title}\n\n*(section pending — rerun the opus phase)*`);
        }
      }
    }
  }
  fs.writeFileSync(opusDir("THE-AI-VAMPIRE.md"), parts.join("\n\n"));
  return words;
}
