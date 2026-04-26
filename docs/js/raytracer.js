// CPU ray tracer. Produces per-frame segment records for the WebGL2
// renderer and updates per-sensor spectrum bins.
//
// Two-stage pipeline:
//
//   1. Stateless primary pass.  Rays are emitted from wall sources (left
//      wall) and traced through lenses / prisms / mirrors / colored
//      glass exactly once per frame.  When a primary ray crosses the
//      boundary of a delay-material element (a dielectric with
//      `delayK > 0`), it is *captured* — a particle record is appended
//      to that element's local-coordinate pool, and the primary trace
//      for that ray terminates.
//
//   2. Stateful particle pass.  Each delay element owns a buffer of
//      photon particles in the element's local frame.  Each frame the
//      buffer is advanced by `dt * simRate` (wall-clock time); particles
//      that cross a local polygon edge are re-emitted as secondary rays
//      into the normal `castRay` pipeline.  Every advance step also
//      pushes one short trail-segment into the shared segment buffer so
//      the interior of the glass is visibly filled with crawling light.
//
// Particles are stored in *element-local* coordinates so rotating,
// translating, or scaling the element carries the in-flight wavefront
// with it.  A particle is attached to exactly one element for its
// lifetime: the element it first entered.  When that element is deleted
// the pool is dropped entirely.

import { wavelengthToRGB, materialN, elementAbsorption, elementReflectance, elementDelay } from './spectrum.js';
import { worldEdges, pointInPolygon, materialOptics } from './scene.js';

const EPS = 1e-4;
const MAX_BOUNCES = 18;
const GLASS_LOSS = 0.985;       // per-surface attenuation
const BASE_INTENSITY = 1.6;
// Particles below this intensity are culled on the advance pass.
const PARTICLE_EPS = 0.002;
// Floats per segment record in the vertex buffer:
//   [p1x, p1y, p2x, p2y, c1r*I1, c1g*I1, c1b*I1, I1,
//    c2r*I2, c2g*I2, c2b*I2, I2]
const SEG_FLOATS = 12;
// Minimum effective delayK for the capture path.  Below this threshold
// the element is treated as a normal (non-delay) dielectric — rays
// refract through instantly instead of being captured as particles.
// At the threshold value, transit through a 100-unit glass takes ~3
// frames — just enough for a visible ribbon.  Below that, the 1-frame
// gap between capture and exit makes rays look like they reflect off
// the boundary.
const DELAY_MIN = 0.0003;
// Floats per particle record in a ParticlePool:
//   [lx, ly, ldx, ldy, I, wl, lastLx, lastLy, r, g, b]
// RGB is pre-computed at capture time so the advance hot loop never
// calls wavelengthToRGB (which allocates a fresh array each call).
const PART_FLOATS = 11;

// Per-delay-element particle store.  Flat `Float32Array` kept in the
// element's local coordinate frame; `count` is the live record count.
class ParticlePool {
  constructor() {
    this.count = 0;
    this.data = new Float32Array(0);
  }
  ensureCapacity(n) {
    const needed = n * PART_FLOATS;
    if (this.data.length < needed) {
      const next = new Float32Array(Math.max(needed, this.data.length * 2 || 256));
      next.set(this.data);
      this.data = next;
    }
  }
  // Append a new particle at the local entry point with the local
  // (already-refracted-inward) direction and current intensity/wavelength.
  add(lx, ly, ldx, ldy, I, wl, r, g, b) {
    this.ensureCapacity(this.count + 1);
    const i = this.count * PART_FLOATS;
    const d = this.data;
    d[i    ] = lx;  d[i + 1] = ly;
    d[i + 2] = ldx; d[i + 3] = ldy;
    d[i + 4] = I;   d[i + 5] = wl;
    d[i + 6] = lx;  d[i + 7] = ly;  // lastLx / lastLy seeded to entry
    d[i + 8] = r;   d[i + 9] = g;   d[i + 10] = b;
    this.count++;
  }
  // Compact: move record at `src` into slot `dst`.  Used when removing
  // a particle by swap-with-last.
  _moveRecord(dst, src) {
    if (dst === src) return;
    const d = this.data;
    const a = dst * PART_FLOATS, b = src * PART_FLOATS;
    for (let k = 0; k < PART_FLOATS; k++) d[a + k] = d[b + k];
  }
  removeAt(i) {
    this._moveRecord(i, this.count - 1);
    this.count--;
  }
}

