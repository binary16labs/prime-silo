// The opus phase — "The AI Vampire": a book-length synthesis (200+ pages)
// built the only way a 4k-context local model can build one: hierarchically.
// One outline call (parts+chapters) → one sections call per chapter → one
// retrieval-grounded generation call per section (~90-110 sections), each
// bounded, each cited, each resume-safe (a section file on disk is done).
// Greater-than-the-sum comes from structure + retrieval, not context length.
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { config, workspaceDir, stateDir } from "./config.mjs";
import { chat, lastBalancedJson, repairTruncatedJson } from "./llm.mjs";
import { appendLedger, writeStatus } from "./ledger.mjs";
import { evidenceForWithSources } from "./retrieve.mjs";
import { buildArcs, arcsForChapter, arcBriefs } from "./arcs.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const prompt = (name) =>
  fs.readFileSync(path.join(__dirname, "..", "prompts", `${name}.md`), "utf8");

// Output subdir is configurable (config.OPUS_DIR) so a fresh iteration can be
// built without clobbering a prior book — the "opus" default keeps legacy paths.
const opusDir = (...p) => workspaceDir("data_out", ...config.OPUS_DIR.split("/"), ...p);

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
    // Chronological spine (deterministic, from reduce) — the outline and chapter
    // specs follow the actual arc of the journey, not just thematic clusters.
    `## Timeline (the journey, month by month)\n${readIf(path.join(out, "TIMELINE.md"), 3500)}`,
    `## Portfolio report (excerpt)\n${readIf(path.join(out, "PORTFOLIO-REPORT.md"), 2500)}`
  ];
  try {
    const dossiers = fs
      .readdirSync(path.join(out, "dossiers"))
      .filter((f) => f.endsWith(".md"))
      .sort()
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

// Sorted, clipped digest of the post-graph session reviews — the cross-session
// collation material that grounds the reflection sections.
function reviewsDigest(cap = 3200) {
  const rDir = workspaceDir("data_out", "reviews");
  try {
    return fs
      .readdirSync(rDir)
      .filter((f) => f.endsWith(".md"))
      .sort()
      .map((f) => readIf(path.join(rDir, f), 800))
      .join("\n\n---\n\n")
      .slice(0, cap);
  } catch {
    return "";
  }
}

async function jsonCall(name, system, user, maxTokens, requiredKey = null, minItems = 1) {
  // Two attempts. Hard-won constraints on this stack (all ledgered live):
  // - lemonade's JSON mode (response_format json_object) makes qwen3.5 stop
  //   mid-object at ~300 tokens and interleave stray scalars ("parts": [1,
  //   {…}]) — while plain-text calls of the same length complete fine. So ask
  //   for JSON in the prompt and parse it out (lastBalancedJson strips prose).
  // - Early stops lose the closing braces and lastBalancedJson then finds an
  //   INNER object: fall back to truncation repair before declaring invalid.
  // - Validity = the required key holds ≥ minItems real entries (objects with
  //   a title); stray scalars are filtered out rather than fatal downstream.
  const normalize = (o) => {
    if (!o) return null;
    if (!requiredKey) return o;
    const v = Array.isArray(o[requiredKey]) ? o[requiredKey] : null;
    if (!v) return null;
    const items = v.filter((x) => x && typeof x === "object" && typeof x.title === "string");
    return items.length >= minItems ? { ...o, [requiredKey]: items } : null;
  };
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
      temperature: attempt === 0 ? 0.5 : 0.3
    });
    const parsed =
      normalize(lastBalancedJson(res.content)) ?? normalize(repairTruncatedJson(res.content));
    appendLedger({
      phase: "opus",
      artifact: name,
      ms: Date.now() - started,
      prompt_tokens: res.prompt_tokens,
      completion_tokens: res.completion_tokens,
      attempt,
      ok: Boolean(parsed)
    });
    if (parsed) return parsed;
    lastHead = res.content.slice(0, 120).replace(/\s+/g, " ");
    console.log(`[opus] ${name} attempt ${attempt + 1} invalid — head: ${lastHead}`);
  }
  return null;
}

