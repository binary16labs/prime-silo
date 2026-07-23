# ReKindle × Space Agent — Improvement Plan (Kindle Scribe)

Target device: **Kindle Scribe** (10.2", 300 ppi, buttonless, touch + pen, modern
Chromium-based browser). This removes the legacy-browser blockers — ES modules,
`fetch`, `async/await`, `EventSource`, and canvas `pdf.js` all work. Effort should go
to e-ink display correctness, real e-reader interactions, Benny integration, and
verified auth — not to transpilation.

Grounded review of the current code in this folder follows, then a copy-paste prompt
for Antigravity.

---

## What's good (keep)

- `space-bridge.js` cleanly abstracts the two-backend split (Space Agent + Benny).
- No build step, System-7 aesthetic, 44px tap targets, localStorage cache primitives.
- Server-side PDF **text-extract** endpoint is the right e-ink primitive.

## Confirmed issues (from the code)

1. **CDN deps fail on a LAN Kindle.** `reader.html` / `chat.html` load `marked.js` and
   `pdf.js` from jsdelivr/cloudflare. A Scribe on LAN often has **no internet route**,
   so markdown chat and PDF rendering silently break. Vendor them locally. (Still a
   real bug on Scribe — this is a network-topology issue, not a browser issue.)
2. **`prefers-color-scheme: dark` is wrong for e-ink.** Mostly-black screens ghost
   badly and force slow full refreshes. Light-only default; dark as a manual toggle.
3. **`index.html` polls health every 30s** — needless repaints/battery. Check once on
   load + a manual reconnect tap.
4. **Dead code drops the best Benny signal.** `chat.html:96-99` builds `sourceText`
   (the RAG citations) then never renders it; sources collapse to a bare count.
5. **Reader is inconsistent + no resume.** PDF paginates (e-ink-correct); markdown/text
   is one infinite scroll (e-ink-wrong). It caches on read but never falls back to
   cache on error. No reading-position memory anywhere.
6. **Auth acquisition on-device is undefined.** `/reader/*` is public but API calls
   need a session cookie. No `login.html`; cross-origin Benny (`:8005`) with
   `credentials:'include'` won't send cookies without CORS `Allow-Credentials` +
   `SameSite=None`. Likely 401s on-device with no recovery path.

## Better features / interactions (Scribe-specific)

- **Tap-zone paging** (left third = prev, right third = next, center = toolbar) instead
  of small buttons — the Scribe has no page-turn buttons and this is the e-reader idiom.
- **Reading-position memory** ("resume where you left off") per file.
- **"Ask Benny about this document"** in the reader → opens chat with the current doc as
  RAG context. This is the whole point of Benny-on-Scribe.
- **Tappable source citations** in chat that open the reader at the cited doc.
- **Explicit "Refresh screen"** button to clear ghosting.
- **Pen affordance:** keep targets large and pen-friendly; don't rely on hover
  (pen registers as `pointerType: "pen"` PointerEvents).
- **Pen → annotated PDF → vision ingest (the strategic feature).** Capture handwritten
  notes on multi-page documents, export an annotated PDF, and feed it to the EXISTING
  vision pipeline so it becomes categorised/labelled/structured/related knowledge. See
  the "Pen annotation → ingestion" section below — this is a phased R&D track, not a
  one-shot.

---

## Auth — actual state of the code (grounds Step 5)

There are **two separate auth systems**, so "one login" needs a deliberate choice:

- **Space Agent** = **session cookie**. `server/router/router.js` reads cookies
  (`parseCookieHeader`, `STATE_VERSION_COOKIE_NAME`). The bridge already calls
  `/api/login_check`, `/api/user_self_info`, `/logout`. Cookies are same-origin by
  default; a cross-origin Scribe → Space Agent needs `SameSite=None; Secure` + CORS
  `Allow-Credentials`, which is fragile over plain-HTTP LAN.
- **Benny (:8005)** = **`X-Benny-API-Key` header**, already wired in
  `space-bridge.js:54`. Header auth works cross-origin regardless of cookies — the only
  requirement is Benny's CORS allowing the origin AND the `X-Benny-API-Key` header. So
  the earlier `SameSite=None` concern does NOT apply to Benny.