// Per-frame output buffers, reused across frames.  Pools live on the
// Tracer; they persist across `trace()` calls so held light survives
// between frames.  That persistence is the whole Phase 3 feature.
export class Tracer {
  constructor() {
    this.segmentData = new Float32Array(0);
    this.segmentCount = 0;
    this.sensorBins = null;                    // Float32Array [sensor][carrier][bin] flat
    this.sensorCount = 0;
    this.binCount = 64;
    // Carrier-axis size for sensor bins. CPU tracer always emits the
    // collapsed (carrierCount === 1) layout — `s * binCount + b`. GPU
    // tracer can emit a wider layout when `runtime.carrierPerSource`
    // is set (Stage 1 of the per-ray-carrier plan). Consumers must
    // index as `s * binCount * carrierCount + c * binCount + b`.
    this.carrierCount = 1;
    // Stateful per-delay-element particle pools keyed by element id.
    this._pools = new Map();
    // Generation counter — compared against scene.generation each
    // trace(). When the scene is replaced (clear / load / preset),
    // the generation bumps and the tracer self-resets all persistence
    // state in one shot, eliminating the "forgot to flush X" bug class.
    this._generation = -1;
    // Absolute wall-clock timestamp of the previous `trace()` call —
    // used to compute the advance `dt` for the particle pass.
    this._lastTraceTime = 0;
    // Global simulation-rate multiplier (Sim rate slider).  Scales dt
    // in the advance pass; 1 = real time, 4 = particles advance 4× as
    // fast through delay glass.
    this.simRate = 1;
    // Reusable scratch — avoid allocations inside hot loops.
    this._stack = [];
    this._walls = [
      { p1: { x: 0, y: 0 }, p2: { x: 0, y: 0 }, kind: 'abs' },
      { p1: { x: 0, y: 0 }, p2: { x: 0, y: 0 }, kind: 'sensor' },
      { p1: { x: 0, y: 0 }, p2: { x: 0, y: 0 }, kind: 'abs' },
      { p1: { x: 0, y: 0 }, p2: { x: 0, y: 0 }, kind: 'abs' },
    ];
    this._elementInfos = [];
    // Secondary-ray emission queue populated by the particle pass.
    // Flat Float32Array, 10 floats per entry:
    //   [ox, oy, dx, dy, wl, r, g, b, I, skipElId]
    // Avoids per-exit object allocation.
    this._secondary = new Float32Array(0);
    this._secondarySkipIds = [];
    this._secondaryCount = 0;
    // Local-polygon cache keyed by element id so the advance pass
    // doesn't keep re-allocating polygon arrays.
    this._localPolys = new Map();
    // Exit segment persistence cache.  Secondary-ray segments are
    // single-frame events (only produced the frame a particle exits);
    // without persistence the post-glass ribbon flickers because
    // different particles exit on different frames.  The cache holds
    // recent exit segments and decays their intensity each frame so the
    // ribbon smoothly fades rather than popping in and out.
    this._exitSegs = new Float32Array(0);
    this._exitSegCount = 0;
    // Persistent sensor accumulator for secondary-ray deposits.  Same
    // decay logic as the exit segment cache: secondary castRay hits
    // write here at (1-DECAY) strength; the accumulator decays each
    // frame; merged into sensorBins at the end of trace().
    this._sensorPersist = null;
    // Flag set while tracing secondary rays so castRay can route
    // sensor deposits to the persistent accumulator instead of the
    // per-frame sensorBins.
    this._isSecondary = false;
  }

  // Any element in the current scene that carries a non-zero delayK?
  // Cached per-trace so the hot loop in `castRay` can short-circuit
  // with one boolean test rather than re-computing per ray.
  _hasDelay = false;

  ensureSegmentCapacity(n) {
    const needed = n * SEG_FLOATS;
    if (this.segmentData.length < needed) {
      this.segmentData = new Float32Array(Math.max(needed, this.segmentData.length * 2 || 4096));
    }
  }

