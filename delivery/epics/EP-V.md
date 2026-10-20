# EP-V — The adaptive estate (confidence you can see, categories that learn, plug-ins, a calm visual canvas)

**Objective:** O2 (+ O4) · **Milestone:** M13 (to be written) · **Status:** draft for the owner's
signature, 2026-10-12
**Builds on:** EP-S (librarian), EP-U (consolidation, ledger, lineage), EP-K (knowledge), the C0 ADHD
contract and the Prime-Silo experience skill (`.claude/skills/prime-silo-experience`), the typed
widget registry (ADR-001, `app/L0/_all/mod/_prime_silo/widgets/`), and the lineage surfaces
(`_prime_silo/lineage`, the Lineage arc, `scratch/longview_run/dashboard/lineage.mjs` OpenLineage).

Owner direction (2026-10-11): "I want to have the management solution to be able to validate and
have confidence to manage the massive data onboarding and also I am not sure the right categories
and management of data are applied, we can have something better than all the vendor software till
date, something that will stand the test of time because it will be modular and flexible and plug and
play, adaptive is the word that comes to mind, remember that this should also be ADHD and dyslexic
and use images and diagrams and UI with good UX widgets and canvas." And: "how would I have full
lineage and explain the data from the exceptions, and also have the ability to not have to write but
more re-use what we have and basic OS functions if needed."

**The one idea:** the owner manages a very large estate **by exception, with proof**.
- Every drive, folder and file climbs a visible **trust ladder**, and a ring turns green only when an
  independent check proved it.
- What needs the owner arrives as a short **"Needs you"** list. Each item carries a plain-words
  reason, its **lineage**, and one-tap fixes.
- **Categories are suggested and explained**, confirmed in batches, and learned from corrections.
- **Every capability is a plug-in** chosen by what is available and fastest.
- **Nothing is written that the operating system or an existing tool already does.**

## Pillars (normative for every EP-V contract, and for every estate screen after signature)