**Recommended fix (cleanest):** proxy Benny UNDER the Space Agent origin via the
existing `server/lib/runtime_proxy.js` (e.g. Space Agent serves `/api/benny/*` →
`http://localhost:8005/*`). Then the Scribe talks to ONE origin, the existing Space
Agent session cookie covers page access, and Benny's API key is injected server-side
(never shipped to the Scribe). This removes the cross-origin cookie problem entirely and
keeps the Benny key off the device.

---

## Pen annotation → ingestion (phased R&D track)

Goal: handwrite notes on multi-page docs with varied layouts on the Scribe, produce an
annotated PDF, and turn it into structured knowledge. The ingestion half already exists:

    upload PDF → POST /api/vision/docmodel  (parse pages into DocModels)
              → POST /api/vision/enrich     (describer ladder → enriched markdown in data_in/)
              → POST /api/rag/ingest        (categorise / label / structure / relate / store)

So ReKindle only needs to (a) capture pen annotations and (b) hand a PDF to that
pipeline. There are two honest paths for (a):

- **Phase 1 — native markup + ReKindle as the ingest trigger (recommended first).**
  Annotate using the Scribe's NATIVE notebook/PDF markup (real low-latency inking; the
  browser can't match it). Get the annotated PDF onto the LAN (Scribe export / a watched
  folder), then ReKindle's job is a one-tap "Ingest this PDF" that runs the
  upload→docmodel→enrich→ingest chain and reports back the resulting labels/links. Low
  risk, ships value immediately, and exercises the whole vision pipeline end-to-end.
- **Phase 2 — in-browser inking (ambitious R&D).** Render each PDF page with pdf.js,
  overlay a transparent per-page annotation canvas sized to that page's layout, capture
  `pointerType:"pen"` strokes, then stamp the strokes back onto the original pages with
  pdf-lib and emit a new PDF. Preserves per-page layout. Caveat to verify on-device:
  e-ink + browser canvas has NO access to the native low-latency ink path, so inking
  will feel laggy — prototype and judge feel before committing. Vendor pdf.js + pdf-lib
  locally (no CDN).

The vision workflow itself needs no new code for this — but confirm the enrich step's
describer actually reads handwriting (it's a general VLM describer ladder; test with a
real annotated page and check the enriched markdown captures the notes, not just the
printed text).

---

## Portal vision — ReKindle as the Binary16 Labs remote (2026-07-11)

Goal: ReKindle grows from "e-reader + chat" into a **freedom/power-friendly, economic
portal** to the binary16 ecosystem — a weeks-of-battery e-ink terminal that can observe
AND drive Space Agent + Benny + LONGVIEW, while local models keep the marginal cost of
every action at zero cloud spend.

### Proven pattern to adopt: the LONGVIEW dashboard

`scratch/longview_run/dashboard/` already works on the Kindle browser, and its recipe is
the answer to the "graphs on e-ink" worry:

- **Inline SVG only** (donuts/arcs drawn by hand, ~278 lines) — no chart libs, no
  canvas, no CDN, no animation.
- **Server computes, client renders**: a collector loop writes `dashboard.json`; the
  page just fetches + redraws discrete SVG.
- Read-only static server (`serve.mjs`, `0.0.0.0:8788`).

Adopt this as the **ReKindle graph idiom**: any graph shown on e-ink is precomputed
server-side into small JSON/SVG (aggregates, layouts), rendered as static monochrome
SVG with discrete zoom steps and tap-to-drill. Never ship force-graph/kg3d to e-ink.

### Device tiers (the "simple vs full Space Agent" split)

Don't fork the app — fork the RENDERING at runtime:

- **lite** (e-ink): static SVG graphs, paged lists, no polling loops, no animation.
- **full** (PC/tablet): link out to the real Space Agent app / kg3d.

Detection: default by capability probe + UA hint (`Kindle` in UA, small color depth),
with a **manual override in Settings** (never trust detection alone). Persist the tier
in `rekindle_config`.

### Remote control — the human-facade principle

ADR-001 forbids **agents** from executing; a human on the Kindle authenticated through
the `/api/runtime/*` HUMAN facade is the human path, so remote control is legitimate.
But `/reader/*` is a public page, so control must be:

- **Allowlisted actions only** (a fixed action registry: name → predefined server-side
  command), never arbitrary shell/params from the browser.
- **Authenticated** (session cookie via the same-origin proxy, per Step 5).
- **Audited** (every action logged with who/when/what; visible in the portal itself).
- **Confirm-before-fire** on e-ink (tap → confirm screen → execute), since accidental
  taps happen.