  // Main trace call.  Advances particle pools, then runs the primary
  // ray pass, consuming secondary-ray emissions produced by the
  // particle exits.
  trace(scene) {
    this.segmentCount = 0;

    // Generation check: if the scene was replaced (clear / load /
    // preset) the generation will have bumped.  Self-reset all
    // persistence so stale data never bleeds across scene transitions.
    if (this._generation !== scene.generation) {
      this._generation = scene.generation;
      this._pools.clear();
      this._localPolys.clear();
      this._exitSegCount = 0;
      this._secondaryCount = 0;
      if (this._sensorPersist) this._sensorPersist.fill(0);
      this._lastTraceTime = 0;
    }

    // Decay exit segment cache; emission happens at the end of trace()
    // after this frame's secondary exits have been added.
    this._decayExitCache();

    const { bench, emitter, sensorCount, elements, runtime } = scene;

    // Build world edges for all elements and the element-info array the
    // ray hot loop iterates.
    const edges = [];
    const elementMap = new Map();
    const elementInfos = this._elementInfos;
    elementInfos.length = 0;
    this._hasDelay = false;
    for (const el of elements) {
      const { edges: eEdges, polygon } = worldEdges(el);
      const mat = materialOptics(el.material);
      const dK = elementDelay(el, mat);
      const info = { el, polygon, mat, delayK: dK };
      elementMap.set(el.id, info);
      elementInfos.push(info);
      for (const e of eEdges) edges.push(e);
      if (dK >= DELAY_MIN) this._hasDelay = true;
    }

    // Drop pools + local-polygon cache entries for deleted elements.
    // Also flush persistence caches so stale exit segments and sensor
    // deposits from the deleted element don't linger.
    let poolDropped = false;
    for (const elId of [...this._pools.keys()]) {
      if (!elementMap.has(elId)) {
        this._pools.delete(elId);
        this._localPolys.delete(elId);
        poolDropped = true;
      }
    }
    if (poolDropped) {
      this._exitSegCount = 0;
      if (this._sensorPersist) this._sensorPersist.fill(0);
    }

    // Bench walls: update reused structs instead of re-allocating each frame.
    const W = this._walls;
    W[0].p1.x = 0;       W[0].p1.y = 0;       W[0].p2.x = bench.w; W[0].p2.y = 0;
    W[1].p1.x = bench.w; W[1].p1.y = 0;       W[1].p2.x = bench.w; W[1].p2.y = bench.h;
    W[2].p1.x = bench.w; W[2].p1.y = bench.h; W[2].p2.x = 0;       W[2].p2.y = bench.h;
    W[3].p1.x = 0;       W[3].p1.y = bench.h; W[3].p2.x = 0;       W[3].p2.y = 0;

    // Sensor setup: sensors tile the right wall; each sensor covers a strip.
    const binLen = sensorCount * this.binCount;
    if (this.sensorCount !== sensorCount || !this.sensorBins) {
      this.sensorCount = sensorCount;
      this.sensorBins = new Float32Array(binLen);
      this._sensorPersist = new Float32Array(binLen);
    } else {
      this.sensorBins.fill(0);
      // Decay the persistent secondary accumulator; it will be merged
      // back into sensorBins at the end of trace() after both primary
      // and secondary castRay passes.
      const D = Tracer.PERSIST_DECAY;
      const sp = this._sensorPersist;
      for (let i = 0; i < binLen; i++) sp[i] *= D;
    }
    const sensorX = bench.w - 4;
    const sensorStripH = bench.h / sensorCount;

    // --- 1) Particle advance.  Happens first so this frame's exits can
    // join the primary emission list.  Skipped entirely when no delay
    // element exists anywhere in the scene.
    this._secondaryCount = 0;
    const now = performance.now() / 1000;
    let dt = this._lastTraceTime > 0 ? (now - this._lastTraceTime) : 0;
    this._lastTraceTime = now;
    // Clamp dt to prevent huge jumps on tab-switch resumes or first
    // frame after a long idle.
    if (dt > 0.25) dt = 0.25;
    if (this._hasDelay && dt > 0) {
      this._advanceParticles(elementInfos, dt * this.simRate);
    }

    // Estimate max primary segments (same heuristic as before).
    const totalRays = emitter.count * emitter.raysPerSource;
    // Headroom for trail segments already emitted by the advance pass
    // plus secondary rays yet to trace.
    const trailHeadroom = this.segmentCount;
    this.ensureSegmentCapacity(trailHeadroom + totalRays * (MAX_BOUNCES + 1) + this._secondaryCount * MAX_BOUNCES);

    // Emitter setup: sources evenly spaced along left wall.
    const emX = 4;
    const nSrc = emitter.count;
    const raysPer = emitter.raysPerSource;
    const spreadRad = emitter.spreadDeg * Math.PI / 180;
    const srcStripH = bench.h / nSrc;

    const wlMin = emitter.wlMin, wlMax = emitter.wlMax;
    const wlRange = Math.max(1, wlMax - wlMin);
    const wlPer = runtime.wlPerSource;

    // Source modelled as an extended aperture; rays emitted from
    // random-looking positions with decorrelated wavelengths and small
    // angular jitter.
    const PHI = 0.6180339887498949;
    const PSI = 0.7548776662466927;
    const disabled = emitter.disabled;
    for (let s = 0; s < nSrc; s++) {
      // Skip disabled emitters unless micLevels explicitly activates
      // them (e.g. touch mode setting a specific emitter to 1.0).
      if (disabled && disabled.has(s) && !(runtime.micLevels && runtime.micLevels[s] > 0)) continue;
      const ey0 = (nSrc - 1 - s) * srcStripH;
      const apertureH = srcStripH * (emitter.apertureFactor ?? 0.01);
      const wlMinS = wlPer ? wlPer.min[s] : wlMin;
      const wlMaxS = wlPer ? wlPer.max[s] : wlMax;
      const wlRangeS = Math.max(1, wlMaxS - wlMinS);
      for (let k = 0; k < raysPer; k++) {
        const wl = wlMinS + wlRangeS * ((k + 0.5) / raysPer);
        const rgb = wavelengthToRGB(wl);
        const yT = ((k + 1) * PHI) % 1;
        const aT = ((k + 1) * PSI) % 1;
        const ey = ey0 + (srcStripH - apertureH) * 0.5 + yT * apertureH;
        const a = (aT - 0.5) * spreadRad;
        const dirX = Math.cos(a), dirY = Math.sin(a);
        const micGain = runtime.micLevels ? runtime.micLevels[s] : 1;
        const intensity = (BASE_INTENSITY / Math.sqrt(raysPer)) * micGain;
        this.castRay(emX, ey, dirX, dirY, wl, rgb, intensity,
                     edges, elementMap, elementInfos, W, sensorStripH, -1);
      }
    }

    // --- 2) Secondary rays from particle exits this frame.  Their
    // segments go only into the persistence cache (not the main buffer)
    // so brightness converges to 1× instead of accumulating 1/(1-D).
    // Sensor deposits are routed to the persistent accumulator via
    // `_isSecondary` so the spectrum readout and synth don't flicker.
    const secStart = this.segmentCount;
    this._isSecondary = true;
    const SEC_FLOATS = 9;
    const _secRgb = [0, 0, 0];
    for (let i = 0; i < this._secondaryCount; i++) {
      const off = i * SEC_FLOATS;
      const s = this._secondary;
      _secRgb[0] = s[off + 5]; _secRgb[1] = s[off + 6]; _secRgb[2] = s[off + 7];
      this.castRay(s[off], s[off+1], s[off+2], s[off+3], s[off+4], _secRgb, s[off+8],
                   edges, elementMap, elementInfos, W, sensorStripH, this._secondarySkipIds[i]);
    }
    this._isSecondary = false;
    // Cache the segments scaled by (1-D), then remove them from the
    // main buffer — the cache is the sole source of post-glass segments.
    this._cacheExitSegments(secStart, this.segmentCount);
    this.segmentCount = secStart;
    // Emit the full cache (previous frames decayed + this frame's fresh
    // entries) into the main buffer.
    this._emitExitCache();
    // Merge persistent sensor accumulator into sensorBins so the synth
    // and readout see both primary (per-frame) and secondary (persisted)
    // deposits in one array.
    const sp = this._sensorPersist;
    const sb = this.sensorBins;
    for (let i = 0; i < binLen; i++) sb[i] += sp[i];
  }

