// Estate Map — the panel. Every judgement lives in fold_view.js, which is tested without a DOM;
// this file fetches, holds state and hands the view a shape to draw.
//
// IT READS THE FOLD, AND ITS ONE BUTTON MOVES NOTHING. §5 of the plan gives the map one source,
// /api/estate/map, and this surface one job: show what the nodes said. Sweep (S17) asks THIS machine
// to read its own disks and write its own map files (index, snapshot, map log); it changes no file the owner keeps. Moving bytes
// is S7's executor and needs a signature, and a page that could both show and act on the estate
// would make that signature a formality performed by whoever had the tab open.
//
// REFRESH IS SLOW ON PURPOSE. The answer behind this page changes when a node finishes a sweep and
// pushes, which is minutes apart at best. Polling harder would imply the page is live when it is a
// fold of pushes, and the age line would start contradicting the refresh rate. The one exception is
// a sweep THIS page started: it is watched every few seconds until it ends, then the map is re-read.
import {
  ageLabel,
  byteLabel,
  estateView,
  reconcile,
  storageRects,
  sweepView
} from "/mod/_prime_silo/estate_map/fold_view.js";

const REFRESH_MS = 60_000;
const SWEEP_WATCH_MS = 3_000;

window.estateMapPage = function estateMapPage() {
  // The component root, captured in init() and kept OUT of the reactive data. $el is resolved from
  // whichever element's expression is running, so layout() called from a tab button measured the
  // BUTTON, found no .em__map, and set rects to [] — clicking the open Storage tab wiped the
  // treemap while the reconciliation line beneath it still described the map that was no longer
  // there. One place owns the component scope now.
  let root = null;
  let watching = null;

  return {
    v: { reachable: false, empty: false, machines: [] },
    sw: sweepView(null),
    sweepError: "",
    loading: true,
    tab: "estate",
    rects: [],
    recon: { reported: 0, drawn: 0, tooSmall: 0, unsplit: 0, missing: 0 },

    async init() {
      // The treemap is laid out against the element's REAL width, so it must be recomputed
      // whenever that width can change — including when the tab becomes visible at all. A hidden
      // element measures zero, and laying out on load alone drew an empty map beside a full
      // legend: the panel telling two different stories about the same bytes.
      //
      // Registered BEFORE the first await: a $watch set up after one does not fire.
      root = this.$el;
      this.$watch("tab", () => this.$nextTick(() => this.layout()));
      window.addEventListener("resize", () => this.layout());
      await Promise.all([this.refresh(), this.refreshSweep()]);
      // The sweep line is re-read with the map. It used to be read once, so a page left open said
      // "finished moments ago" an hour later, beside a card that had moved on to "swept 1 hour ago".
      setInterval(() => Promise.all([this.refresh(), this.refreshSweep()]), REFRESH_MS);
    },

    async refreshSweep() {
      try {
        this.sw = sweepView(await (await fetch("/api/estate/sweep")).json());
      } catch {
        this.sw = sweepView(null);
      }
      clearTimeout(watching);
      if (this.sw.running)
        watching = setTimeout(async () => {
          await this.refreshSweep();
          if (!this.sw.running) await this.refresh();
        }, SWEEP_WATCH_MS);
    },

    async sweep(volume) {
      this.sweepError = "";
      try {
        const res = await fetch("/api/estate/sweep", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ volumes: [volume] })
        });
        if (!res.ok) this.sweepError = (await res.json().catch(() => ({}))).error || `the hub answered ${res.status}`;
      } catch (e) {
        this.sweepError = `the hub did not answer: ${e.message}`;
      }
      await this.refreshSweep();
      // a sweep small enough to finish before that read is never "watched", so the map that changed
      // would otherwise wait for the slow refresh (claude-s17-verifier)
      if (!this.sw.running) await this.refresh();
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
      // queried from the captured root rather than through $refs or $el: the map lives inside an
      // x-if template, so a ref created in that template's scope is not on the component's $refs,
      // and $el is whatever element's expression is currently running. Both read as undefined,
      // which measured zero, which drew an empty map beside a full legend.
      const el = root?.querySelector(".em__map");
      const box = el?.getBoundingClientRect?.();
      const w = Math.max(0, Math.floor(box?.width ?? 0));
      const h = Math.max(0, Math.floor(box?.height ?? 0));
      // A FAILED MEASUREMENT IS NOT AN EMPTY ESTATE, which is this panel's whole thesis applied to
      // itself. Clicking the Storage tab while it was already open used to call this from the tab
      // button's scope, where the map element is not reachable — and the old line turned that into
      // rects = [], wiping the picture while the reconciliation beneath it still described it. Now
      // the map keeps what it last drew until something can actually be measured.
      if (!w || !h) return;
      this.rects = storageRects(this.v.storage, { x: 0, y: 0, w, h });
      // counted off the rectangles that now exist, so the line under the map cannot describe a
      // picture the layout did not draw
      this.recon = reconcile(this.v.storage, this.rects);
    },

    bytes: byteLabel,

    n(x) {
      return (Number(x) || 0).toLocaleString();
    },

    // What is actually drawn, so the legend and the map cannot disagree: a volume the layout could
    // not give a visible rectangle is named instead of counted silently.
    drawn() {
      return this.rects.filter((r) => !r.tooSmall);
    },

    invisible() {
      return this.rects.filter((r) => r.tooSmall);
    },

    // "stale since 10:00" — the whole point of §7. A machine is never rendered as empty because it
    // went quiet, and the card says WHEN it went quiet rather than how long ago in the abstract.
    machineLine(m) {
      // since is when the hub last HEARD from it (S17); the age is the sweep's, and says so
      if (m.stale) return `stale since ${this.clock(m.since)} · swept ${m.ageLabel} ago`;
      return `swept ${m.ageLabel} ago`;
    },

    // "N nodes reporting" is a true sentence that reads as a false one when every node is quiet.
    reportingLine() {
      const n = this.v.machines.length;
      const noun = `${n} node${n === 1 ? "" : "s"}`;
      return this.v.allStale ? `${noun}, all of them stale` : `${noun} reporting`;
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

    // A rectangle says what unit it is in. The machine level is bytes, which the nodes reported;
    // the volume level is files, because per-volume bytes are not on the wire at all.
    rectSize(r) {
      return r.level === "machine" ? this.bytes(r.value) : `${this.n(r.files)} files`;
    },

    // The floor under a volume's real size: the bytes a node said it was withholding. A floor,
    // never the volume's size.
    floorLine(v) {
      return v.withheldBytes ? `at least ${this.bytes(v.withheldBytes)} withheld` : "";
    },

    // A block too small to see is named whatever level it is: a machine's whole reported size can
    // fall below a pixel beside a much larger one, and that is more bytes to lose than a volume.
    tooSmallLine(r) {
      return r.level === "machine"
        ? `${r.machine} — ${this.bytes(r.value)}, too small to draw at this size`
        : `${r.machine} ${r.volume} — ${this.n(r.files)} files, too small to draw at this size`;
    },

    unaccountedLine(u) {
      // a machine-level entry has no volume to name, and "optimus — — this node reported…" reads
      // like a missing word rather than a missing volume
      // a volume really named "—" is still a volume, so it is quoted rather than dropped; only an
      // entry with no volume at all names the machine alone
      const what = u.volume ? `${u.machine} ${JSON.stringify(u.volume)}` : u.machine;
      return [what, u.why, u.errorCode].filter(Boolean).join(" — ");
    },

    mediaLine(m) {
      if (!m.swept) return "has not swept media";
      return `${this.n(m.listed)} of ${this.n(m.found)} published`;
    }
  };
};
