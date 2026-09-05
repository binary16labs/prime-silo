// Gov — the signing queue (#/_prime_silo/gov).
//
// The read side of SS1/23 Principle 2, and the only surface in Prime-Silo where authorisation
// is granted. Everything it does is deliberately thin: the browser does not decide who signed,
// does not choose the authorship, and cannot append to the ledger itself. It asks the server,
// and the server writes the event.
//
// That thinness is the point. A queue that could set its own signer would make the register a
// text field with extra steps.
//
// Two states are first-class rather than errors: an empty queue (nothing is waiting on you) and
// a broken chain (nothing below is evidence). Neither should land the operator on a stack trace.

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

window.govPage = function govPage() {
  return {
    state: "loading", // loading | ready | error
    error: "",
    open: [],
    settled: [],
    counts: { open: 0, signed: 0, declined: 0 },
    chain: { ok: true, badLine: null },
    ledger: { file: "", root: "", source: "" },
    shown: "", // which card has its evidence disclosed
    note: "",
    noteFor: "",
    busy: false,
    settling: "",

    async init() {
      await this.load();
    },

    async load() {
      try {
        const res = await fetch("/api/gov_proposals", { headers: { Accept: "application/json" } });
        const data = await readJson(res);
        if (!res.ok || !data) {
          this.state = "error";
          this.error = `Could not read the governance ledger (HTTP ${res.status}).`;
          return;
        }
        this.open = data.open || [];
        this.settled = data.settled || [];
        this.counts = data.counts || this.counts;
        this.chain = data.chain || this.chain;
        this.ledger = data.ledger || this.ledger;
        this.state = "ready";
      } catch (e) {
        this.state = "error";
        this.error = `Could not reach the server: ${e.message}`;
      }
    },

    // Benny speaks plainly and in the first person; he never sells.
    bennyLine() {
      if (this.state === "loading") return "Let me fetch what is waiting on you.";
      if (this.chain.ok === false) return "I stopped — this ledger has been altered.";
      const n = this.open.length;
      if (n === 0) return "Nothing is waiting on you right now.";
      if (n === 1) return "One thing is waiting on your decision.";
      return `${n} things are waiting on your decision.`;
    },

    toggle(id) {
      this.shown = this.shown === id ? "" : id;
    },

    async decide(id, decision) {
      if (this.busy || this.chain.ok === false) return;
      this.busy = true;
      this.note = "";
      this.noteFor = id;
      try {
        const res = await fetch("/api/gov_sign", {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          // No signer is sent. The server takes the identity from the session; a signature the
          // client could name is not a signature.
          body: JSON.stringify({ proposalId: id, decision })
        });
        const data = await readJson(res);
        if (!res.ok || !data?.ok) {
          this.note = data?.error || `Could not record that (HTTP ${res.status}).`;
          return;
        }
        this.note = `${decision === "sign" ? "Signed" : "Declined"} as ${data.signer}.`;

        // Motion is feedback to what YOU just did, and nothing else. With reduced motion the
        // card simply disappears on reload — the resting state was always complete.
        if (!CALM()) {
          this.settling = id;
          await new Promise((r) => setTimeout(r, 450));
          this.settling = "";
        }
        await this.load();
      } catch (e) {
        this.note = `Could not reach the server: ${e.message}`;
      } finally {
        this.busy = false;
      }
    }
  };
};