  // Advance every delay element's particle pool by `dtEff` seconds of
  // effective wall-clock time (Sim-rate has already been folded in).
  _advanceParticles(elementInfos, dtEff) {
    for (let k = 0; k < elementInfos.length; k++) {
      const info = elementInfos[k];
      if (info.delayK < DELAY_MIN) continue;
      const pool = this._pools.get(info.el.id);
      if (!pool || pool.count === 0) continue;
      this._advancePool(pool, info, dtEff);
    }
  }

  _advancePool(pool, info, dtEff) {
    const el = info.el;
    const mat = info.mat;
    // Local polygon for inside-test + edge clipping.
    let localPoly = this._localPolys.get(el.id);
    if (!localPoly) {
      localPoly = new Array(info.polygon.length);
      for (let j = 0; j < localPoly.length; j++) localPoly[j] = { x: 0, y: 0 };
      this._localPolys.set(el.id, localPoly);
    }
    // Refresh coordinates from the current world polygon and rotation.
    {
      const c = Math.cos(el.rot), s = Math.sin(el.rot);
      for (let j = 0; j < info.polygon.length; j++) {
        const p = info.polygon[j];
        localPoly[j].x = c * (p.x - el.x) + s * (p.y - el.y);
        localPoly[j].y = -s * (p.x - el.x) + c * (p.y - el.y);
      }
      localPoly._cw = undefined;
    }
    const cos = Math.cos(el.rot), sin = Math.sin(el.rot);
    const speedBase = 1 / info.delayK;   // bench units per second at 1×
    const d = pool.data;

    // Scratch RGB array reused across the loop to avoid per-particle
    // allocations in emitSeg (which takes an array reference).
    const _rgb = [0, 0, 0];

    for (let i = 0; i < pool.count; ) {
      const off = i * PART_FLOATS;
      let lx = d[off    ], ly = d[off + 1];
      const ldx = d[off + 2], ldy = d[off + 3];
      let I = d[off + 4];
      const wl = d[off + 5];
      _rgb[0] = d[off + 8]; _rgb[1] = d[off + 9]; _rgb[2] = d[off + 10];

      const step = speedBase * dtEff;
      const nlx = lx + ldx * step;
      const nly = ly + ldy * step;

      const alpha = elementAbsorption(el, mat, wl);
      if (alpha > 0) I *= Math.exp(-alpha * step);

      if (I < PARTICLE_EPS) { pool.removeAt(i); continue; }

      if (pointInPolygon(localPoly, nlx, nly)) {
        d[off    ] = nlx; d[off + 1] = nly;
        d[off + 4] = I;
        const lastLx = d[off + 6], lastLy = d[off + 7];
        const wx1 = el.x + cos * lastLx - sin * lastLy;
        const wy1 = el.y + sin * lastLx + cos * lastLy;
        const wx2 = el.x + cos * nlx - sin * nly;
        const wy2 = el.y + sin * nlx + cos * nly;
        this.emitSeg(wx1, wy1, wx2, wy2, _rgb, I);
        d[off + 6] = nlx; d[off + 7] = nly;
        i++;
        continue;
      }

      // Stepped outside — find the crossed edge.
      let tBest = Infinity, crossAx = 0, crossAy = 0, crossBx = 0, crossBy = 0;
      for (let j = 0; j < localPoly.length; j++) {
        const a = localPoly[j], b = localPoly[(j + 1) % localPoly.length];
        const t = segSegT(lx, ly, nlx, nly, a.x, a.y, b.x, b.y);
        if (t !== null && t < tBest) {
          tBest = t;
          crossAx = a.x; crossAy = a.y; crossBx = b.x; crossBy = b.y;
        }
      }
      if (tBest === Infinity) { pool.removeAt(i); continue; }
      const exitLx = lx + (nlx - lx) * tBest;
      const exitLy = ly + (nly - ly) * tBest;

      // Trail up to exit.
      {
        const lastLx = d[off + 6], lastLy = d[off + 7];
        const wx1 = el.x + cos * lastLx - sin * lastLy;
        const wy1 = el.y + sin * lastLx + cos * lastLy;
        const wx2 = el.x + cos * exitLx - sin * exitLy;
        const wy2 = el.y + sin * exitLx + cos * exitLy;
        this.emitSeg(wx1, wy1, wx2, wy2, _rgb, I);
      }

      // Snell refraction from `mat` into the external medium at the
      // world exit point.  Outer normal in local frame: derive from
      // the crossing edge; same formula as `worldEdges` uses.
      const ex = crossBx - crossAx;
      const ey = crossBy - crossAy;
      const elen = Math.hypot(ex, ey) || 1e-9;
      // Determine local-polygon winding once per element (cached on
      // the local poly array via .cw — computed lazily).
      if (localPoly._cw === undefined) {
        let twiceArea = 0;
        for (let j = 0; j < localPoly.length; j++) {
          const a = localPoly[j], b = localPoly[(j + 1) % localPoly.length];
          twiceArea += a.x * b.y - b.x * a.y;
        }
        localPoly._cw = twiceArea > 0;
      }
      // Outward local normal of the crossed edge.
      const oxL = localPoly._cw ? ey / elen : -ey / elen;
      const oyL = localPoly._cw ? -ex / elen : ex / elen;
      // Snell expects the normal to point INTO the incident medium
      // (the glass we're leaving from), which is the opposite of
      // the outward normal.  The primary tracer does the same
      // negation in its exit branch (`snx = -nx`).
      const nxL = -oxL, nyL = -oyL;

      // Outside medium at the exit *world* point: iterate other
      // dielectric elements to see if any polygon contains it.
      const wxE = el.x + cos * exitLx - sin * exitLy;
      const wyE = el.y + sin * exitLx + cos * exitLy;
      let outsideEl = null;
      for (let j = 0; j < this._elementInfos.length; j++) {
        const oi = this._elementInfos[j];
        if (oi.el === el) continue;
        const om = oi.mat;
        if (!om || om.type !== 'dielectric') continue;
        if (pointInPolygon(oi.polygon, wxE, wyE)) { outsideEl = oi; }
      }
      const n1 = materialN(mat, wl);
      const n2 = outsideEl ? materialN(outsideEl.mat, wl) : 1.0;
      const eta = n1 / n2;
      // Transform normal + direction into world for the Snell math.
      const nxW = cos * nxL - sin * nyL;
      const nyW = sin * nxL + cos * nyL;
      const vxW = cos * ldx - sin * ldy;
      const vyW = sin * ldx + cos * ldy;
      const cosI = -(vxW * nxW + vyW * nyW);
      const sin2T = eta * eta * (1 - cosI * cosI);
      if (sin2T > 1) {
        // TIR: reflect in local space, keep the particle in the pool.
        // Reflection `v - 2(v·n)n` is invariant under n → -n, so the
        // same incident-side normal works.
        const vd = ldx * nxL + ldy * nyL;
        const rldx = ldx - 2 * vd * nxL;
        const rldy = ldy - 2 * vd * nyL;
        const len = Math.hypot(rldx, rldy) || 1;
        const rnldx = rldx / len, rnldy = rldy / len;
        // Nudge slightly along the reflected direction so the next
        // advance step starts *inside* the polygon again.
        d[off    ] = exitLx + rnldx * EPS * 10;
        d[off + 1] = exitLy + rnldy * EPS * 10;
        d[off + 2] = rnldx;
        d[off + 3] = rnldy;
        d[off + 4] = I * GLASS_LOSS;
        d[off + 6] = exitLx;
        d[off + 7] = exitLy;
        i++;
        continue;
      }
      const cosT = Math.sqrt(1 - sin2T);
      const txW = eta * vxW + (eta * cosI - cosT) * nxW;
      const tyW = eta * vyW + (eta * cosI - cosT) * nyW;
      const tLen = Math.hypot(txW, tyW) || 1;
      // Queue secondary ray just outside the exit along the refracted
      // direction; `skipElId = el.id` lets castRay ignore this element
      // on the first-hit search so the ray doesn't immediately re-enter.
      this._pushSecondary(
        wxE + (txW / tLen) * EPS * 10,
        wyE + (tyW / tLen) * EPS * 10,
        txW / tLen, tyW / tLen,
        wl, _rgb[0], _rgb[1], _rgb[2],
        I * GLASS_LOSS, el.id
      );
      pool.removeAt(i);
    }
  }

