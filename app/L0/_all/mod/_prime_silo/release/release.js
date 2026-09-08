// Release — the publish gate, drawn from the ledgers and the live feeds.
//
// This view can raise a proposal and it can act on one somebody signed. It cannot sign. That is
// not a policy this file enforces with a check; there is simply no code here that writes a
// signature, and the endpoint it calls refuses without one. A page that could both propose and
// approve would make the signature a formality performed by whoever happened to open the tab.
//
// REFRESH IS DELIBERATELY SLOW. The GitHub half is cached server-side for five minutes because
// unauthenticated GitHub allows sixty requests an hour per address and this check spends four.
// Polling harder would spend the budget and then report "cannot tell" for the rest of the hour,
// which is the surface breaking the check it exists to perform.

window.releasePage = function releasePage() {
  return {
    s: {},
    loading: true,
    busy: false,
    said: "",

    async init() {
      await this.refresh();
      // One slow beat. The answer behind this page changes when a release is cut, not second
      // to second, and the age line says how old it is rather than implying it is live.
      setInterval(() => this.refresh(), 60000);
    },

    async refresh() {
      try {
        const res = await fetch("/api/release_state");
        this.s = await res.json();
      } catch (e) {
        // A failed fetch is "cannot tell", never a clean bill.
        this.s = { reachable: false, reason: `the estate did not answer: ${e.message}` };
      } finally {
        this.loading = false;
      }
    },

    verdict() {
      if (!this.s.reachable) return "cannot tell";
      const state = this.s.health?.state;
      return (
        {
          covered: "every arch listed",
          degraded: "recoverable gap",
          stranded: "someone gets the wrong installer",
          partial: "partly unreadable",
          none: "nothing published"
        }[state] || state || "unknown"
      );
    },

    ageLine() {
      const a = this.s.age_seconds;
      if (a == null) return "";
      if (a < 60) return `checked ${a}s ago`;
      return `checked ${Math.round(a / 60)}m ago`;
    },

    /** The proposal that authorises a given tag, or null. Matched on the tag the server
     *  recovered from the proposal id, so the pairing is not re-derived in two places. */
    proposalFor(tag) {
      return (this.s.publish?.proposals || []).find((p) => p.tag === tag) || null;
    },

    canPublish(tag) {
      return Boolean(this.proposalFor(tag)?.state === "signed" && this.s.publish?.armed);
    },

    async raise(tag) {
      this.busy = true;
      this.said = "";
      try {
        const id = `release-${tag.replace(/^v/, "").replace(/\./g, "-")}`;
        const res = await fetch("/api/gov_raise", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            proposalId: id,
            title: `Publish release ${tag}`,
            rationale:
              `${tag} is tagged but no release was created, so every installed app is still ` +
              `reading the feed on the previous release.`,
            evidence: [".github/workflows/release-desktop.yml"]
          })
        });
        const out = await res.json();
        this.said = out.ok
          ? `Raised. It is asking, not authorising — sign it in the Gov arc.`
          : `Could not raise: ${out.error}`;
      } catch (e) {
        this.said = `Could not raise: ${e.message}`;
      } finally {
        this.busy = false;
        await this.refresh();
      }
    },

    async publish(tag) {
      this.busy = true;
      this.said = "";
      try {
        const res = await fetch("/api/release_publish", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ tag })
        });
        const out = await res.json();
        // Success here means GitHub accepted the dispatch, not that a release exists. Saying
        // "published" would be a claim about six builds that have not run yet.
        this.said = out.ok
          ? `${out.note}. Recorded as ${out.run}.`
          : `Refused: ${out.error}${out.hint ? ` — ${out.hint}` : ""}`;
      } catch (e) {
        this.said = `Could not publish: ${e.message}`;
      } finally {
        this.busy = false;
        await this.refresh();
      }
    }
  };
};