async function buildOutline(interrupted) {
  const outlinePath = opusDir("outline.json");
  const realParts = (o) =>
    Array.isArray(o?.parts)
      ? o.parts.filter((p) => p && typeof p === "object" && typeof p.title === "string")
      : [];
  let outline = null;
  try {
    outline = JSON.parse(fs.readFileSync(outlinePath, "utf8"));
    // A previous run may have persisted a degenerate outline (stray scalars in
    // parts, or a single salvaged part) — rebuild rather than resume garbage.
    const parts = realParts(outline);
    if (parts.length >= 3) outline.parts = parts;
    else outline = null;
  } catch {
    /* build it */
  }
  if (!outline) {
    // Parts only — a full 14-18 chapter outline overflows the output budget
    // and truncates into unparseable JSON (seen live). Hierarchy all the way:
    // parts → chapters-per-part → sections-per-chapter.
    console.log("[opus] outline: parts…");
    // Budget math on the 4k-ctx model: the full digest (~2.2k tokens) plus a
    // 1200-token output left no room — both attempts truncated mid-JSON
    // (2026-07-03). Trim the digest and spend the savings on output room.
    outline = await jsonCall(
      "outline",
      prompt("vampire_outline"),
      foundationDigest().slice(0, 3500),
      1800,
      "parts",
      3
    );
    if (!outline?.parts?.length) throw new Error("outline did not parse — rerun the opus phase");
    outline.parts.forEach((p, i) => {
      if (typeof p.n !== "number") p.n = i + 1;
    });
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
      "chapters",
      2
    );
    if (spec?.chapters?.length) {
      part.chapters = spec.chapters.map((c, i) => ({ ...c, n: nextChapter + i }));
      nextChapter += spec.chapters.length;
      // Cohesion contract (enforced deterministically, not asked of the model):
      // every part closes with a Reflection chapter grounded in the post-graph
      // session reviews — the "greater than the sum" interludes of the journey.
      if (!part.chapters.some((c) => /reflection/i.test(c.title || ""))) {
        part.chapters.push({
          n: nextChapter++,
          title: `Reflection — ${part.title}`,
          brief:
            `A reflective interlude closing Part ${part.n}: what this stretch of the ` +
            `journey taught — patterns, reversals, and lessons across its sessions, ` +
            `grounded in the session reviews and themes. Ends looking forward.`,
          reflection: true
        });
      }
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
      // Reflection chapters get one fixed, deterministic section — no LLM
      // planning call, no drift.
      if (ch.reflection) {
        ch.sections = [
          {
            id: `p${part.n}c${ch.n}s1`,
            title: ch.title,
            brief: ch.brief,
            reflection: true,
            query: `lessons learned reflection patterns ${part.title} ${part.theme || ""}`
          }
        ];
        fs.writeFileSync(outlinePath, JSON.stringify(outline, null, 2));
        continue;
      }
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
        "sections",
        3
      );
      if (spec?.sections?.length) {
        // Section ids become filenames — never let a missing id collide.
        ch.sections = spec.sections.map((s, i) => ({
          ...s,
          id: s.id || `p${part.n}c${ch.n}s${i + 1}`
        }));
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

// Deterministic craft gate — the prompt's rules (length, inline citations) are
// VALIDATED, not just requested. When the section carries assigned arcs, it must
// also cite at least one of the arc's real sids — that is the mechanical half of
// "actually connects across projects" (the critique call judges the rest).
function sectionGate(text, arcSids = []) {
  const words = text.split(/\s+/).filter(Boolean).length;
  const cites = (text.match(/\((sid|concept|doc):\s*[^)]+\)/g) || []).length;
  const citedSids = (text.match(/\(sid:\s*[a-z0-9]{6,}\s*\)/gi) || []).map((m) =>
    m
      .replace(/.*sid:\s*/i, "")
      .replace(/\s*\).*/, "")
      .slice(0, 8)
      .toLowerCase()
  );
  const arcSet = new Set(arcSids.map((s) => s.slice(0, 8).toLowerCase()));
  const hitsArc = arcSet.size ? citedSids.some((s) => arcSet.has(s)) : true;
  const errs = [];
  if (words < 400) errs.push(`too short (${words} words; need 650-950)`);
  if (words > 1300) errs.push(`too long (${words} words; need 650-950)`);
  if (cites < 2) errs.push(`only ${cites} inline citation(s); need 2-5 like (sid: abc123)`);
  if (arcSet.size && !hitsArc)
    errs.push(
      `cite at least one of this section's arc sids: ${[...arcSet].slice(0, 4).join(", ")}`
    );
  return { errs, words, cites, hitsArc };
}

