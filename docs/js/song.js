// Song playback engine. Drives emitter levels from a note list and
// interpolates scene elements between keyframes over time.
//
// Usage:
//   const player = new SongPlayer();
//   player.load(songJson);
//   player.play();
//   // in frame loop:
//   player.update(scene, dt);  // mutates scene.elements + scene.runtime.micLevels

import { makeElement, bumpGeneration, ensureRuntimeSize } from './scene.js';
import { CARRIERS } from './carriers.js';

// Carrier name → integer index. Order in CARRIERS is the source of
// truth and must match `_CARRIERS` in synth-worklet.js. Index 0 is
// "no override / use the global synth-carrier dropdown's value".
// Names: sine=0, noise=1, acid=2, fm=3, supersaw=4, pulse=5,
// vocoder=6, karplus=7, piano=8.
export const CARRIER_INDEX = {};
{
  let i = 0;
  for (const k of Object.keys(CARRIERS)) CARRIER_INDEX[k] = i++;
}
export const CARRIER_COUNT = Object.keys(CARRIERS).length;

export class SongPlayer {
  constructor() {
    this.song = null;
    this.state = 'stopped'; // 'stopped' | 'playing' | 'paused'
    this.time = 0;
    this.duration = 0;
    this._savedSettings = null;
    this.keyframesPaused = false; // true while user drags an element
    this.bendPaused = false;      // true once the user touches the wl-bend slider
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
    this.bendPaused = false;
    this._globalApplied = false;
    // Notify listeners — otherwise switching from a playing/paused song
    // leaves the UI (play button icon, seek slider, time readout) stuck
    // in the previous song's state.
    this.onStateChange?.(this.state);
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
    this.bendPaused = false;
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
    scene.runtime.micLevels = null;
    ensureRuntimeSize(scene);
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

    // Apply global emitter/sensor/scale config.
    const g = this.song.global;
    if (g) {
      // Track shape changes so we can bump scene.generation and resize
      // runtime arrays after — the tripwire that lets every consumer
      // (tracer, edge-memory, etc.) self-reset on scene-shape changes
      // without each having to remember resetXxx() in load paths.
      let shapeChanged = false;
      if (g.emitter) {
        if (g.emitter.count !== undefined && g.emitter.count !== scene.emitter.count) {
          scene.emitter.count = g.emitter.count;
          shapeChanged = true;
        }
        if (g.emitter.wlMin !== undefined) scene.emitter.wlMin = g.emitter.wlMin;
        if (g.emitter.wlMax !== undefined) scene.emitter.wlMax = g.emitter.wlMax;
        if (g.emitter.raysPerSource !== undefined) scene.emitter.raysPerSource = g.emitter.raysPerSource;
      }
      if (g.sensorCount !== undefined && g.sensorCount !== scene.sensorCount) {
        scene.sensorCount = g.sensorCount;
        shapeChanged = true;
      }
      if (shapeChanged) {
        bumpGeneration(scene);
        ensureRuntimeSize(scene);
      }
      // Per-emitter carrier defaults from `global.carriers`. Map of
      // `{emitterIdx: carrierName}`. Applies the named carrier index
      // to each listed emitter; absent entries stay at 0 (== "use the
      // global synth-carrier dropdown's value"). Allocated lazily —
      // only when the song actually specifies carriers.
      if (g.carriers) {
        const n = scene.emitter.count;
        let cps = scene.runtime.carrierPerSource;
        if (!cps || cps.length !== n) {
          cps = new Int8Array(n);
          scene.runtime.carrierPerSource = cps;
        } else {
          // Clear stale per-note overrides from previous frames so
          // the keyframe defaults apply cleanly.
          cps.fill(0);
        }
        for (const [k, name] of Object.entries(g.carriers)) {
          const idx = k | 0;
          const cIdx = CARRIER_INDEX[name];
          if (idx >= 0 && idx < n && cIdx !== undefined) cps[idx] = cIdx;
        }
      }
      // Scale / carrier settings. Applied once on play via onGlobal callback.
      if (!this._globalApplied) {
        this._globalApplied = true;
        if (this.onGlobal) this.onGlobal(g);
      }
    }

    // Build element map for each keyframe.
    const mapA = new Map((kfA.elements || []).map(e => [e.id, e]));
    const mapB = new Map((kfB.elements || []).map(e => [e.id, e]));
    const allIds = new Set([...mapA.keys(), ...mapB.keys()]);

    // Index existing runtime elements by song-id so we can mutate them
    // in place instead of rebuilding the array every frame. This
    // preserves accumulated state — notably `el.rot` driven by spin,
    // which the main-loop spin integrator updates outside the song
    // player and which would be clobbered if we rebuilt from scratch.
    const existing = new Map();
    for (const el of scene.elements) existing.set(el.id, el);

    const next = [];
    for (const id of allIds) {
      const a = mapA.get(id);
      const b = mapB.get(id);
      let el = existing.get(id);
      if (!el) el = this._makeRuntimeElement(a || b);
      if (a && b) {
        this._updateLerpElement(el, a, b, t);
        el._opacity = 1;
      } else if (a) {
        this._updateLerpElement(el, a, a, 0);
        el._opacity = 1 - t;
      } else {
        this._updateLerpElement(el, b, b, 0);
        el._opacity = t;
      }
      next.push(el);
    }
    scene.elements = next;
  }

