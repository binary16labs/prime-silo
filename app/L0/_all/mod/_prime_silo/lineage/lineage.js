// Lineage — the evidence spine (#/_prime_silo/lineage).
//
// Read side of SS1/23 Principle 1. The browser folds nothing: the server reads the ledgers,
// verifies each chain, and hands over both the rows and the coverage. A surface that computed
// its own coverage could disagree with the evidence pack about the same estate, and then
// neither number would be worth anything.
//
// Three states are first-class rather than errors, because each is a different truth and the
// operator must never see one dressed as another:
//   - no store at all      (zero out of zero is an absent record, not a clean one)
//   - a ledger that broke  (its subjects are shown, and never counted)
//   - nothing recorded yet (says nothing about what the estate did, only what it wrote down)

const CALM = () =>
  matchMedia("(prefers-reduced-motion: reduce)").matches ||
  document.documentElement.dataset.profile === "zen";

async function readJson(res) {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

const EMPTY_COVERAGE = {
  ledgers: { total: 0, verified: 0, broken: 0, broken_names: [] },
  subjects: { total: 0, attested: 0, quarantined: 0 },
  kinds: {},
  authorship: { human: 0, frontier: 0, house: 0 },
  provenance: { linked: 0, unprovenanced: 0, dangling: 0, ratio: null },
  completeness: { state: "not measurable", why: "" }
};

window.lineagePage = function lineagePage() {
  return {
    state: "loading", // loading | ready | error
    error: "",
    store: { root: "", source: "", exists: true },
    ledgers: [],
    subjects: [],
    c: EMPTY_COVERAGE,
    kind: "", // active kind filter
    sid: "", // selected subject
    trail: null,
    step: 1,

    async init() {
      await this.load();
      // Arrow keys walk the trail. Bound on the document rather than a wrapper so it works
      // wherever focus happens to be in the pane — but never while the operator is typing.
      document.addEventListener("keydown", (e) => {
        if (!this.trail) return;
        const t = e.target;
        if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
        if (e.key === "ArrowLeft") this.go(this.step - 1);
        else if (e.key === "ArrowRight") this.go(this.step + 1);
      });
    },

    async load() {
      try {
        const res = await fetch("/api/lineage_index", { headers: { Accept: "application/json" } });
        const data = await readJson(res);
        if (!res.ok || !data) {
          this.state = "error";
          this.error = `Could not read the estate ledgers (HTTP ${res.status}).`;
          return;
        }
        this.store = data.store || this.store;
        this.ledgers = data.ledgers || [];
        this.subjects = data.subjects || [];
        this.c = data.coverage || EMPTY_COVERAGE;
        this.state = "ready";
      } catch (e) {
        this.state = "error";
        this.error = `Could not reach the server: ${e.message}`;
      }
    },

    get broken() {
      return this.ledgers.filter((l) => !l.ok);
    },

    get kinds() {
      return Object.keys(this.c.kinds || {}).sort();
    },

    visible() {
      return this.kind ? this.subjects.filter((s) => s.kind === this.kind) : this.subjects;
    },

    // Benny speaks plainly and in the first person, and does not congratulate the estate for
    // a clean sweep of an empty store.
    bennyLine() {
      if (this.state === "loading") return "Let me fold the ledgers together.";
      if (this.state === "error") return "I could not read the ledgers.";
      if (!this.store.exists) return "I could not find an estate store to read.";
      const n = this.c.subjects.total;
      if (n === 0) return "The store is here, but nothing has been written to it yet.";
      const broken = this.c.ledgers.broken;
      if (broken) return `I folded ${n} subjects, but ${broken} ledger(s) no longer verify.`;
      if (this.c.provenance.linked === 0)
        return `${n} subjects, every chain intact — though not one of them records where it came from.`;
      return `${n} subjects across ${this.c.ledgers.verified} verified ledgers.`;
    },

    short(sid) {
      // Content hashes are long and the interesting end is the front; keep the kind prefix
      // and enough hash to be unambiguous rather than truncating blindly at a width.
      return sid.length > 52 ? sid.slice(0, 49) + "…" : sid;
    },

    authorshipLine(a) {
      const parts = Object.entries(a || {})
        .filter(([, n]) => n > 0)
        .map(([k, n]) => `${k} ${n}`);
      return parts.length ? parts.join(" · ") : "none recorded";
    },

    pretty(v) {
      if (v == null) return "—";
      try {
        return JSON.stringify(v, null, 2);
      } catch {
        return String(v);
      }
    },

    current() {
      if (!this.trail) return null;
      return this.trail.steps[this.step - 1] || null;
    },

    go(n) {
      if (!this.trail) return;
      const max = this.trail.steps.length;
      this.step = Math.min(Math.max(1, n), max);
    },

    async open(sid) {
      this.sid = sid;
      this.trail = null;
      this.step = 1;
      try {
        const res = await fetch(`/api/lineage_trail?sid=${encodeURIComponent(sid)}`, {
          headers: { Accept: "application/json" }
        });
        const data = await readJson(res);
        if (!res.ok || !data?.ok) {
          this.error = data?.error || `Could not read that trail (HTTP ${res.status}).`;
          this.state = "error";
          return;
        }
        this.trail = data.trail;
        // Open on the LAST step: you come to lineage because something just happened, and the
        // most recent event is the one you came to see. The whole history is one click back.
        this.step = this.trail.steps.length || 1;
        if (!CALM()) {
          // Feedback that the selection landed — a single frame's nudge, not an entrance.
          this.$nextTick(() => {
            const el = document.querySelector(".prime-silo-lin__event");
            if (el && typeof el.scrollIntoView === "function")
              el.scrollIntoView({ block: "nearest", behavior: "smooth" });
          });
        }
      } catch (e) {
        this.state = "error";
        this.error = `Could not reach the server: ${e.message}`;
      }
    }
  };
};