// One connective-editor pass (LLM): does the draft draw the arc's cross-project
// connection, or just describe one project? Returns fixes to fold into a revise.
async function critiqueSection(arcList, draft) {
  if (!arcList?.length) return { fixes: [], connects: null };
  try {
    const res = await chat({
      system: prompt("vampire_critique"),
      user: [`## Assigned arcs\n${arcBriefs(arcList)}`, `## Draft\n${draft.slice(0, 5000)}`].join(
        "\n\n"
      ),
      maxTokens: 500,
      temperature: 0.2,
      json: true
    });
    const v = lastBalancedJson(res.content) ?? repairTruncatedJson(res.content) ?? {};
    const fixes = Array.isArray(v.fixes)
      ? v.fixes.filter((f) => typeof f === "string").slice(0, 4)
      : [];
    // Weak on any connective axis → surface it as a fix even if the model left fixes empty.
    if (v.connects === false && !fixes.length)
      fixes.push(
        "draw the actual cross-project connection the arc names — don't describe one project in isolation"
      );
    if (v.cites_arc_sids === false) fixes.push("cite at least one sid from the assigned arc beats");
    if (v.invented === true)
      fixes.push("remove any project, sid, quote or number not in the evidence");
    return { fixes, connects: v.connects ?? null, invented: v.invented ?? null };
  } catch {
    return { fixes: [], connects: null };
  }
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
  // Timeline-walked arcs: the cross-project through-lines every chapter draws on.
  const arcData = await buildArcs({ interrupted });
  const chapterArcs = new Map(); // ch.n → arcs[]
  for (const part of outline.parts || [])
    for (const ch of part.chapters || [])
      chapterArcs.set(ch.n, ch.reflection ? [] : arcsForChapter(ch, arcData.arcs || []));
  const sections = allSections(outline);
  console.log(
    `[opus] ${sections.length} sections planned · ${arcData.arcs?.length || 0} arcs assigned across chapters`
  );
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
    const arcList = chapterArcs.get(ch.n) || [];
    const arcSids = [...new Set(arcList.flatMap((a) => a.sids || []))];
    try {
      // Retrieval query is arc-biased: fold the arc threads into the query so the
      // chunks retrieved are the ones the arc connects, not scattered matches.
      const query = [s.query || `${ch.title} ${s.title}`, ...arcList.map((a) => a.thread)]
        .filter(Boolean)
        .join(" ");
      const ev = await evidenceForWithSources(query, {
        topK: arcList.length ? 6 : 4,
        budget: s.reflection ? 2400 : 3800
      });
      let evidence = ev.text;
      const evidenceSources = ev.sources;
      // The assigned arcs — concrete cross-project connections + the real sids to
      // cite. This is the connective material the first book lacked.
      const arcContext = arcBriefs(arcList);
      if (arcContext)
        evidence += `\n\n## Narrative arcs to connect (cite their sids)\n${arcContext}`;
      // Reflection sections are grounded in the post-graph session reviews —
      // the cross-session collation is what the interlude reflects on.
      if (s.reflection) {
        const rd = reviewsDigest(2400);
        if (rd) evidence += `\n\n## Session reviews (cross-session collation)\n${rd}`;
      }
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
      const baseUser = [
        `## Book\n${JSON.stringify({ metaphor: outline.metaphor, arc: outline.arc }).slice(0, 1200)}`,
        `## Chapter ${ch.n}: ${ch.title}\n${ch.brief || ""}`,
        `## This section\n${JSON.stringify({ title: s.title, brief: s.brief })}`,
        s.reflection
          ? `## Note\nThis is a REFLECTION interlude: step back from scene narration; synthesise the lessons, patterns and reversals of this part across its sessions, drawing on the session reviews. Still cite.`
          : "",
        prevTail ? `## Previous section ends…\n${prevTail}` : "",
        `## Retrieved evidence\n${evidence}`
      ]
        .filter(Boolean)
        .join("\n\n");

      // draft → critique → revise. The deterministic gate (length, citations,
      // arc-sid coverage) is enforced every attempt; a connective-editor LLM
      // pass then judges whether the draft actually draws the arc's cross-
      // project connection, and its fixes fold into the revise. The best of the
      // attempts is always kept — never a hole, never a silently thin section.
      let best = null;
      let bestGate = null;
      let critique = { fixes: [], connects: null };
      let tokens = { prompt: 0, completion: 0 };
      const MAX = arcList.length ? 3 : 2; // extra revise budget only where there's an arc to land
      for (let attempt = 0; attempt < MAX; attempt++) {
        const problems = [
          ...(bestGate ? bestGate.errs : []),
          ...(attempt > 0 ? critique.fixes : [])
        ];
        const feedback =
          attempt > 0 && problems.length
            ? `\n\n## Fix these problems from your previous draft\n- ${problems.join("\n- ")}`
            : "";
        const res = await chat({
          system: prompt("vampire_section"),
          user: baseUser + feedback,
          maxTokens: 1500,
          temperature: attempt === 0 ? 0.65 : 0.45
        });
        tokens.prompt += res.prompt_tokens;
        tokens.completion += res.completion_tokens;
        const text = res.content.trim();
        const g = sectionGate(text, arcSids);
        // "Better" = fewer craft errors, then stronger arc landing, then more cites.
        if (
          !best ||
          g.errs.length < bestGate.errs.length ||
          (g.errs.length === bestGate.errs.length && g.hitsArc && !bestGate.hitsArc) ||
          (g.errs.length === bestGate.errs.length &&
            g.hitsArc === bestGate.hitsArc &&
            g.cites > bestGate.cites)
        ) {
          best = text;
          bestGate = g;
        }
        // Stop early only when craft is clean AND (no arc, or the connective
        // editor is satisfied). Run the critique between draft and revise.
        if (g.errs.length === 0) {
          if (!arcList.length || attempt >= MAX - 1) break;
          critique = await critiqueSection(arcList, text);
          tokens.prompt += 0; // critique tokens ledgered inside its own call path
          if (!critique.fixes.length) break; // editor satisfied
        }
      }
      if (!best || best.length < 200) throw new Error("no usable draft after retry");
      fs.writeFileSync(file, best);
      // Benny Record provenance: WHAT went into this section — the lineage edge.
      fs.writeFileSync(
        opusDir("sections", `${s.id}.meta.json`),
        JSON.stringify(
          {
            id: s.id,
            query: s.query || `${ch.title} ${s.title}`,
            reflection: !!s.reflection,
            evidence_sources: evidenceSources,
            arcs: arcList.map((a) => a.title),
            arc_sids: arcSids,
            connects: critique.connects,
            cited_sids: [
              ...new Set(
                (best.match(/\(sid:\s*[a-z0-9]{6,}\s*\)/gi) || []).map((m) =>
                  m
                    .replace(/.*sid:\s*/i, "")
                    .replace(/\s*\).*/, "")
                    .slice(0, 8)
                )
              )
            ],
            cited_concepts: [
              ...new Set(
                (best.match(/\(concept:\s*[^)]+\)/gi) || []).map((m) =>
                  m
                    .replace(/.*concept:\s*/i, "")
                    .replace(/\s*\).*/, "")
                    .trim()
                )
              )
            ],
            tokens,
            gate: bestGate,
            model: config.LONGVIEW_MODEL,
            ts: new Date().toISOString()
          },
          null,
          2
        )
      );
      const passed = bestGate.errs.length === 0;
      if (passed) done++;
      else failed++;
      appendLedger({
        phase: "opus",
        artifact: `section:${s.id}`,
        ms: Date.now() - started,
        prompt_tokens: tokens.prompt,
        completion_tokens: tokens.completion,
        words: bestGate.words,
        citations: bestGate.cites,
        ok: passed,
        ...(passed ? {} : { gate_errors: bestGate.errs })
      });
      console.log(
        `[opus] ${s.id} ${passed ? "ok" : "GATE-FAIL (kept best draft)"} (${done}/${sections.length}, ${((Date.now() - started) / 1000).toFixed(0)}s, ${bestGate.cites} cites${arcList.length ? `, arc:${bestGate.hitsArc ? "✓" : "✗"}${critique.connects === false ? " connect:✗" : ""}` : ""})`
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
  const coverage = writeCoverage(outline, sections, words);
  console.log(
    `[opus] assembled: ${done}/${sections.length} sections, ~${words} words (~${Math.round(words / 350)} pages), session coverage ${(coverage * 100).toFixed(0)}%`
  );
  writeStatus({
    phase: "opus_done",
    opus_sections_done: done,
    opus_sections_total: sections.length,
    opus_words: words,
    opus_citation_coverage: +coverage.toFixed(3)
  });
}