Candidate action registry v1: start/stop LONGVIEW collector, trigger a LONGVIEW phase,
ingest-this-PDF (Step 6), restart Benny runtime, clear a wedged generation, run a named
manifest (`benny pypes run <registered-id>` — registered manifests only).

---

## DECISIONS (2026-07-11) — answers to implementation questions. These are binding.

**PASS 1 IS GREENLIT — START NOW, even while a LONGVIEW run is executing.**
Scope of Pass 1 = Steps 1–5 exactly:
  1. vendor marked.js + pdf.js locally (kill CDN)
  2. e-ink display correctness (light-only, refresh button, kill the 30s poll)
  3. reader: tap-zone paging, paginate md/text, resume position, cache fallback
  4. chat: render RAG sources as tappable citations; "Ask Benny about this document"
  5. auth: space-bridge.js only — same-origin /api/runtime/* rewrite, delete the
     device-side Benny key, 401 → redirect to existing /login?next=/reader/
Pass 1 touches ONLY site/rekindle/* static files — no server code, no restarts, zero
risk to the live run (see Live-run safety below). STOP after Step 5 and present
on-device verification evidence before starting Pass 2 (7a → 6 → 8), because Pass 2
contains the restart-requiring server changes that must wait for a phase boundary.

**Step 5 — login path: (a), reuse the existing `/login` page.** No duplicate ReKindle
login form. Flow: unauthenticated `/api/runtime/*` call → bridge catches the 401 →
redirect to the existing `/login?next=/reader/`. Restyle only if the existing page is
unusable on e-ink (tap targets, JS traps). Do NOT build a QR flow — the Scribe IS the
browser and can't scan a QR. If password typing on the e-ink keyboard proves painful,
the future follow-up is short-code pairing (login on PC → 6-digit code → type on
Scribe); not now.

**Step 6 — ingest source: hybrid, WATCHED FOLDER is primary.** The Scribe exports
annotated PDFs via email/share, not to the LAN, so: (c) a watched folder on the PC
(email export or USB copy lands there) is the primary source. ReKindle lists that
folder + staging/data_in contents in ONE ingest list with one-tap "Ingest" per file
(stage via existing upload → docmodel → enrich → rag/ingest through /api/runtime/*).
(b) Scribe-browser `<input type="file">` upload is secondary — VERIFY on-device whether
the Scribe file picker can reach downloads at all before investing; if broken, skip it,
the watched folder covers it. (a) files already in data_in/staging appear in the same
list. No new sync mechanism.

**Step 7 — dashboard tile: (a) now, (b) later.** Quick pass: serve the dashboard under
the portal origin (proxy `/reader/dash` → :8788, or better, serve its static files
same-origin and drop the second listener). Once same-origin works, lock `serve.mjs`
back to `DASH_HOST=127.0.0.1` so the unauthenticated 0.0.0.0:8788 origin disappears.
Port natively to a ReKindle page (b) only when a second consumer of /api/runtime data
appears — don't rewrite a working page.

**Step 8 — registry: framework + ONE PoC action, then PAUSE for review.** PoC action =
"start LONGVIEW collector" (read-only on run state per dash.sh, harmless if misfired).
Review deliverable: the registry mechanism, one audit-log entry, proof an
unauthenticated request 401s, and the PROPOSED full registry as a list for sign-off.
Wire nothing else until approved.

**Ordering: Steps 1–5 first as one pass, verified ON THE SCRIBE, then stop.** Evidence
required: LAN-only (internet route disabled) rendering works, no CDN fetches, network
tab shows same-origin /api/runtime/* (not :8005), no Benny key stored on the device.
Then 6–8 as a second pass, ordered 7a → 6 → 8 (7a is nearly free, 6 is the strategic
feature, 8 ends at the review gate). Desktop-Chrome evidence does NOT count as
verification — every "verified" claim needs on-device (or faithful e-ink emulation)
evidence.

**Live-run safety (a LONGVIEW run may be executing while you work):**
- Static-file work (site/rekindle/*, vendoring, CSS, HTML, space-bridge.js) touches
  nothing the run uses — always safe.
- Step 5 needs ZERO server code (the /api/runtime proxy already exists) — no restart
  required.
- Do NOT restart the Benny runtime (:8005) or the Space Agent node server while a run
  is live: ingest/graph phases and /api/runtime depend on them. The pieces that DO
  need a server restart (Step 7a proxy route, Step 8 registry endpoints) must be
  scheduled between phases or after the run completes — check run state first
  (dashboard.json / progress.json).
- Never test the "restart Benny runtime" registry action while a run is live.
- The dash.sh collector is read-only on run state — safe to start/stop anytime.

---

## Prompt for Antigravity

```text
Improve the ReKindle × Space Agent UI in prime-silo/site/rekindle/. Target device is
the KINDLE SCRIBE (modern Chromium-based e-ink browser, buttonless, touch + pen). Do
NOT transpile or drop ES modules — they work. Fix on-device correctness first, then
features. VERIFY each item on the Scribe browser (or a faithful e-ink emulation);
don't label anything "e-ink optimized" without evidence.

STEP 1 — Kill CDN dependencies (LAN has no internet):
- Vendor marked.min.js and pdf.js (+ worker) into site/rekindle/vendor/ and reference
  them locally. Nothing loads from jsdelivr/cloudflare. Verify chat markdown + PDF
  still render with the machine's internet route disabled (LAN-only).

STEP 2 — E-ink display correctness:
- Remove the prefers-color-scheme dark path; default to light/high-contrast. Make dark
  an explicit manual toggle if wanted at all.
- Add a "Refresh screen" button that forces a full e-ink repaint to clear ghosting.
- Remove index.html's 30s setInterval health poll; check health on load + a manual
  reconnect tap only.
- Prefer batched, discrete UI updates over continuous repaint (e.g. chat "thinking"
  state should not churn the screen).

STEP 3 — Reader as a real e-reader:
- Add tap-zone paging: left third = previous page, right third = next page, center =
  toggle toolbar. Apply to BOTH the PDF path and the text/markdown path.
- Paginate markdown/text into screen-sized pages (no infinite scroll on e-ink).
- Persist reading position per file (page index) in localStorage; restore on reopen,
  and show a "resume" affordance in the file list.
- On load error, fall back to the cached copy (bridge.cache) and label it clearly as
  offline/cached.

STEP 4 — Benny integration (the actual point):
- Fix chat.html (around lines 96-99): render RAG sources, don't just count them. Show
  each source as a tappable citation that opens reader.html at that document.
- Add an "Ask Benny about this document" action in the reader that opens chat.html with
  the current file preloaded as RAG context (pass workspace + doc id through).

STEP 5 — Auth: stop shipping the Benny key; go same-origin (NO server code needed):
- The server ALREADY exposes a same-origin, key-injecting Benny proxy: router.js routes
  /api/runtime/<path> -> proxyToRuntime (server/lib/runtime_proxy.js), which injects the
  trusted X-Benny-API-Key server-side and forwards to http://127.0.0.1:8005/api/<path>.
  /reader/* is served by the SAME origin (router.js ~line 442). Do NOT build a new proxy.
- Change space-bridge.js ONLY:
  * bennyRequest(): target same-origin. Rewrite the Benny path's leading "/api/" to
    "/api/runtime/" (e.g. "/api/chat/query" -> "/api/runtime/chat/query",
    "/api/health" -> "/api/runtime/health"), use cfg.spaceUrl (same-origin) as the base,
    add credentials:'include', and DELETE the client-side X-Benny-API-Key header — the
    proxy supplies it. The Benny key must never reach the Scribe.
  * workspaceFiles.upload(): same rewrite -> `${spaceUrl}/api/runtime/files/upload`,
    credentials:'include', no key header.
  * logs.connect() EventSource: use `${spaceUrl}/api/runtime/live/logs?...` (same-origin
    cookies are sent automatically).
- Settings page: the "Benny API URL" and "Benny API Key" fields are now unnecessary for
  the default path — remove them, or keep them behind an "Advanced / direct :8005
  override" toggle only.
- Space Agent's own session cookie already flows same-origin, so page + API auth are
  covered by one login. Confirm whether /api/runtime/* requires the session cookie; if
  so and the Scribe has no session yet, add a minimal login path (or document how the
  Scribe logs in on the LAN). /reader/* itself is public by design.
- Verify: from the SCRIBE browser, (a) load /reader, (b) make one Benny call
  (e.g. chat) and confirm it succeeds with NO api key stored on the device, (c) confirm
  the network tab shows same-origin /api/runtime/* requests, not :8005.

STEP 6 — Pen annotation -> PDF -> vision ingestion (phased; do Phase 1 first):
- The ingestion pipeline ALREADY EXISTS. Do not rebuild it. Chain:
    upload -> POST /api/vision/docmodel -> POST /api/vision/enrich -> POST /api/rag/ingest
  (enrich drops enriched markdown into data_in/ which rag/ingest consumes).
- Phase 1 (ship this): add a one-tap "Ingest this PDF" action in ReKindle that takes an
  annotated PDF (from the Scribe's NATIVE markup export / a watched LAN folder), runs the
  chain above, and reports the resulting labels/relationships back to the user. Verify
  end-to-end with a real hand-annotated multi-page PDF; confirm the enrich describer
  actually captures the HANDWRITTEN notes (not just printed text) in the output markdown.
- Phase 2 (prototype, then decide): in-browser inking. Render each page with the
  (vendored) pdf.js, overlay a transparent per-page annotation canvas matching that
  page's layout, capture pointerType:"pen" strokes, stamp them onto the original pages
  with (vendored) pdf-lib, emit a new PDF, then feed Phase 1's chain. Before building
  fully, prototype the inking latency on the actual Scribe browser and report whether it
  is usable (no native low-latency ink path exists for web pages on e-ink) — recommend
  keep vs. stay-native based on that evidence.

STEP 7 — Device tiers + e-ink graphs (adopt the proven dashboard pattern):
- The LONGVIEW dashboard (scratch/longview_run/dashboard/dashboard.html) already renders
  on the Kindle: inline hand-drawn SVG donuts/arcs, no chart libs, no canvas, no CDN,
  fetching a precomputed dashboard.json. This is the ONLY sanctioned graph approach for
  e-ink. Never ship force-graph/kg3d/canvas charts to the lite tier.
- Add a rendering tier to rekindle_config: "lite" (e-ink) vs "full" (PC). Detect via
  capability probe + UA hint (Kindle), but ALWAYS provide a manual override in Settings.
- lite tier: static monochrome SVG, discrete zoom steps, tap-to-drill (tap a node/segment
  -> paged detail list), no polling loops, no animation. full tier: link out to the real
  Space Agent app.
- Add a "Dashboard" tile to index.html. Either proxy the existing longview dashboard
  under the portal origin (/reader/dash -> :8788, or serve its files same-origin) or
  port its SVG pattern natively into a rekindle page fed by /api/runtime data. Prefer
  same-origin — do not leave a second unauthenticated 0.0.0.0:8788 origin as the
  long-term answer.
- For knowledge-graph views on lite: server precomputes aggregates/layout (e.g. the lean
  /api/graph/knowledge macro mode) into small JSON; client renders static SVG. Cap node
  counts hard; page the rest.

STEP 8 — Mission Control: remote actions from the Kindle (human facade, allowlisted):
- Principle: ADR-001 blocks AGENTS from executing; an authenticated HUMAN driving the
  /api/runtime/* facade from the Kindle is the human path — remote control is in-bounds.
  But /reader/* is public, so control is gated hard:
  * A fixed server-side ACTION REGISTRY: action name -> predefined command. The browser
    sends only the action name (+ a registered manifest id where applicable). NO
    arbitrary shell, NO client-supplied arguments beyond registry-validated enums.
  * Session-authenticated (same-origin cookie per Step 5) — actions 401 without login.
  * Every invocation AUDITED (who/when/what/result) and the audit log visible in the
    portal.
  * Two-tap confirm on e-ink (tap action -> confirmation screen -> execute) — stray
    taps are real on touch e-ink.
- Registry v1 (propose, confirm with me before wiring): start/stop LONGVIEW collector,
  run a LONGVIEW phase, ingest-this-PDF (reuses Step 6), restart Benny runtime, run a
  REGISTERED manifest by id. Show live status via the existing /api/runs + progress.json
  earned-ETA pattern, rendered lite-tier (text + SVG arc, manual/slow refresh).
- Verify from the Scribe: fire one harmless action (e.g. collector start) end-to-end,
  show the audit entry, and show an unauthenticated request being rejected.

Constraints: keep the no-build, single-purpose, System-7 philosophy; vendor every dep
(no CDN). Deliverable: for each step, state what changed and how you verified it on the
Scribe browser (or a faithful e-ink emulation). Explicitly call out anything you could
not verify — especially Phase 2 inking feel and the describer's handwriting fidelity.
```