  _pushSecondary(ox, oy, dx, dy, wl, r, g, b, I, skipElId) {
    const SEC_FLOATS = 9;
    const needed = (this._secondaryCount + 1) * SEC_FLOATS;
    if (this._secondary.length < needed) {
      const next = new Float32Array(Math.max(needed, this._secondary.length * 2 || 128));
      next.set(this._secondary);
      this._secondary = next;
    }
    const i = this._secondaryCount * SEC_FLOATS;
    const s = this._secondary;
    s[i] = ox; s[i+1] = oy; s[i+2] = dx; s[i+3] = dy;
    s[i+4] = wl; s[i+5] = r; s[i+6] = g; s[i+7] = b;
    s[i+8] = I;
    // skipElId is a UUID string — can't store in Float32Array.
    if (!this._secondarySkipIds) this._secondarySkipIds = [];
    this._secondarySkipIds[this._secondaryCount] = skipElId;
    this._secondaryCount++;
  }

  // Get-or-create the particle pool for an element.
  _poolFor(elId) {
    let p = this._pools.get(elId);
    if (!p) { p = new ParticlePool(); this._pools.set(elId, p); }
    return p;
  }

  // --- Exit persistence (segments + sensor bins) ---
  // Shared decay rate.  Each frame old entries are multiplied by PERSIST_DECAY;
  // new entries are stored at (1 - PERSIST_DECAY) so the steady-state sum of
  // the geometric series converges to 1× the single-frame brightness.
  static PERSIST_DECAY = 0.80;
  static PERSIST_FLOOR = 0.002;

