// Song playback engine. Drives emitter levels from a note list and
// interpolates scene elements between keyframes over time.
//
// Usage:
//   const player = new SongPlayer();
//   player.load(songJson);
//   player.play();
//   // in frame loop:
//   player.update(scene, dt);  // mutates scene.elements + scene.runtime.micLevels

import { makeElement } from './scene.js';

export class SongPlayer {
  constructor() {
    this.song = null;
    this.state = 'stopped'; // 'stopped' | 'playing' | 'paused'
    this.time = 0;
    this.duration = 0;
    this._savedSettings = null;
    this.keyframesPaused = false; // true while user drags an element
    this.onStateChange = null; // callback(state)
    this.onParamChange = null; // callback(param, value)
  }

  load(json) {
    const song = typeof json === 'string' ? JSON.parse(json) : json;
    if (!song || song.version !== 1) throw new Error('unsupported song version');
    // Sort keyframes and notes by time.
    song.keyframes = (song.keyframes || []).sort((a, b) => a.time - b.time);
    song.notes = (song.notes || []).filter(n => n.time !== undefined).sort((a, b) => a.time - b.time);
    song.automation = song.automation || [];
    this.song = song;
    this.duration = song.duration || this._inferDuration(song);
    this.time = 0;
    this.state = 'stopped';
    this.keyframesPaused = false;
  }

  _inferDuration(song) {
    let d = 0;
    for (const kf of song.keyframes) d = Math.max(d, kf.time);
    for (const n of song.notes) d = Math.max(d, n.time + (n.dur || 0));
    for (const lane of song.automation) {
      for (const pt of lane.points) d = Math.max(d, pt[0]);
    }
    return d + 1; // 1s padding
  }

  play() {
    if (!this.song) return;
    if (this.state === 'stopped') this.time = 0;
    this.state = 'playing';
    this.onStateChange?.(this.state);
  }

  pause() {
    if (this.state === 'playing') {
      this.state = 'paused';
      this.onStateChange?.(this.state);
    }
  }

  stop() {
    this.state = 'stopped';
    this.time = 0;
    this.keyframesPaused = false;
    this.onStateChange?.(this.state);
  }

  seek(t) {
    this.time = Math.max(0, Math.min(this.duration, t));
  }

  get playing() { return this.state === 'playing'; }

  // Apply the scene at a specific time without playing or producing
  // audio. Used to render the initial scene on song load.
  applyKeyframeAt(scene, t) {
    if (!this.song) return;
    const saved = this.time;
    this.time = t;
    this._applyKeyframes(scene);
    // Zero emitter levels — no audio, just the visual scene.
    scene.runtime.micLevels = new Float32Array(scene.emitter.count);
    this.time = saved;
  }

  // Called every frame. Advances time, interpolates keyframes,
  // evaluates notes → micLevels, applies automation.
  update(scene, dt) {
    if (!this.song || this.state !== 'playing') return;
    this.time += dt;
    if (this.time >= this.duration) {
      if (this.song.loop) {
        this.time %= this.duration;
      } else {
        this.time = this.duration;
        this.stop();
        return;
      }
    }
    // Keyframe lerps are paused when the user is interacting with
    // elements (dragging, rotating, pinching). Notes and automation
    // continue playing — only the element positions freeze.
    if (!this.keyframesPaused) this._applyKeyframes(scene);
    this._applyNotes(scene);
    this._applyAutomation();
  }

  // --- Keyframe interpolation ---
  _applyKeyframes(scene) {
    const kfs = this.song.keyframes;
    if (kfs.length === 0) return;

    // Find bracketing keyframes.
    let kfA = kfs[0], kfB = kfs[0];
    let t = 0;
    for (let i = 0; i < kfs.length - 1; i++) {
      if (this.time >= kfs[i].time && this.time < kfs[i + 1].time) {
        kfA = kfs[i];
        kfB = kfs[i + 1];
        t = (this.time - kfA.time) / (kfB.time - kfA.time);
        break;
      }
    }
    // Past the last keyframe: use the last one.
    if (this.time >= kfs[kfs.length - 1].time) {
      kfA = kfB = kfs[kfs.length - 1];
      t = 0;
    }

    // Apply global emitter/sensor config from first keyframe or global.
    const g = this.song.global;
    if (g) {
      if (g.emitter) {
        if (g.emitter.count !== undefined) scene.emitter.count = g.emitter.count;
        if (g.emitter.wlMin !== undefined) scene.emitter.wlMin = g.emitter.wlMin;
        if (g.emitter.wlMax !== undefined) scene.emitter.wlMax = g.emitter.wlMax;
        if (g.emitter.raysPerSource !== undefined) scene.emitter.raysPerSource = g.emitter.raysPerSource;
      }
      if (g.sensorCount !== undefined) scene.sensorCount = g.sensorCount;
    }

    // Build element map for each keyframe.
    const mapA = new Map((kfA.elements || []).map(e => [e.id, e]));
    const mapB = new Map((kfB.elements || []).map(e => [e.id, e]));
    const allIds = new Set([...mapA.keys(), ...mapB.keys()]);

    scene.elements = [];
    for (const id of allIds) {
      const a = mapA.get(id);
      const b = mapB.get(id);
      if (a && b) {
        scene.elements.push(this._lerpElement(a, b, t));
      } else if (a) {
        // Fading out
        const el = this._makeRuntimeElement(a);
        el._opacity = 1 - t;
        scene.elements.push(el);
      } else {
        // Fading in
        const el = this._makeRuntimeElement(b);
        el._opacity = t;
        scene.elements.push(el);
      }
    }
  }