// Deterministic honesty report: how much of the corpus the book actually stands
// on. Written next to the book; thresholds warn (non-fatal) so a thin book is
// visible, never silent.
function writeCoverage(outline, sections, words) {
  const book = readIf(opusDir("THE-AI-VAMPIRE.md"), 10000000);
  const sids = new Set(
    (book.match(/\(sid:\s*[a-z0-9]{6,}\s*\)/gi) || []).map((m) =>
      m
        .replace(/.*sid:\s*/i, "")
        .replace(/\s*\).*/, "")
        .slice(0, 8)
    )
  );
  let totalCards = 0;
  try {
    // .meta.json ALSO ends with .json — exclude it, or the denominator doubles
    // and coverage reads at half its true value (2026-07-15: 59/376 vs 59/188).
    totalCards = fs
      .readdirSync(stateDir("cards"))
      .filter((f) => f.endsWith(".json") && !f.endsWith(".meta.json")).length;
  } catch {
    /* no cards dir */
  }
  let dossiers = [];
  let dossiersReferenced = 0;
  try {
    dossiers = fs
      .readdirSync(workspaceDir("data_out", "dossiers"))
      .filter((f) => f.endsWith(".md"))
      .map((f) => f.replace(/\.md$/, ""));
    const lower = book.toLowerCase();
    dossiersReferenced = dossiers.filter((d) =>
      lower.includes(d.replace(/_/g, " ").toLowerCase())
    ).length;
  } catch {
    /* none */
  }
  let pass = 0,
    gateFail = 0,
    missing = 0,
    reflections = 0;
  for (const { s } of sections) {
    const f = opusDir("sections", `${s.id}.md`);
    if (!fs.existsSync(f)) {
      missing++;
      continue;
    }
    if (s.reflection) reflections++;
    const g = sectionGate(fs.readFileSync(f, "utf8"));
    if (g.errs.length === 0) pass++;
    else gateFail++;
  }
  const coverage = totalCards ? sids.size / totalCards : 0;
  const min = Number(process.env.LONGVIEW_OPUS_MIN_CITE_COVERAGE || 0.35);
  const md = [
    "# Book coverage report (deterministic)",
    "",
    `- words: ${words} (~${Math.round(words / 350)} pages)`,
    `- sections: ${pass} pass gate, ${gateFail} gate-fail (kept best draft), ${missing} missing`,
    `- reflection interludes: ${reflections}`,
    `- distinct sessions cited: ${sids.size} of ${totalCards} cards (${(coverage * 100).toFixed(1)}%)`,
    `- dossiers referenced in text: ${dossiersReferenced} of ${dossiers.length}`,
    `- citation-coverage threshold: ${min} → ${coverage >= min ? "MET" : "BELOW (see ledger)"}`,
    ""
  ].join("\n");
  fs.writeFileSync(opusDir("COVERAGE.md"), md);
  appendLedger({
    phase: "opus",
    artifact: "coverage",
    words,
    sections_pass: pass,
    sections_gate_fail: gateFail,
    sections_missing: missing,
    reflections,
    sessions_cited: sids.size,
    cards_total: totalCards,
    citation_coverage: +coverage.toFixed(3),
    dossiers_referenced: dossiersReferenced,
    dossiers_total: dossiers.length,
    ok: coverage >= min
  });
  if (coverage < min)
    console.log(
      `[opus] WARN citation coverage ${(coverage * 100).toFixed(1)}% < ${min * 100}% threshold — book stands on a thin slice of the corpus`
    );
  return coverage;
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