  // Decay cached exit segments and compact dead entries.
  _decayExitCache() {
    const D = Tracer.PERSIST_DECAY, F = Tracer.PERSIST_FLOOR;
    const d = this._exitSegs;
    let w = 0;
    for (let i = 0; i < this._exitSegCount; i++) {
      const off = i * SEG_FLOATS;
      d[off + 4] *= D; d[off + 5] *= D; d[off + 6] *= D; d[off + 7] *= D;
      d[off + 8] *= D; d[off + 9] *= D; d[off + 10] *= D; d[off + 11] *= D;
      if (d[off + 7] > F || d[off + 11] > F) {
        if (w !== i) {
          const a = w * SEG_FLOATS, b = off;
          for (let k = 0; k < SEG_FLOATS; k++) d[a + k] = d[b + k];
        }
        w++;
      }
    }
    this._exitSegCount = w;
  }
  // Copy cached exit segments into the main segment buffer.
  _emitExitCache() {
    if (this._exitSegCount === 0) return;
    this.ensureSegmentCapacity(this.segmentCount + this._exitSegCount);
    const src = this._exitSegs;
    const dst = this.segmentData;
    for (let i = 0; i < this._exitSegCount; i++) {
      const sOff = i * SEG_FLOATS;
      const dOff = this.segmentCount * SEG_FLOATS;
      for (let k = 0; k < SEG_FLOATS; k++) dst[dOff + k] = src[sOff + k];
      this.segmentCount++;
    }
  }
  // Snapshot segments[start..end) from the main buffer into the cache,
  // scaled by (1 - PERSIST_DECAY) so the additive steady-state = 1×.
  _cacheExitSegments(start, end) {
    const count = end - start;
    if (count === 0) return;
    const scale = 1 - Tracer.PERSIST_DECAY;
    const needed = (this._exitSegCount + count) * SEG_FLOATS;
    if (this._exitSegs.length < needed) {
      const next = new Float32Array(Math.max(needed, this._exitSegs.length * 2 || 1024));
      next.set(this._exitSegs.subarray(0, this._exitSegCount * SEG_FLOATS));
      this._exitSegs = next;
    }
    const src = this.segmentData;
    const dst = this._exitSegs;
    for (let i = 0; i < count; i++) {
      const sOff = (start + i) * SEG_FLOATS;
      const dOff = (this._exitSegCount + i) * SEG_FLOATS;
      // Position (4 floats) copied as-is; colour+intensity (8 floats) scaled.
      dst[dOff] = src[sOff]; dst[dOff + 1] = src[sOff + 1];
      dst[dOff + 2] = src[sOff + 2]; dst[dOff + 3] = src[sOff + 3];
      for (let k = 4; k < SEG_FLOATS; k++) dst[dOff + k] = src[sOff + k] * scale;
    }
    this._exitSegCount += count;
  }

