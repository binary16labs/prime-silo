// Sonification Engine
// WebAudio-driven program-auditory feedback. Each event maps to a timbre/pitch
// so the developer can "hear" the graph. Lazy-inits on first user gesture.

type NodeType = 'Folder' | 'File' | 'Class' | 'Interface' | 'Function' | 'Documentation' | 'Concept' | string;

const TYPE_PITCH: Record<string, number> = {
  Folder: 220.0,
  File: 329.63,
  Class: 261.63,
  Interface: 349.23,
  Function: 440.0,
  Documentation: 196.0,
  Concept: 523.25,
};

export type SonificationEventKind =
  | 'hover'
  | 'click'
  | 'select'
  | 'edge_pulse'
  | 'cycle_detected'
  | 'error'
  | 'commit'
  | 'prune'
  | 'myelinate';

class SonificationEngineImpl {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private ambient: { osc: OscillatorNode; gain: GainNode; lfo: OscillatorNode; lfoGain: GainNode } | null = null;
  private enabled = false;
  private ambientOn = false;
  private lastActivity = 0;

  private ensure(): boolean {
    if (!this.enabled) return false;
    if (this.ctx) return true;
    try {
      const Ctx: typeof AudioContext = (window as any).AudioContext || (window as any).webkitAudioContext;
      if (!Ctx) return false;
      this.ctx = new Ctx();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.12;
      this.master.connect(this.ctx.destination);
      return true;
    } catch {
      return false;
    }
  }

  setEnabled(v: boolean) {
    this.enabled = v;
    if (!v) {
      this.stopAmbient();
    }
  }

  setAmbient(on: boolean) {
    if (on) {
      if (!this.ensure() || !this.ctx || !this.master) return;
      if (this.ambient) return;
      const osc = this.ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = 55; // sub-A1
      const gain = this.ctx.createGain();
      gain.gain.value = 0.0;
      // Slow volume LFO — program heartbeat
      const lfo = this.ctx.createOscillator();
      lfo.type = 'sine';
      lfo.frequency.value = 0.25;
      const lfoGain = this.ctx.createGain();
      lfoGain.gain.value = 0.04;
      lfo.connect(lfoGain).connect(gain.gain);
      osc.connect(gain).connect(this.master);
      osc.start();
      lfo.start();
      // Fade in
      gain.gain.setValueAtTime(0.0, this.ctx.currentTime);
      gain.gain.linearRampToValueAtTime(0.05, this.ctx.currentTime + 1.2);
      this.ambient = { osc, gain, lfo, lfoGain };
      this.ambientOn = true;
    } else {
      this.stopAmbient();
    }
  }

  private stopAmbient() {
    if (!this.ambient || !this.ctx) { this.ambientOn = false; return; }
    const { osc, gain, lfo } = this.ambient;
    try {
      gain.gain.cancelScheduledValues(this.ctx.currentTime);
      gain.gain.setValueAtTime(gain.gain.value, this.ctx.currentTime);
      gain.gain.linearRampToValueAtTime(0.0, this.ctx.currentTime + 0.4);
      osc.stop(this.ctx.currentTime + 0.45);
      lfo.stop(this.ctx.currentTime + 0.45);
    } catch {/* noop */}
    this.ambient = null;
    this.ambientOn = false;
  }

  // Bump ambient gain briefly when the graph is active.
  pulseAmbient(intensity = 1) {
    if (!this.ambientOn || !this.ambient || !this.ctx) return;
    const t = this.ctx.currentTime;
    const peak = Math.min(0.09, 0.04 + 0.02 * intensity);
    this.ambient.gain.gain.cancelScheduledValues(t);
    this.ambient.gain.gain.setValueAtTime(this.ambient.gain.gain.value, t);
    this.ambient.gain.gain.linearRampToValueAtTime(peak, t + 0.08);
    this.ambient.gain.gain.linearRampToValueAtTime(0.05, t + 0.6);
  }

  emit(kind: SonificationEventKind, opts: { nodeType?: NodeType; pitchOffset?: number; dissonance?: boolean } = {}) {
    if (!this.ensure() || !this.ctx || !this.master) return;
    const now = performance.now();
    // Throttle hover spam
    if (kind === 'hover' && now - this.lastActivity < 60) return;
    this.lastActivity = now;

    const base = opts.nodeType && TYPE_PITCH[opts.nodeType] ? TYPE_PITCH[opts.nodeType] : 440;
    const shift = (opts.pitchOffset || 0);
    const freq = base * Math.pow(2, shift / 12);

    switch (kind) {
      case 'hover':     return this.blip(freq, 0.05, 'sine', 0.04);
      case 'click':     return this.blip(freq, 0.12, 'triangle', 0.08);
      case 'select':    return this.chord([freq, freq * 1.25, freq * 1.5], 0.22, 'sine', 0.06);
      case 'edge_pulse':return this.blip(freq * 0.5, 0.08, 'square', 0.025);
      case 'cycle_detected': return this.chord([freq, freq * 1.5, freq * 2], 0.4, 'sawtooth', 0.04);
      case 'error':     return this.chord([freq, freq * 1.06], 0.25, 'sawtooth', 0.08); // minor second dissonance
      case 'commit':    return this.chord([freq * 0.5, freq, freq * 1.5], 0.35, 'triangle', 0.07);
      case 'prune':     return this.blip(freq * 0.25, 0.5, 'sine', 0.04);
      case 'myelinate': return this.chord([freq, freq * 1.3334], 0.3, 'sine', 0.05);
    }
  }

  private blip(freq: number, dur: number, type: OscillatorType, vol: number) {
    if (!this.ctx || !this.master) return;
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vol, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g).connect(this.master);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  private chord(freqs: number[], dur: number, type: OscillatorType, vol: number) {
    freqs.forEach((f, i) => {
      setTimeout(() => this.blip(f, dur, type, vol * (1 - i * 0.12)), i * 18);
    });
  }
}

export const Sonification = new SonificationEngineImpl();
