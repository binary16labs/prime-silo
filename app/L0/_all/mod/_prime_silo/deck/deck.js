// HUD deck — the estate on a wall (#/_prime_silo/deck).
//
// Three states of one surface, not three products:
//
//   ambient    nothing wants you. Still, glanceable, redacted if projected.
//   situation  you engaged it. The same data, with the detail a working surface needs.
//   command    you are holding the talk key. It shows what it heard and what it did.
//
// Two rules the rest of the file exists to keep.
//
//   MOTION IS THE ESTATE'S, NOT A TIMER'S. C0 forbids ambient motion, and on a wall that rule
//   pays for itself: a surface that animates constantly becomes wallpaper and stops being
//   read. So each poll is DIFFED against the last, and only a tile whose number actually
//   changed is allowed to move. A deck that pulses on a setInterval is lying about activity.
//
//   VOICE NEVER SIGNS. The estate rests on a signature being a deliberate act by an
//   authenticated person. A spoken "sign it" — in a room, where anyone can speak and a
//   television can too — would end that. Voice navigates, asks, and raises proposals, which is
//   `frontier` authorship and harmless. The intent router below has no path to gov_sign, and
//   that is a design decision, not an omission.

const CALM = () =>
  matchMedia("(prefers-reduced-motion: reduce)").matches ||
  document.documentElement.dataset.profile === "zen";

const EMPTY = {
  decide: { waiting: 0, signed: 0, declined: 0, oldest: null },
  prove: { ledgers: 0, ledgers_total: 0, broken: [], subjects: 0, origin_recorded: 0, world: "" },
  watch: { nodes: [], outages: 0 },
  run: { in_scope: 0, pre_control: 0, unauthorised: 0 },
  pulse: { last_event_at: null, seconds_since: null, events_total: 0 }
};

window.deckPage = function deckPage() {
  return {
    s: EMPTY,
    prev: null,
    blind: true,
    reason: "reading the ledgers…",
    mode: "ambient",
    room: false,
    listening: false,
    heard: "",
    said: "",
    voice: { available: false, note: "checking for a voice…" },
    idleTimer: null,

    async init() {
      // A projected surface should start redacted. Turning room mode ON by hand after the
      // first glance is exactly one glance too late.
      this.room = new URLSearchParams(location.hash.split("?")[1] || "").get("room") !== "off";
      await this.refresh();
      await this.checkVoice();
      setInterval(() => this.refresh(), 20000);
      for (const ev of ["pointermove", "keydown"])
        window.addEventListener(ev, () => this.engage(), { passive: true });
    },

    // Engaging is what turns ambient into a working surface; going quiet returns it.
    engage() {
      if (this.mode === "ambient") this.mode = "situation";
      clearTimeout(this.idleTimer);
      this.idleTimer = setTimeout(() => {
        if (!this.listening) this.mode = "ambient";
      }, 120000);
    },

    async refresh() {
      try {
        const res = await fetch("/api/deck_state", { headers: { Accept: "application/json" } });
        const data = await res.json();
        if (data.blind) {
          this.blind = true;
          this.reason = data.reason || "the deck cannot see the ledgers";
          return;
        }
        this.prev = this.blind ? null : this.s;
        this.s = { ...EMPTY, ...data };
        this.blind = false;
        this.markChanges();
      } catch (e) {
        this.blind = true;
        this.reason = `cannot reach the estate: ${e.message}`;
      }
    },

    // The diff. Only a tile whose figure moved is allowed to animate, and only once.
    markChanges() {
      if (!this.prev || CALM()) return;
      const moved = {
        decide: this.prev.decide?.waiting !== this.s.decide.waiting,
        prove: this.prev.prove?.origin_recorded !== this.s.prove.origin_recorded,
        watch: this.upCountOf(this.prev) !== this.upCount(),
        run: this.prev.run?.unauthorised !== this.s.run.unauthorised
      };
      this.$nextTick(() => {
        for (const [key, changed] of Object.entries(moved)) {
          if (!changed) continue;
          const el = document.querySelector(`.deck__tile--${key}`) || this.tileByLabel(key);
          if (!el) continue;
          el.dataset.changed = "true";
          setTimeout(() => delete el.dataset.changed, 800);
        }
      });
    },

    tileByLabel(key) {
      return [...document.querySelectorAll(".deck__tile")].find(
        (t) => t.querySelector(".deck__label")?.textContent?.toLowerCase() === key
      );
    },

    upCount() {
      return this.s.watch.nodes.filter((n) => n.up).length;
    },
    upCountOf(state) {
      return (state?.watch?.nodes ?? []).filter((n) => n.up).length;
    },
    anyBlind() {
      return this.s.watch.nodes.some((n) => n.blind);
    },

    // The wall's single word. Attention outranks steady; blindness outranks both, because a
    // deck that cannot see must never render as calm.
    health() {
      if (this.blind) return "blind";
      if (this.anyBlind() || this.s.prove.broken.length || this.s.run.unauthorised > 0)
        return "attention";
      if (this.s.decide.waiting > 0) return "attention";
      return "steady";
    },

    pulseLine() {
      const s = this.s.pulse.seconds_since;
      if (s == null) return "no events yet";
      if (s < 90) return `last event ${s}s ago`;
      const m = Math.round(s / 60);
      return m < 90 ? `last event ${m}m ago` : `last event ${Math.round(m / 60)}h ago`;
    },

    // Room mode hides what a wall should not show a room: machine names, proposal titles,
    // store paths. The payload names these itself rather than leaving the renderer to guess.
    maskMachine(name) {
      const s = String(name || "");
      return s ? s[0].toUpperCase() + "…" : "node";
    },

    async checkVoice() {
      try {
        const res = await fetch("/api/deck_voice");
        const v = await res.json();
        this.voice = {
          available: Boolean(v.hear && v.speak),
          note: v.note || ""
        };
      } catch {
        this.voice = { available: false, note: "no voice service reachable" };
      }
    },

    async startTalk() {
      if (!this.voice.available || this.listening) return;
      this.mode = "command";
      this.heard = "";
      this.said = "";
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        this.chunks = [];
        this.rec = new MediaRecorder(stream);
        this.rec.ondataavailable = (e) => this.chunks.push(e.data);
        this.rec.onstop = () => {
          stream.getTracks().forEach((t) => t.stop());
          this.send(new Blob(this.chunks, { type: "audio/webm" }));
        };
        this.rec.start();
        this.listening = true;
      } catch (e) {
        this.voice = { available: false, note: `microphone unavailable: ${e.message}` };
      }
    },

    stopTalk() {
      if (!this.listening) return;
      this.listening = false;
      try {
        this.rec?.stop();
      } catch {
        /* already stopped */
      }
    },

    async send(blob) {
      const fd = new FormData();
      fd.append("audio", blob, "speech.webm");
      try {
        const res = await fetch("/api/deck_voice", { method: "POST", body: fd });
        const out = await res.json();
        this.heard = out.heard || "(nothing heard)";
        this.said = out.said || "";
        if (out.navigate) location.hash = `#/${out.navigate}`;
        await this.refresh();
      } catch (e) {
        this.said = `voice failed: ${e.message}`;
      } finally {
        this.engage();
      }
    }
  };
};