  castRay(ox, oy, dx, dy, wl, rgb, intensity, edges, elementMap, elementInfos, walls, sensorStripH, skipElId) {
    let x = ox, y = oy, vx = dx, vy = dy;
    let I = intensity;

    // Stack of dielectric elements the ray is currently inside,
    // last-entered on top.  Reused across rays — reset length rather
    // than allocating.  Exclude delay elements: those would capture the
    // ray before it got inside, so a primary ray can only be "inside"
    // a non-delay dielectric.
    const stack = this._stack;
    stack.length = 0;
    for (let i = 0; i < elementInfos.length; i++) {
      const v = elementInfos[i];
      if (v.delayK >= DELAY_MIN) continue;
      if (v.mat && v.mat.type === 'dielectric' && pointInPolygon(v.polygon, x, y)) {
        stack.push(v.el);
      }
    }

    for (let bounce = 0; bounce < MAX_BOUNCES; bounce++) {
      let tBest = Infinity, hitEdge = null, hitWall = null;

      for (let i = 0; i < edges.length; i++) {
        const e = edges[i];
        if (e.elementId === skipElId) continue;
        const t = e.type === 'arc'
          ? rayArc(x, y, vx, vy, e.cx, e.cy, e.R, e.a0, e.a1)
          : raySeg(x, y, vx, vy, e.p1.x, e.p1.y, e.p2.x, e.p2.y);
        if (t !== null && t < tBest) { tBest = t; hitEdge = e; hitWall = null; }
      }
      // After the very first intersection test, skipElId has served
      // its purpose — let the ray re-enter the element on subsequent
      // hops (a refracted secondary ray may well cross the element's
      // *other* boundary down the line).
      skipElId = -1;

      for (let i = 0; i < walls.length; i++) {
        const w = walls[i];
        const t = raySeg(x, y, vx, vy, w.p1.x, w.p1.y, w.p2.x, w.p2.y);
        if (t !== null && t < tBest) { tBest = t; hitEdge = null; hitWall = w; }
      }

      if (tBest === Infinity) {
        this.emitSeg(x, y, x + vx * 1000, y + vy * 1000, rgb, I);
        return;
      }

      const hx = x + vx * tBest, hy = y + vy * tBest;

      // Compute edge normal. For arcs, derive from hit point and center.
      let hitNx, hitNy;
      if (hitEdge && hitEdge.type === 'arc') {
        const invR = 1 / hitEdge.R;
        hitNx = (hx - hitEdge.cx) * invR;
        hitNy = (hy - hitEdge.cy) * invR;
        if (!hitEdge.convex) { hitNx = -hitNx; hitNy = -hitNy; }
      } else if (hitEdge) {
        hitNx = hitEdge.nx;
        hitNy = hitEdge.ny;
      }

      // Beer-Lambert absorption along the segment if it was inside a
      // medium (primary rays never travel *inside* a delay element —
      // they are captured at entry — so the stack here only holds
      // non-delay dielectrics).
      let Iend = I;
      const d = Math.hypot(hx - x, hy - y);
      if (stack.length > 0) {
        const insideEl = stack[stack.length - 1];
        const inMat = materialOptics(insideEl.material);
        const alpha = elementAbsorption(insideEl, inMat, wl);
        if (alpha > 0) Iend = I * Math.exp(-alpha * d);
      }
      this.emitSeg(x, y, hx, hy, rgb, I, Iend);
      I = Iend;

      if (hitWall) {
        if (hitWall.kind === 'sensor') {
          const sIdx = Math.min(this.sensorCount - 1, Math.max(0, this.sensorCount - 1 - Math.floor(hy / sensorStripH)));
          const binIdx = Math.min(this.binCount - 1, Math.max(0,
            Math.floor((wl - 380) / (780 - 380) * this.binCount)));
          if (this._isSecondary) {
            this._sensorPersist[sIdx * this.binCount + binIdx] += I * (1 - Tracer.PERSIST_DECAY);
          } else {
            this.sensorBins[sIdx * this.binCount + binIdx] += I;
          }
        }
        return;
      }

      const elInfo = elementMap.get(hitEdge.elementId);
      const matObj = elInfo.mat;
      if (!matObj) return;

      // Phase 3 delay-element entry capture: the ray never refracts
      // through the glass; it's stored in the element's local pool and
      // re-emitted only after its transit time has elapsed (handled by
      // the advance pass on subsequent frames).
      if (matObj.type === 'dielectric' && elInfo.delayK >= DELAY_MIN) {
        const nx = hitNx, ny = hitNy;
        const vdotn_out = vx * nx + vy * ny;
        if (vdotn_out < 0) {
          // Genuine entry: refract once to get the inward direction,
          // then store local-frame state in the pool.
          const nGlass = materialN(matObj, wl);
          const n1 = stack.length > 0
            ? materialN(materialOptics(stack[stack.length - 1].material), wl)
            : 1.0;
          const n2 = nGlass;
          const eta = n1 / n2;
          const cosI = -(vx * nx + vy * ny);
          const sin2T = eta * eta * (1 - cosI * cosI);
          if (sin2T > 1) {
            // TIR at entry — reflect and keep primary-tracing.
            const vd = vx * (-nx) + vy * (-ny);
            vx = vx - 2 * vd * (-nx);
            vy = vy - 2 * vd * (-ny);
            const len = Math.hypot(vx, vy);
            vx /= len; vy /= len;
            I *= GLASS_LOSS * elementReflectance(elInfo.el, matObj, wl);
            x = hx + vx * EPS * 10;
            y = hy + vy * EPS * 10;
            if (I < 0.002) return;
            continue;
          }
          const cosT = Math.sqrt(1 - sin2T);
          const txW = eta * vx + (eta * cosI - cosT) * nx;
          const tyW = eta * vy + (eta * cosI - cosT) * ny;
          const tLen = Math.hypot(txW, tyW) || 1;
          const vxW = txW / tLen, vyW = tyW / tLen;
          // World entry → element-local.
          const cosR = Math.cos(elInfo.el.rot), sinR = Math.sin(elInfo.el.rot);
          const lx = cosR * (hx - elInfo.el.x) + sinR * (hy - elInfo.el.y);
          const ly = -sinR * (hx - elInfo.el.x) + cosR * (hy - elInfo.el.y);
          const ldx = cosR * vxW + sinR * vyW;
          const ldy = -sinR * vxW + cosR * vyW;
          const pool = this._poolFor(elInfo.el.id);
          const prgb = wavelengthToRGB(wl);
          pool.add(lx, ly, ldx, ldy, I * GLASS_LOSS, wl, prgb[0], prgb[1], prgb[2]);
          return;
        }
        // Exit-from-inside primary ray: can't happen, since primary
        // rays are captured at entry and never enter the interior.
        // Treat as pass-through with no effect.
        return;
      }

      if (matObj.type === 'mirror') {
        const nx = hitNx, ny = hitNy;
        const vdotn = vx * nx + vy * ny;
        vx = vx - 2 * vdotn * nx;
        vy = vy - 2 * vdotn * ny;
        I *= elementReflectance(elInfo.el, matObj, wl);
      } else {
        // Non-delay dielectric.  Normal Snell refraction with the
        // inside-stack for nested / overlapping dielectrics.
        const nGlass = materialN(matObj, wl);
        let nx = hitNx, ny = hitNy;
        const vdotn_out = vx * nx + vy * ny;
        const entering = vdotn_out < 0;
        let n1, n2, snx, sny;
        let poppedIdx = -1;
        if (entering) {
          n1 = stack.length > 0
            ? materialN(materialOptics(stack[stack.length - 1].material), wl)
            : 1.0;
          n2 = nGlass;
          snx = nx; sny = ny;
        } else {
          poppedIdx = stack.lastIndexOf(elInfo.el);
          if (poppedIdx >= 0) stack.splice(poppedIdx, 1);
          n1 = nGlass;
          n2 = stack.length > 0
            ? materialN(materialOptics(stack[stack.length - 1].material), wl)
            : 1.0;
          snx = -nx; sny = -ny;
        }
        const eta = n1 / n2;
        const cosI = -(vx * snx + vy * sny);
        const sin2T = eta * eta * (1 - cosI * cosI);
        if (sin2T > 1) {
          const vd = vx * (-snx) + vy * (-sny);
          vx = vx - 2 * vd * (-snx);
          vy = vy - 2 * vd * (-sny);
          if (!entering && poppedIdx >= 0) {
            stack.splice(poppedIdx, 0, elInfo.el);
          }
        } else {
          const cosT = Math.sqrt(1 - sin2T);
          vx = eta * vx + (eta * cosI - cosT) * snx;
          vy = eta * vy + (eta * cosI - cosT) * sny;
          if (entering) stack.push(elInfo.el);
        }
        const len = Math.hypot(vx, vy);
        vx /= len; vy /= len;
        I *= GLASS_LOSS;
      }

      x = hx + vx * EPS * 10;
      y = hy + vy * EPS * 10;
      if (I < 0.002) return;
    }
  }

