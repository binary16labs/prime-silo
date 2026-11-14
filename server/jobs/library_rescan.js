// S23: the catalogue keeps itself current. Every 15 minutes this asks the estate API which attached,
// already-catalogued drive is due and lets the hub's own librarian rescan it - one drive per tick,
// single flight with the Catalogue button. Off unless ESTATE_LIBRARY_RESCAN_HOURS is above 0 and
// ESTATE_STORE is set. It never decides anything itself: rescanDue owns "which drive, and why not".
import { JobBase } from "./job_base.js";

const TICK_MS = 15 * 60_000;
const hoursOf = (context) =>
  Number(context?.runtimeParams?.get?.("ESTATE_LIBRARY_RESCAN_HOURS", 0)) || 0;
const storeOf = (context) => String(context?.runtimeParams?.get?.("ESTATE_STORE", "") || "");

export default class LibraryRescanJob extends JobBase {
  isEnabled(context) {
    return hoursOf(context) > 0 && storeOf(context) !== "";
  }

  getSchedule() {
    return { everyMs: TICK_MS, lockTtlMs: TICK_MS };
  }

  async run(context, { now = Date.now } = {}) {
    const estate = context?.services?.estate;
    if (!estate?.rescanDue)
      return { skipped: [{ root: null, why: "the estate API is not up yet" }] };
    const r = await estate.rescanDue({ hours: hoursOf(context), now: now() });
    // the job runner passes no logger; a skip is still said, never swallowed
    for (const s of r.skipped) console.log(`[library_rescan] ${s.root ?? "-"}: skipped - ${s.why}`);
    for (const root of r.started)
      console.log(`[library_rescan] ${root}: rescan started by the schedule`);
    return r;
  }
}
