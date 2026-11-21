// Episodes: one card per stretch of a long-running session, not one per session.
//
// Why (found 2026-11-21): the owner's main sessions run for weeks (one spans
// 26 active days, 14,096 steps, 1,001 operator inputs). The map phase walked it
// in windows but assembleCard keeps the FIRST 6 decisions / 12 concepts, and the
// walk read only the first 5,000 timeline nodes, so everything after the first
// days (home/repo setup, the dual brain, the estate contracts) never reached a
// card, the graph or the book. One card per session also dates the whole thing
// to one month.
//
// An episode is a run of consecutive active days (days with operator input),
// closed once it holds >= minInputs operator inputs. A short trailing run is
// merged into the episode before it. Ranges tile the whole timeline (first
// episode open at the start, last open at the end), so every step and every
// window lands in exactly one episode.
//
// Ids are stable as the session grows: an episode is named by its parent and
// its first day. Its `sig` (range + last step) changes when its content does,
// which is how map knows to re-assemble it.
import crypto from "crypto";

export const MIN_EPISODE_INPUTS = 8;

const dayOf = (ts) => new Date(Number(ts)).toISOString().slice(0, 10);
const dayStart = (day) => Date.parse(`${day}T00:00:00.000Z`);

// timeline: memo-ray entities (any order). Returns [] when the session is a
// single episode (nothing to split).
export function planEpisodes(timeline, { minInputs = MIN_EPISODE_INPUTS } = {}) {
  const perDay = new Map();
  let lastTs = 0;
  for (const e of timeline || []) {
    const ts = Number(e?.timestamp) || 0;
    if (!ts) continue;
    if (ts > lastTs) lastTs = ts;
    if (e.type !== "User Input") continue;
    const d = dayOf(ts);
    perDay.set(d, (perDay.get(d) || 0) + 1);
  }
  const days = [...perDay.keys()].sort();
  const groups = [];
  let cur = null;
  for (const d of days) {
    if (!cur) cur = { days: [], inputs: 0 };
    cur.days.push(d);
    cur.inputs += perDay.get(d);
    if (cur.inputs >= minInputs) {
      groups.push(cur);
      cur = null;
    }
  }
  if (cur) {
    if (groups.length) {
      const prev = groups[groups.length - 1];
      prev.days.push(...cur.days);
      prev.inputs += cur.inputs;
    } else groups.push(cur);
  }
  if (groups.length < 2) return [];
  return groups.map((g, i) => ({
    index: i,
    first_day: g.days[0],
    last_day: g.days[g.days.length - 1],
    inputs: g.inputs,
    // [from, to): from the first day's midnight to the next episode's first day.
    from: i === 0 ? 0 : dayStart(g.days[0]),
    to: i === groups.length - 1 ? Infinity : dayStart(groups[i + 1].days[0]),
    last_ts: lastTs
  }));
}

// 32 hex chars like every other sid, so sid8 citations stay distinct per episode.
export function episodeId(parentId, firstDay) {
  return crypto.createHash("md5").update(`${parentId}|episode|${firstDay}`).digest("hex");
}

export const inEpisode = (ts, ep) => {
  const t = Number(ts) || 0;
  return t >= ep.from && t < ep.to;
};

// Changes whenever the episode's content can have changed: its range moved, or
// (for the open last episode) new steps arrived.
export function episodeSig(ep, timeline) {
  let n = 0;
  let last = 0;
  for (const e of timeline || []) {
    const ts = Number(e?.timestamp) || 0;
    if (ts && inEpisode(ts, ep)) {
      n++;
      if (ts > last) last = ts;
    }
  }
  return `${ep.first_day}..${ep.last_day}|${n}|${last}`;
}