  _makeRuntimeElement(data) {
    const el = makeElement(data.kind, data.x, data.y);
    Object.assign(el, data);
    return el;
  }

  // Update `el` in place with the lerp of keyframes a→b at parameter t.
  // Called from _applyKeyframes; el may be a new runtime object or an
  // existing one carried over from the previous frame.
  _updateLerpElement(el, a, b, t) {
    el.x = a.x + (b.x - a.x) * t;
    el.y = a.y + (b.y - a.y) * t;
    // Rotation: skip the lerp for spinning elements — el.rot is owned
    // by the main-loop spin integrator in that case, and overwriting
    // it here would reset the accumulated angle each frame.
    if (!el.spin) {
      let da = b.rot - a.rot;
      if (da > Math.PI) da -= 2 * Math.PI;
      if (da < -Math.PI) da += 2 * Math.PI;
      el.rot = a.rot + da * t;
    }
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
    // Track the strongest active note per emitter for carrier-override
    // arbitration: when two notes overlap on the same emitter with
    // different carriers, the louder one wins. Default 0 = no override
    // recorded for this emitter (fall through to keyframe default).
    let topVel = null;       // Float32Array(n), only allocated if any note has a carrier
    let carrierOverrides = null;

    for (const note of notes) {
      if (note.time === undefined) continue; // skip comment entries
      const env = this._noteEnvelope(note);
      if (env <= 0) continue;
      const emitters = Array.isArray(note.emitter) ? note.emitter : [note.emitter];
      const vel = note.vel || 1;
      const cIdx = note.carrier !== undefined ? CARRIER_INDEX[note.carrier] : undefined;
      for (const e of emitters) {
        if (e >= 0 && e < n) {
          levels[e] = Math.min(1, levels[e] + vel * env);
          if (cIdx !== undefined) {
            if (!carrierOverrides) {
              carrierOverrides = new Int8Array(n);
              topVel = new Float32Array(n);
            }
            const w = vel * env;
            if (w > topVel[e]) {
              topVel[e] = w;
              carrierOverrides[e] = cIdx;
            }
          }
        }
      }
    }
    scene.runtime.micLevels = levels;

    // Per-note carrier overrides: stamp them onto carrierPerSource.
    // The keyframe-default base is preserved — we only overwrite slots
    // with a *recorded* override (topVel[e] > 0). Slots without an
    // active override keep whatever the keyframe wrote.
    if (carrierOverrides) {
      let cps = scene.runtime.carrierPerSource;
      if (!cps || cps.length !== n) {
        cps = new Int8Array(n);
        scene.runtime.carrierPerSource = cps;
      }
      for (let i = 0; i < n; i++) {
        if (topVel[i] > 0) cps[i] = carrierOverrides[i];
      }
    }
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
      // Once the user has taken over bend via the wl-bend slider, stop
      // applying automated bend lerps for the rest of this playback.
      if (lane.param === 'bend' && this.bendPaused) continue;
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
