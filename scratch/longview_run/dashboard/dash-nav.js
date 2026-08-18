/* Shared LONGVIEW dashboard nav — makes every page workspace- & run/iteration-aware.
 *
 * Sets window.DASH SYNCHRONOUSLY from the URL (?workspace=&run=&iteration=) so page
 * scripts can call DASH.url()/DASH.ws() immediately, and injects a compact sticky
 * selector bar on DOMContentLoaded (workspace + run/iteration + page links). When no
 * ?workspace is present the server falls back to its active workspace, so the default
 * (bare URL) shows the live active run — no async needed for correctness.
 *
 * ES5-only (no arrow fns / template literals): kindle.html runs on an e-ink browser.
 */
(function () {
  var p = new URLSearchParams(window.location.search);
  var workspace = p.get("workspace") || null; // null => server's active workspace
  var run = p.get("run") || null; // null/latest/live => the live run
  var iteration = p.get("iteration") || null;

  function qs(extra) {
    var u = new URLSearchParams();
    if (workspace) u.set("workspace", workspace);
    if (run) u.set("run", run);
    if (iteration) u.set("iteration", iteration);
    if (extra) {
      for (var k in extra) {
        if (extra[k] == null) u.delete(k);
        else u.set(k, extra[k]);
      }
    }
    return u.toString();
  }
  function url(base) {
    var q = qs();
    if (!q) return base;
    return base + (base.indexOf("?") >= 0 ? "&" : "?") + q;
  }
  function go(params) {
    var u = new URLSearchParams(window.location.search);
    for (var k in params) {
      if (params[k] == null || params[k] === "") u.delete(k);
      else u.set(k, params[k]);
    }
    window.location.search = u.toString();
  }

  var isHistorical = !!(run && run !== "latest" && run !== "live");
  window.DASH = {
    workspace: workspace,
    run: run,
    iteration: iteration,
    historical: isHistorical,
    qs: qs,
    url: url,
    go: go,
    ws: function () {
      return workspace || "";
    }
  };

  // ── selector bar ──────────────────────────────────────────────────────────
  function el(tag, attrs, text) {
    var e = document.createElement(tag);
    if (attrs) for (var k in attrs) e.setAttribute(k, attrs[k]);
    if (text != null) e.textContent = text;
    return e;
  }
  function fetchJSON(u, cb) {
    try {
      fetch(u, { cache: "no-store" })
        .then(function (r) {
          return r.json();
        })
        .then(function (d) {
          cb(null, d);
        })
        .catch(function (e) {
          cb(e, null);
        });
    } catch (e) {
      cb(e, null);
    }
  }

  var PAGES = [
    ["dashboard.html", "Mission"],
    ["lineage.html", "Lineage"],
    ["flywheel.html", "Flywheel"],
    ["estate.html", "Estate"],
    ["build.html", "Book"],
    ["kindle.html", "Kindle"],
    ["memory.html", "Memory"],
    ["control.html", "Control"]
  ];

  function build() {
    if (document.getElementById("dash-nav")) return;
    var css = document.createElement("style");
    css.textContent =
      "#dash-nav{position:sticky;top:0;z-index:9999;display:flex;flex-wrap:wrap;gap:10px;" +
      "align-items:center;padding:6px 12px;background:#12100c;border-bottom:1px solid #4a3f2a;" +
      "font:12px/1.4 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#d8cba8}" +
      "#dash-nav select{background:#1c1810;color:#eadfbf;border:1px solid #4a3f2a;border-radius:5px;" +
      "padding:3px 6px;font:inherit;max-width:46vw}" +
      "#dash-nav .lbl{color:#8f8874;opacity:.7;text-transform:uppercase;letter-spacing:.06em;font-size:10px}" +
      "#dash-nav .badge{padding:2px 8px;border-radius:10px;font-weight:600;font-size:10px;letter-spacing:.05em}" +
      "#dash-nav .live{background:#1b3a1f;color:#8fe39a;border:1px solid #2f6b39}" +
      "#dash-nav .hist{background:#3a2f14;color:#e8c766;border:1px solid #6b5726}" +
      "#dash-nav .links{margin-left:auto;display:flex;flex-wrap:wrap;gap:4px}" +
      "#dash-nav .links a{color:#c9b98a;text-decoration:none;padding:2px 7px;border-radius:5px;border:1px solid transparent}" +
      "#dash-nav .links a:hover{border-color:#4a3f2a;background:#1c1810}" +
      "#dash-nav .links a.on{background:#2a2416;color:#f0e6c4;border-color:#6b5726}";
    document.head.appendChild(css);

    var bar = el("div", { id: "dash-nav" });
    var badge = el("span", { class: "badge " + (isHistorical ? "hist" : "live") }, isHistorical ? "HISTORICAL" : "LIVE");

    var wsWrap = el("span");
    wsWrap.appendChild(el("span", { class: "lbl" }, "workspace "));
    var wsSel = el("select", { id: "dash-ws", title: "workspace" });
    wsWrap.appendChild(wsSel);

    var runWrap = el("span");
    runWrap.appendChild(el("span", { class: "lbl" }, "run "));
    var runSel = el("select", { id: "dash-run", title: "run / iteration" });
    runWrap.appendChild(runSel);

    var links = el("span", { class: "links" });
    var here = (window.location.pathname.split("/").pop() || "dashboard.html").toLowerCase();
    for (var i = 0; i < PAGES.length; i++) {
      var a = el("a", { href: url(PAGES[i][0]) }, PAGES[i][1]);
      if (PAGES[i][0] === here) a.className = "on";
      links.appendChild(a);
    }

    bar.appendChild(badge);
    bar.appendChild(wsWrap);
    bar.appendChild(runWrap);
    bar.appendChild(links);
    document.body.insertBefore(bar, document.body.firstChild);

    // Populate workspaces, then runs+iterations for the selected one.
    fetchJSON("/api/index", function (err, idx) {
      if (err || !idx) {
        wsSel.appendChild(el("option", { value: "" }, workspace || "(active)"));
        return;
      }
      var active = idx.active;
      var cur = workspace || active;
      var wss = idx.workspaces || [];
      for (var i = 0; i < wss.length; i++) {
        var o = el("option", { value: wss[i].name }, wss[i].name + (wss[i].name === active ? " • active" : ""));
        if (wss[i].name === cur) o.setAttribute("selected", "selected");
        wsSel.appendChild(o);
      }
      wsSel.value = cur;
      wsSel.onchange = function () {
        // Switching workspace resets run/iteration to latest to avoid a cross-workspace id.
        go({ workspace: wsSel.value, run: null, iteration: null });
      };
      loadRuns(cur);
    });

    function loadRuns(ws) {
      fetchJSON("/api/runs?workspace=" + encodeURIComponent(ws), function (err, d) {
        runSel.innerHTML = "";
        var latest = el("option", { value: "" }, "Latest (live)");
        runSel.appendChild(latest);
        if (err || !d) return;
        var runs = d.runs || [];
        if (runs.length) {
          var g = el("optgroup", { label: "pipeline runs" });
          for (var i = 0; i < runs.length; i++) {
            var r = runs[i];
            var when = (r.started_at || r.id || "").replace("T", " ").slice(0, 16);
            var lab = (r.tag && r.tag !== "untagged" ? r.tag + " · " : "") + when + (r.status ? " (" + r.status + ")" : "");
            var o = el("option", { value: "run:" + r.id }, lab);
            g.appendChild(o);
          }
          runSel.appendChild(g);
        }
        var its = d.iterations || [];
        if (its.length) {
          var gi = el("optgroup", { label: "book iterations" });
          for (var j = 0; j < its.length; j++) {
            var it = its[j];
            var ol = it.id + (it.words ? " · " + Math.round(it.words / 1000) + "k words" : "") + (it.has_pdf ? " · pdf" : "");
            gi.appendChild(el("option", { value: "iter:" + it.id }, ol));
          }
          runSel.appendChild(gi);
        }
        // Reflect current selection.
        if (iteration) runSel.value = "iter:" + iteration;
        else if (run) runSel.value = "run:" + run;
        else runSel.value = "";
        runSel.onchange = function () {
          var v = runSel.value;
          if (v.indexOf("iter:") === 0) go({ iteration: v.slice(5), run: null });
          else if (v.indexOf("run:") === 0) go({ run: v.slice(4), iteration: null });
          else go({ run: null, iteration: null });
        };
      });
    }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", build);
  else build();
})();
