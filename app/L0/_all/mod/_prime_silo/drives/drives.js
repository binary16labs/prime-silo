// Drives — four same-origin reads of the hub's library routes, and nothing else.
//
// IT NEVER TOUCHES A FILE OR A CATALOGUE. Every figure on this page came from the rollup the
// worker built, which is why the page still answers with the drive unplugged. The hub is also the
// one place the owner's quarantine rules are applied, so a second reader here would be a second
// judge of them.
const API = "/api/estate/library";

const read = async (url) => {
  try {
    const res = await fetch(url);
    const body = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, ...body };
  } catch (e) {
    return { ok: false, status: 0, error: `the hub did not answer (${e?.message || e})` };
  }
};

// globalThis rather than window: the same object in a browser, and it lets the judgements below be
// tested without a DOM, which is how every other panel in this repo is tested.
globalThis.drivesPage = function drivesPage() {
  return {
    roots: [],
    root: "",
    view: null,
    where: null,
    problem: "",

    async init() {
      const s = await read(API);
      if (!s.ok) return (this.problem = s.error || "the library could not be read");
      this.roots = s.roots ?? [];
      if (this.roots.length) await this.open(this.roots[0], "");
    },

    async open(root, at) {
      this.root = root;
      this.where = null;
      this.problem = "";
      const r = await read(
        `${API}/folder?root=${encodeURIComponent(root)}&path=${encodeURIComponent(at)}`
      );
      if (r.ok) {
        this.view = r;
        return;
      }
      this.view = null;
      // every refusal is relayed in the hub's own words. 202 is not a failure and not an empty
      // folder: the worker is still building the rollup, and saying so beats showing nothing.
      this.problem =
        r.status === 202
          ? "Still being worked out — this drive's folder figures are being built. Try again in a minute."
          : r.error || `the hub answered ${r.status}`;
    },

    async askWhere() {
      const at = this.view?.at ?? "";
      const r = await read(
        `${API}/neighbours?root=${encodeURIComponent(this.root)}&path=${encodeURIComponent(at)}`
      );
      this.where = r.ok ? r : { where: [], withheld: 0 };
      if (!r.ok) this.problem = r.error || `the hub answered ${r.status}`;
    },

    // --- what the numbers say, in words the owner can act on --------------------------------
    size(n) {
      const b = Number(n) || 0;
      for (const [unit, at] of [
        ["TB", 1e12],
        ["GB", 1e9],
        ["MB", 1e6],
        ["kB", 1e3]
      ])
        if (b >= at) return `${(b / at).toFixed(b / at < 10 ? 1 : 0)} ${unit}`;
      return `${b} bytes`;
    },

    count(n) {
      return (Number(n) || 0).toLocaleString();
    },

    // The two figures stay apart on purpose. "all of it exists elsewhere" is the only line that
    // invites retiring a whole tree; "reclaimable inside" is a different job on the same folder.
    dupLine(f) {
      if (f.all_elsewhere) return "all of it exists elsewhere";
      const parts = [];
      if (f.dup_out_bytes > 0) parts.push(`${this.size(f.dup_out_bytes)} elsewhere`);
      if (f.dup_in_bytes > 0) parts.push(`${this.size(f.dup_in_bytes)} inside`);
      return parts.join(" · ");
    },

    ageLine() {
      const at = this.view?.self?.finishedAt ?? this.view?.finishedAt;
      if (!at) return "";
      const days = Math.floor((Date.now() - new Date(at).getTime()) / 86_400_000);
      return days > 0
        ? `as catalogued ${days} day${days === 1 ? "" : "s"} ago`
        : "catalogued today";
    }
  };
};
