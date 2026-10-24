// The librarian's helper: four same-origin reads of the hub's library routes.
//
// IT NEVER TOUCHES THE FILE SYSTEM AND NEVER OPENS A CATALOGUE. The hub is the one place the owner's
// privacy rules are applied, before any name is returned; a helper that read the catalogue itself
// would be a second judge, one drift away from leaking a name the panel refuses to show.
const API = "/api/estate/library";
const qs = (o) =>
  Object.entries(o)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");

// A refusal carries its reason rather than throwing: "no finished catalogue" or "ESTATE_STORE is
// not set" IS the answer to relay.
const read = async (url, init) => {
  try {
    const res = await fetch(url, init);
    const body = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, ...body };
  } catch (e) {
    return { ok: false, status: 0, error: `the hub did not answer (${e?.message || e})` };
  }
};

export const status = () => read(API);

export const find = (root, q, { kind = "", limit = 50 } = {}) =>
  read(`${API}/find?${qs({ root, q, kind, limit, surface: "skill" })}`);

export const duplicates = (root, { offset = 0, limit = 20 } = {}) =>
  read(`${API}/duplicates?${qs({ root, offset, limit, surface: "skill" })}`);

export const check = (root, paths) =>
  read(`${API}/check`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ root, paths: Array.isArray(paths) ? paths : [paths], surface: "skill" })
  });