  emitSeg(x1, y1, x2, y2, rgb, I1, I2) {
    if (I2 === undefined) I2 = I1;
    this.ensureSegmentCapacity(this.segmentCount + 1);
    const i = this.segmentCount * SEG_FLOATS;
    const d = this.segmentData;
    d[i    ] = x1; d[i + 1] = y1; d[i + 2] = x2; d[i + 3] = y2;
    d[i + 4] = rgb[0] * I1; d[i + 5] = rgb[1] * I1; d[i + 6] = rgb[2] * I1; d[i + 7] = I1;
    d[i + 8] = rgb[0] * I2; d[i + 9] = rgb[1] * I2; d[i + 10] = rgb[2] * I2; d[i + 11] = I2;
    this.segmentCount++;
  }

  // Count of in-flight particles across all pools — used by main.js to
  // decide whether to keep RAF alive when nothing else is dirty.
  activeParticleCount() {
    let n = 0;
    for (const p of this._pools.values()) n += p.count;
    return n;
  }

  // Clear all persistence state (exit segment cache, sensor persist
  // accumulator, particle pools). Called on scene clear / load so stale
  // data doesn't bleed into the new scene.
  resetPersistence() {
    this._exitSegCount = 0;
    if (this._sensorPersist) this._sensorPersist.fill(0);
    this._pools.clear();
    this._localPolys.clear();
  }
}

function raySeg(ox, oy, dx, dy, ax, ay, bx, by) {
  const sx = bx - ax, sy = by - ay;
  const denom = dx * sy - dy * sx;
  if (Math.abs(denom) < 1e-9) return null;
  const ex = ax - ox, ey = ay - oy;
  const t = (ex * sy - ey * sx) / denom;
  const u = (ex * dy - ey * dx) / denom;
  if (t <= EPS) return null;
  if (u < 0 || u > 1) return null;
  return t;
}

// Analytic ray vs circular arc intersection.
// Arc defined by center (cx,cy), radius R, angular extent a0→a1
// (always swept in the positive direction, handling wrap).
function rayArc(ox, oy, dx, dy, cx, cy, R, a0, a1) {
  const ocx = ox - cx, ocy = oy - cy;
  const a = dx * dx + dy * dy;      // 1 if normalized, but be safe
  const b = ocx * dx + ocy * dy;
  const c = ocx * ocx + ocy * ocy - R * R;
  const disc = b * b - a * c;
  if (disc < 0) return null;
  const sq = Math.sqrt(disc);
  const invA = 1 / a;
  // Try both roots, smallest positive first.
  const t1 = (-b - sq) * invA;
  const t2 = (-b + sq) * invA;
  for (const t of [t1, t2]) {
    if (t <= EPS) continue;
    const hx = ox + dx * t - cx;
    const hy = oy + dy * t - cy;
    if (_angleInRange(Math.atan2(hy, hx), a0, a1)) return t;
  }
  return null;
}

const TWO_PI = 2 * Math.PI;
function _angleInRange(a, a0, a1) {
  // Normalize (a - a0) and span (a1 - a0) into [0, 2π).
  let da = (a - a0) % TWO_PI;
  if (da < 0) da += TWO_PI;
  let span = (a1 - a0) % TWO_PI;
  if (span <= 0) span += TWO_PI;
  return da <= span + 1e-4;
}

// Seg-seg intersection parameter (0..1) along the first segment, or
// null if they don't cross inside that range.  Used by the particle
// advance to find which polygon edge the step crossed.
function segSegT(x1, y1, x2, y2, ax, ay, bx, by) {
  const dx = x2 - x1, dy = y2 - y1;
  const sx = bx - ax, sy = by - ay;
  const denom = dx * sy - dy * sx;
  if (Math.abs(denom) < 1e-9) return null;
  const ex = ax - x1, ey = ay - y1;
  const t = (ex * sy - ey * sx) / denom;
  const u = (ex * dy - ey * dx) / denom;
  if (t < 0 || t > 1) return null;
  if (u < 0 || u > 1) return null;
  return t;
}
