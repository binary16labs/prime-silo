// Estate Map — the panel. Every judgement lives in fold_view.js, which is tested without a DOM;
// this file fetches, holds state and hands the view a shape to draw.
//
// IT READS THE FOLD AND NOTHING ELSE. §5 of the plan gives this surface one source, /api/estate/map,
// and one job: show what the nodes said. There is no button here that changes anything — moving
// bytes is S7's executor and needs a signature, and a page that could both show and act would make
// the signature a formality performed by whoever had the tab open.
//
// REFRESH IS SLOW ON PURPOSE. The answer behind this page changes when a node finishes a sweep and
// pushes, which is minutes apart at best. Polling harder would imply the page is live when it is a
// fold of pushes, and the age line would start contradicting the refresh rate.
import { ageLabel, byteLabel, estateView, treemap } from "/mod/_prime_silo/estate_map/fold_view.js";

const REFRESH_MS = 60_000;

window.estateMapPage = function estateMapPage() {
  return {
    v: { reachable: false, machines: [] },
    loading: true,
    tab: "estate",
    rects: [],

    async init() {
      // The treemap is laid out against the element's REAL width, so it must be recomputed
      // whenever that width can change — including when the tab becomes visible at all. A hidden
      // element measures zero, and laying out on load alone drew an empty map beside a full
      // legend: the panel telling two different stories about the same bytes.
      //
      // Registered BEFORE the first await: a $watch set up after one does not fire.
      this.$watch("tab", () => this.$nextTick(() => this.layout()));
      window.addEventListener("resize", () => this.layout());
      await this.refresh();
      setInterval(() => this.refresh(), REFRESH_MS);
    },

    async refresh() {
      try {
        const res = await fetch("/api/estate/map");
        if (!res.ok) throw new Error(`the hub answered ${res.status}`);
        this.v = estateView(await res.json());
      } catch (e) {
        // A failed fetch is "cannot tell", never an estate with nothing in it.
        this.v = estateView(null, { reason: `the hub did not answer: ${e.message}` });
      } finally {
        this.loading = false;
        this.layout();
      }
    },

    layout() {
      // queried from the component root rather than through $refs: the map lives inside an x-if
      // template, and a ref created in a template's scope is not on the component's $refs. It read
      // as undefined, which measured zero, which drew an empty map beside a full legend.
      const box = this.$el?.querySelector(".em__map")?.getBoundingClientRect?.();
      const w = Math.max(0, Math.floor(box?.width ?? 0));
      const h = Math.max(0, Math.floor(box?.height ?? 0));
      this.rects = w && h ? treemap(this.v.storage?.items ?? [], { x: 0, y: 0, w, h }) : [];
    },

    bytes: byteLabel,

    // "stale since 10:00" — the whole point of §7. A machine is never rendered as empty because it
    // went quiet, and the card says WHEN it went quiet rather than how long ago in the abstract.
    machineLine(m) {
      if (m.stale) return `stale since ${this.clock(m.since)} · ${m.ageLabel} ago`;
      return `swept ${m.ageLabel} ago`;
    },

    // a volume the newest sweep did not cover keeps its own age, so the card cannot imply that
    // every drive was looked at when the last sweep ran
    ageOf(vol) {
      return `${ageLabel(vol.ageMs)} ago`;
    },

    clock(iso) {
      if (!iso) return "an unknown time";
      const d = new Date(iso);
      return Number.isNaN(d.getTime())
        ? "an unknown time"
        : d.toLocaleString(undefined, { hour: "2-digit", minute: "2-digit", day: "numeric", month: "short" });
    },

    driftLine(row) {
      return Object.entries(row.byMachine)
        .map(([machine, versions]) => `${machine} ${versions.join(" / ")}`)
        .join(" · ");
    }
  };
};