1. **Confidence you can see.** The trust ladder is seen → listed → fingerprinted → sorted → 2
   copies → protected.
   - A step turns green only on proof (an independent check, a read-back match, a signed
     approval), never on an estimate.
   - Numbers that are not certain show as ranges (K0's rule).
   - A drive, folder or category shows its ring. Tables are the fallback, not the face.
2. **Manage by exception, with lineage.**
   - The **Needs you** list holds only what needs the owner, grouped by kind: only one copy,
     changed since catalogued, could not read, not sorted, and later copy conflicts.
   - Each item shows **why** in one sentence; its **lineage chain** (origin → drives → copies and
     checks → now), each link labelled *recorded* or *inferred*; **fixes** as buttons; and **look
     with your own tools** (below).
   - Lineage is folded from what is already recorded: S24 EXIF, S21/U0 first sightings, U8 copy
     events with `derived_from`, S20–S23 results and N5 signatures. Copies that predate Prime-Silo
     are honestly *inferred* (the known lineage gap, "ORIGIN RECORDED 0/N").
3. **Categories that adapt.**
   - Today a category is a file's extension (S23 kinds). Instead, plug-in **classifiers** each
     propose a category with a confidence and a reason:
     - extension;
     - real file header;
     - EXIF and media tags;
     - folder conventions ("Receipts", "Invoices", camera folder names);
     - document text signals (K2);
     - optionally the local model reading names and metadata, never content of quarantined files.
   - The owner confirms in **batches** ("accept 2,300, review the 12 odd ones, or not receipts").
   - Each correction becomes a **rule** with its provenance.
   - Categories are versioned ledger events (EP-U §16). Re-categorising never moves data; only the
     storage policy (U7) acts on categories.
4. **Plug and play, adaptive.** Every capability has one small contract and swappable
   implementations:
   - sources: drives, OneDrive, phone, NAS;
   - listers: Everything, walker, WizTree;
   - fingerprinters;
   - classifiers;
   - duplicate rules (S24);
   - indexers (EP-K);
   - stores and copiers;
   - screen widgets.
   The system **chooses** by availability and measured speed (S1's `selectAdapters` and
   `recommend`, generalised) and says which it chose and why. UI pieces register through the
   existing **widget registry** (ADR-001, `pane_contract.js`), and server pieces through the
   adapter pattern S1 established. A new plug-in is a folder and a registration, never an edit to
   the core.
5. **Reuse before writing.** Use what the machine and the estate already have:
   - **Windows:** Show in Explorer (`explorer /select,`), open with the default app, the Properties
     dialog, Windows' own thumbnails, robocopy for copies (U8, resumable, timestamps kept) plus our
     read-back check, and dictation (Win+H) in any text box.
   - **Existing tools:** Everything (open a search pre-filtered to the files), Voicebox to read a
     report aloud, the Lineage arc and OpenLineage graph for lineage, Benny skills for questions.
   - A capability is written only when no OS function or estate tool does it, and the contract
     says which was considered.
6. **A calm, visual screen** (extends the C0 ADHD contract; dyslexia-aware):
   - One decision per screen, one rust primary action, `More ▸` for the rest, and a **next step
     card** with time and "you can leave, I keep going".
   - Rings, pictures and diagrams before tables; icons plus shape, never colour alone; rounded
     numbers in human units; short plain sentences.
   - Type ≥ 16 px, line-height ≥ 1.5, ≤ 70 ch, left aligned, never justified, no italics for
     meaning, no all-caps. An opt-in **dyslexia-friendly type profile**.
   - Batch actions with **undo**; nothing irreversible without a signed step.
   - Motion only for real events, with reduced motion and Zen respected (the experience skill's
     hard gates).
   - Every report can be **read aloud**.
7. **The canvas.**
   - A zoomable map of machines → drives → user roots → folders, built from the widget registry's
     existing canvases (`force_graph_2d`, `dag`, `workflow_designer`), with rings on every node.
   - The owner acts by **dragging**: a folder onto Catalogue, a drive onto "make replica", a group
     of files onto a category.
   - The same canvas shows lineage for a selected item.

## Phases → task contracts (M13, to be authored)

- [ ] `V0` — **the UX contract as a gate**: `scripts/gates/vux.mjs` checks every estate panel for
  one primary action, type sizes, line-height, measure, no justify or all-caps, labelled icons,
  rounded human-unit numbers, reduced-motion final states, and a next step card. Run on S21 and on
  every later estate screen _(agent-ok)_
- [ ] `V1` — **trust ladder and Needs you**: the ladder per drive, root and category (from S21–S24,
  U0, U6 and K0 facts); the exceptions list with one-sentence reasons and fixes _(agent-ok)_
- [ ] `V2` — **lineage chain**: per item or group, folded from recorded events, recorded vs
  inferred labelled; rendered with the widget registry's `dag`; opens the Lineage arc for depth
  _(agent-ok)_
- [ ] `V3` — **look with your own tools**: Show in Explorer, open, Properties, Find in Everything,
  read aloud. Shell actions run on the node that owns the file, loopback only, never with a path
  from outside the catalogue _(human-signed — launches OS programs)_
- [ ] `V4` — **plug-in contract and adaptive selection**: one registry for server capabilities
  (sources, listers, fingerprinters, classifiers, rules, indexers, copiers) beside the UI widget
  registry; selection by availability and measured speed, with the choice and reason shown
  _(agent-ok)_
- [ ] `V5` — **adaptive categories**: classifier plug-ins, batch confirmation with reasons and undo,
  corrections into versioned rules, and categories as ledger events _(human-signed — categories
  drive the storage policy)_
- [ ] `V6` — **the canvas**: machines → drives → roots → folders with rings; drag-to-act (catalogue,
  make replica, categorise), each drop becoming the same signed or confirmed action as its button
  _(agent-ok)_
- [ ] `V7` — **dyslexia profile and read-aloud**: an opt-in type profile, and Voicebox reading of
  any report or Needs you item _(agent-ok)_

## Amendments to signed contracts (proposed; each needs the owner's signature)

| Contract | Amendment |
| --- | --- |
| S22 (Benny the librarian) | Benny answers as cards with rings and pictures (thumbnails via Windows), not paragraphs; every answer offers the "look with your own tools" buttons once V3 exists |
| S23 (Everything and levels) | S23's `kind` becomes the first classifier plug-in under V4/V5 rather than the final category |
| U6 (copies and risk) | its exceptions are delivered as V1's Needs you list |
| U8 (signed copy) | copies use **robocopy** (resumable, timestamps kept) plus our streamed fingerprint and read-back verification, instead of a new copy engine |
| S24, U0, U1, K0 (estate screens) | must pass V0's UX gate |

## Owner questions (answer at signature)

1. **Apply the UX gate (V0) to the already-signed screens now** (S24, U0, U1, K0), as an amendment
   before they are built? Recommendation: yes. Rebuilding screens later costs more than building
   them right.
2. **The local model for classifier suggestions and Benny:** start with **Gemma 4 E4B**
   (`gemma-4-e4b-agent`, already downloaded in LM Studio and proven for LONGVIEW agent work), with
   `google/gemma-4-12b` as the step up if quality is short. Recommendation: yes, and measure before
   changing.
3. **The dyslexia type profile:** a bundled open font (Atkinson Hyperlegible or OpenDyslexic) as an
   opt-in profile. Recommendation: Atkinson Hyperlegible, which is easier to read for everyone
   without looking unusual.
4. **Robocopy for U8.** Recommendation: yes. Windows' own copier is battle-tested, and our part is
   the verification.

## Exit

All phase gates green and verified by a non-author agent. On the real T480, the owner can, without
typing:
- see the trust ladder for F: and the user roots;
- clear a Needs you item using its reason, lineage and a fix;
- open the files in Explorer;
- confirm a batch category suggestion and undo it.

V0's gate passes on every estate screen. The owner's own read of the screens ("does this feel calm
and clear?") is recorded with the verification, because this epic is judged by the person using it.