  _makeRuntimeElement(data) {
    const el = makeElement(data.kind, data.x, data.y);
    Object.assign(el, data);
    return el;
  }

  _lerpElement(a, b, t) {
    const el = this._makeRuntimeElement(a);
    el.x = a.x + (b.x - a.x) * t;
    el.y = a.y + (b.y - a.y) * t;
    // Shortest-path angular lerp for rotation.
    let da = b.rot - a.rot;
    if (da > Math.PI) da -= 2 * Math.PI;
    if (da < -Math.PI) da += 2 * Math.PI;
    el.rot = a.rot + da * t;
    // Size fields: lerp whichever exist on both.
    for (const k of ['size', 'w', 'h', 'radius']) {
      if (typeof a[k] === 'number' && typeof b[k] === 'number') {
        el[k] = a[k] + (b[k] - a[k]) * t;
      }
    }
    // Material: discrete switch at midpoint.
    el.material = t < 0.5 ? a.material : b.material;
    // Color: lerp if both hex strings.
    if (a.color && b.color) {
      el.color = this._lerpColor(a.color, b.color, t);
    } else {
      el.color = t < 0.5 ? a.color : b.color;
    }
    // Spin: use b's spin from midpoint.
    if (b.spin !== undefined) el.spin = t < 0.5 ? (a.spin || 0) : b.spin;
    el._opacity = 1;
    return el;
  }

  _lerpColor(hexA, hexB, t) {
    const parse = h => {
      const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(h);
      return m ? [parseInt(m[1],16), parseInt(m[2],16), parseInt(m[3],16)] : [255,255,255];
    };
    const ca = parse(hexA), cb = parse(hexB);
    const r = Math.round(ca[0] + (cb[0] - ca[0]) * t);
    const g = Math.round(ca[1] + (cb[1] - ca[1]) * t);
    const b = Math.round(ca[2] + (cb[2] - ca[2]) * t);
    return '#' + [r,g,b].map(v => v.toString(16).padStart(2,'0')).join('');
  }

  // --- Note evaluation ---
  _applyNotes(scene) {
    const notes = this.song.notes;
    const n = scene.emitter.count;
    const levels = new Float32Array(n);

    for (const note of notes) {
      if (note.time === undefined) continue; // skip comment entries
      const env = this._noteEnvelope(note);
      if (env <= 0) continue;
      const emitters = Array.isArray(note.emitter) ? note.emitter : [note.emitter];
      for (const e of emitters) {
        if (e >= 0 && e < n) {
          levels[e] = Math.min(1, levels[e] + (note.vel || 1) * env);
        }
      }
    }
    scene.runtime.micLevels = levels;
  }

  _noteEnvelope(note) {
    const ATTACK = 0.005;  // 5ms
    const RELEASE = 0.02;  // 20ms
    const onset = note.time;
    const offset = onset + (note.dur || 0.1);
    const t = this.time;
    if (t < onset) return 0;
    if (t < onset + ATTACK) return (t - onset) / ATTACK;
    if (t < offset) return 1;
    if (t < offset + RELEASE) return 1 - (t - offset) / RELEASE;
    return 0;
  }

  // --- Automation ---
  _applyAutomation() {
    for (const lane of this.song.automation) {
      const val = this._evalAutomation(lane);
      if (val !== undefined) this.onParamChange?.(lane.param, val);
    }
  }

  _evalAutomation(lane) {
    const pts = lane.points;
    if (!pts || pts.length === 0) return undefined;
    const t = this.time;
    // Before first point.
    if (t <= pts[0][0]) return pts[0][1];
    // After last point.
    if (t >= pts[pts.length - 1][0]) return pts[pts.length - 1][1];
    // Find bracketing points.
    for (let i = 0; i < pts.length - 1; i++) {
      if (t >= pts[i][0] && t < pts[i + 1][0]) {
        const [t0, v0] = pts[i];
        const [t1, v1] = pts[i + 1];
        // Discrete (string values): switch at point time.
        if (typeof v0 === 'string') return v0;
        // Numeric: linear interpolation.
        const frac = (t - t0) / (t1 - t0);
        return v0 + (v1 - v0) * frac;
      }
    }
    return pts[pts.length - 1][1];
  }
}
