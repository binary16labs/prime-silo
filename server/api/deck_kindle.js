// GET /api/deck_kindle — the deck as a page a Kindle can hold.
//
// The fourth tier, and the one that could not be a breakpoint. Wall, column and pocket are the
// same document reflowing; a Kindle is a different machine. Its browser has no container
// queries, no Alpine, no fetch worth relying on, and a screen that costs a visible flash to
// repaint. So this route renders the board on the SERVER and ships finished HTML: no script
// tag, no stylesheet request, nothing to hydrate. It is the tier that still works when the
// deck's whole client stack is unavailable, which also makes it the honest fallback surface.
//
// IT RENDERS THE SAME FOLD. The numbers come from deck_state's own handler, not a second query
// against the ledgers, because two readers of one truth eventually disagree and the version on
// a device in someone's hand is the one nobody checks.
//
// NO COLOUR, DELIBERATELY. E-ink is grey and dithers badly, so state is carried by words and by
// inversion — an alert row is white on black, which is the one thing the panel renders crisply.
// That puts this page outside the estate's colour tokens on purpose rather than by neglect: it
// is not part of the C0 palette because it is not rendering on a colour display.
//
// IT IS NOT ANONYMOUS, AND THAT IS A REAL CONSTRAINT. This route authenticates like every
// other API route: no `allowAnonymous`, deliberately, because these are the estate's governance
// figures and the server can be bound to the LAN. So on an installation with a password set,
// the device has to carry a session — a Kindle's browser can hold a cookie, but it cannot be
// expected to complete the app's challenge login. Read the board there by logging in once on
// the device, or not at all; the answer is never to open the route up.
//
// A STALE PAGE IS THE REAL HAZARD HERE. A Kindle will happily display this for six hours after
// the estate stopped reporting. The reading time is stated in words at the top of the page, the
// document refreshes itself on a slow timer, and the age of the last event is printed rather
// than implied — an old picture that says how old it is is still evidence.
import { get as deckState } from "./deck_state.js";

const REFRESH_SECONDS = Number(process.env.DECK_KINDLE_REFRESH || 300);

const esc = (v) =>
  String(v ?? "").replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]
  );

function age(seconds) {
  if (seconds == null) return "no events yet";
  if (seconds < 90) return `${seconds} seconds ago`;
  const m = Math.round(seconds / 60);
  if (m < 90) return `${m} minutes ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} hours ago` : `${Math.round(h / 24)} days ago`;
}

function row({ label, figure, unit, detail, alert }) {
  return `<div class="row${alert ? " row--alert" : ""}">
      <p class="label">${esc(label)}</p>
      <p class="figure">${esc(figure)}</p>
      <p class="unit">${esc(unit)}</p>
      <p class="detail">${esc(detail)}</p>
    </div>`;
}

function page(body, { room }) {
  // The stylesheet is inline and small on purpose: a Kindle over a slow link should paint once.
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="${REFRESH_SECONDS}">
<title>Estate — Prime-Silo</title>
<style>
  html { -webkit-text-size-adjust: 100%; }
  body { margin: 0; padding: 24px 20px 32px; background: #fff; color: #000;
         font-family: Georgia, "Times New Roman", serif; font-size: 20px; line-height: 1.5; }
  .head { border-bottom: 3px solid #000; padding-bottom: 10px; margin-bottom: 4px; }
  .head h1 { font-size: 30px; margin: 0 0 4px; letter-spacing: 0.02em; }
  .head p { margin: 0; font-size: 17px; }
  .row { border-bottom: 1px solid #000; padding: 16px 0 14px; }
  /* Inversion, not colour: the one emphasis an e-ink panel renders without dithering. */
  .row--alert { background: #000; color: #fff; padding-left: 12px; padding-right: 12px; }
  .label { margin: 0; font-family: "Helvetica Neue", Helvetica, Arial, sans-serif;
           font-size: 15px; letter-spacing: 0.14em; text-transform: uppercase; }
  .figure { margin: 2px 0 0; font-size: 58px; line-height: 1.05; font-weight: bold; }
  .unit { margin: 0; font-size: 20px; }
  .detail { margin: 6px 0 0; font-size: 17px; }
  .foot { margin-top: 18px; font-size: 16px; }
  .foot p { margin: 0 0 6px; }
  .blind { border: 3px solid #000; padding: 16px; }
  .blind strong { display: block; font-size: 24px; margin-bottom: 6px; }
</style>
</head>
<body>
${body}
<div class="foot">
  <p>Refreshes itself every ${Math.round(REFRESH_SECONDS / 60)} minutes. Nothing on this page can be signed from it.</p>
  <p>${room ? "Room mode: names and titles hidden." : "Full detail. Add ?room=1 to hide names and titles."}</p>
</div>
</body>
</html>`;
}

export async function get(context) {
  const room = String(context?.query?.room ?? "") === "1";
  const { body: s } = await deckState();

  // Read this on a device, hours later, in a different building: the time has to be words.
  const at = new Date(s.at);
  const stamp = at.toLocaleString("en-GB", {
    weekday: "long",
    hour: "2-digit",
    minute: "2-digit"
  });

  if (s.blind) {
    return html(
      page(
        `<div class="head"><h1>Estate</h1><p>Read at ${esc(stamp)}</p></div>
         <div class="blind"><strong>Not reporting</strong><p>${esc(s.reason)}</p>
         <p>This is not a healthy estate with nothing to say. It is a deck that cannot see.</p></div>`,
        { room }
      )
    );
  }

  const oldest = s.decide.oldest;
  const rows = [
    row({
      label: "Decide",
      figure: s.decide.waiting,
      unit: s.decide.waiting === 1 ? "proposal waiting on you" : "waiting on you",
      detail: oldest
        ? room
          ? "oldest proposal — title hidden in room mode"
          : `oldest: ${oldest.title}`
        : `${s.decide.signed} signed · nothing outstanding`,
      alert: s.decide.waiting > 0
    }),
    row({
      label: "Prove",
      figure: `${s.prove.origin_recorded}/${s.prove.subjects}`,
      unit: "subjects with their origin recorded",
      detail: `${s.prove.ledgers}/${s.prove.ledgers_total} ledgers verify · world ${s.prove.world}`,
      alert: s.prove.broken.length > 0
    }),
    row({
      label: "Watch",
      figure: `${s.watch.nodes.filter((n) => !n.blind).length}/${s.watch.nodes.length}`,
      unit: "nodes reporting",
      detail:
        s.watch.nodes
          .map((n) => {
            const name = room ? `${String(n.machine || "?")[0].toUpperCase()}…` : n.machine;
            return `${name}: ${n.blind ? "not heard from" : "up"}`;
          })
          .join(" · ") || "no nodes known",
      alert: s.watch.nodes.some((n) => n.blind)
    }),
    row({
      label: "Run",
      figure: `${s.run.unauthorised}/${s.run.in_scope}`,
      unit: "runs without a signed proposal",
      detail: "a count without its population is not a measurement",
      alert: s.run.unauthorised > 0
    })
  ].join("\n");

  return html(
    page(
      `<div class="head">
         <h1>Estate</h1>
         <p>Read at ${esc(stamp)} · last event ${esc(age(s.pulse.seconds_since))}</p>
       </div>
       ${rows}`,
      { room }
    )
  );
}

function html(text) {
  return {
    headers: { "Cache-Control": "no-store", "Content-Type": "text/html; charset=utf-8" },
    status: 200,
    body: Buffer.from(text, "utf8")
  };
}
