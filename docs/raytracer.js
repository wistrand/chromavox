// CPU ray tracer. Emits per-frame segment records for the WebGL2 renderer
// and updates per-sensor spectrum bins.

import { wavelengthToRGB, materialN, elementAbsorption, elementReflectance } from './spectrum.js';
import { worldEdges, pointInPolygon, materialOptics } from './scene.js';

const EPS = 1e-4;
const MAX_BOUNCES = 18;
const GLASS_LOSS = 0.985;       // per-surface attenuation
const BASE_INTENSITY = 1.6;

// Per-frame output buffers, reused across frames.
// segmentData is laid out as 12 floats per ray segment:
//   [p1x, p1y, p2x, p2y, c1r*I1, c1g*I1, c1b*I1, I1, c2r*I2, c2g*I2, c2b*I2, I2]
// The renderer expands each segment into an instanced SDF quad.
export class Tracer {
  constructor() {
    this.segmentData = new Float32Array(0);
    this.segmentCount = 0;
    this.sensorBins = null;                    // Float32Array [sensor][bin] flat
    this.sensorCount = 0;
    this.binCount = 64;
    // Reusable scratch — avoid allocating inside the ray hot loop.
    this._stack = [];
    this._walls = [
      { p1: { x: 0, y: 0 }, p2: { x: 0, y: 0 }, kind: 'abs' },
      { p1: { x: 0, y: 0 }, p2: { x: 0, y: 0 }, kind: 'sensor' },
      { p1: { x: 0, y: 0 }, p2: { x: 0, y: 0 }, kind: 'abs' },
      { p1: { x: 0, y: 0 }, p2: { x: 0, y: 0 }, kind: 'abs' },
    ];
    this._elementInfos = [];
  }

  ensureSegmentCapacity(n) {
    const needed = n * 12;
    if (this.segmentData.length < needed) {
      this.segmentData = new Float32Array(Math.max(needed, this.segmentData.length * 2 || 4096));
    }
  }

  // Main trace call. Produces line segments and sensor deposits.
  trace(scene) {
    this.segmentCount = 0;
    const { bench, emitter, sensorCount, elements } = scene;

    // Build edges for all elements.
    const edges = [];
    const elementMap = new Map();
    const elementInfos = this._elementInfos;
    elementInfos.length = 0;
    for (const el of elements) {
      const { edges: eEdges, polygon } = worldEdges(el);
      const info = { el, polygon };
      elementMap.set(el.id, info);
      elementInfos.push(info);
      for (const e of eEdges) edges.push(e);
    }

    // Bench walls: update reused structs instead of re-allocating each frame.
    const W = this._walls;
    W[0].p1.x = 0;       W[0].p1.y = 0;       W[0].p2.x = bench.w; W[0].p2.y = 0;
    W[1].p1.x = bench.w; W[1].p1.y = 0;       W[1].p2.x = bench.w; W[1].p2.y = bench.h;
    W[2].p1.x = bench.w; W[2].p1.y = bench.h; W[2].p2.x = 0;       W[2].p2.y = bench.h;
    W[3].p1.x = 0;       W[3].p1.y = bench.h; W[3].p2.x = 0;       W[3].p2.y = 0;

    // Sensor setup: sensors tile the right wall. Each sensor covers a strip.
    if (this.sensorCount !== sensorCount || !this.sensorBins) {
      this.sensorCount = sensorCount;
      this.sensorBins = new Float32Array(sensorCount * this.binCount);
    } else {
      this.sensorBins.fill(0);
    }
    const sensorX = bench.w - 4;
    const sensorStripH = bench.h / sensorCount;

    // Emitter setup: sources evenly spaced along left wall.
    const emX = 4;
    const nSrc = emitter.count;
    const raysPer = emitter.raysPerSource;
    const spreadRad = emitter.spreadDeg * Math.PI / 180;
    const srcStripH = bench.h / nSrc;

    // Estimate max segments to avoid re-alloc per ray.
    const totalRays = nSrc * raysPer;
    this.ensureSegmentCapacity(totalRays * (MAX_BOUNCES + 1));

    const wlMin = emitter.wlMin, wlMax = emitter.wlMax;
    const wlRange = Math.max(1, wlMax - wlMin);
    const wlPer = emitter.wlPerSource;

    // Source is modelled as an extended aperture across its y-strip. Rays
    // are emitted from random-looking positions along the aperture with
    // decorrelated wavelengths and small angular jitter, so each beam looks
    // like a wide continuous ribbon of light rather than a visible fan.
    const PHI = 0.6180339887498949;
    const PSI = 0.7548776662466927;
    const disabled = emitter.disabled;
    for (let s = 0; s < nSrc; s++) {
      if (disabled && disabled.has(s)) continue;
      const ey0 = s * srcStripH;
      const apertureH = srcStripH * (emitter.apertureFactor ?? 0.01);
      const wlMinS = wlPer ? wlPer.min[s] : wlMin;
      const wlMaxS = wlPer ? wlPer.max[s] : wlMax;
      const wlRangeS = Math.max(1, wlMaxS - wlMinS);
      for (let k = 0; k < raysPer; k++) {
        const wl = wlMinS + wlRangeS * ((k + 0.5) / raysPer);
        const rgb = wavelengthToRGB(wl);
        // Decorrelate y-offset and angle from wavelength with irrational
        // step sequences (no visible banding).
        const yT = ((k + 1) * PHI) % 1;
        const aT = ((k + 1) * PSI) % 1;
        const ey = ey0 + (srcStripH - apertureH) * 0.5 + yT * apertureH;
        const a = (aT - 0.5) * spreadRad;
        const dirX = Math.cos(a), dirY = Math.sin(a);
        const micGain = emitter.micLevels ? emitter.micLevels[s] : 1;
        const intensity = (BASE_INTENSITY / Math.sqrt(raysPer)) * micGain;
        this.castRay(emX, ey, dirX, dirY, wl, rgb, intensity,
                     edges, elementMap, elementInfos, W, sensorStripH);
      }
    }
  }

  castRay(ox, oy, dx, dy, wl, rgb, intensity, edges, elementMap, elementInfos, walls, sensorStripH) {
    let x = ox, y = oy, vx = dx, vy = dy;
    let I = intensity;

    // Stack of dielectric elements the ray is currently inside, last-entered
    // on top. Reused across rays — reset length instead of allocating.
    const stack = this._stack;
    stack.length = 0;
    for (let i = 0; i < elementInfos.length; i++) {
      const v = elementInfos[i];
      const m = materialOptics(v.el.material);
      if (m && m.type === 'dielectric' && pointInPolygon(v.polygon, x, y)) {
        stack.push(v.el);
      }
    }

    for (let bounce = 0; bounce < MAX_BOUNCES; bounce++) {
      // Find nearest intersection among element edges and bench walls.
      let tBest = Infinity, hitEdge = null, hitWall = null;

      for (let i = 0; i < edges.length; i++) {
        const e = edges[i];
        const t = raySeg(x, y, vx, vy, e.p1.x, e.p1.y, e.p2.x, e.p2.y);
        if (t !== null && t < tBest) { tBest = t; hitEdge = e; hitWall = null; }
      }
      // Bench walls: reused from the Tracer; populated in trace().
      for (let i = 0; i < walls.length; i++) {
        const w = walls[i];
        const t = raySeg(x, y, vx, vy, w.p1.x, w.p1.y, w.p2.x, w.p2.y);
        if (t !== null && t < tBest) { tBest = t; hitEdge = null; hitWall = w; }
      }

      if (tBest === Infinity) {
        // Shouldn't happen within a closed bench.
        this.emitSeg(x, y, x + vx * 1000, y + vy * 1000, rgb, I);
        return;
      }

      const hx = x + vx * tBest, hy = y + vy * tBest;

      // Beer-Lambert absorption along the segment if it was inside a medium.
      // Per-element color overrides the material's absorption band.
      let Iend = I;
      if (stack.length > 0) {
        const insideEl = stack[stack.length - 1];
        const inMat = materialOptics(insideEl.material);
        const alpha = elementAbsorption(insideEl, inMat, wl);
        if (alpha > 0) {
          const d = Math.hypot(hx - x, hy - y);
          Iend = I * Math.exp(-alpha * d);
        }
      }
      this.emitSeg(x, y, hx, hy, rgb, I, Iend);
      I = Iend;

      if (hitWall) {
        if (hitWall.kind === 'sensor') {
          const sIdx = Math.min(this.sensorCount - 1, Math.max(0, Math.floor(hy / sensorStripH)));
          const binIdx = Math.min(this.binCount - 1, Math.max(0,
            Math.floor((wl - 380) / (780 - 380) * this.binCount)));
          this.sensorBins[sIdx * this.binCount + binIdx] += I;
        }
        return;
      }

      const elInfo = elementMap.get(hitEdge.elementId);
      const matObj = materialOptics(elInfo.el.material);
      if (!matObj) return;

      if (matObj.type === 'mirror') {
        // Wavelength-dependent reflectance; non-reflected fraction is absorbed.
        const nx = hitEdge.nx, ny = hitEdge.ny;
        const vdotn = vx * nx + vy * ny;
        vx = vx - 2 * vdotn * nx;
        vy = vy - 2 * vdotn * ny;
        I *= elementReflectance(elInfo.el, matObj, wl);
      } else {
        // Dielectric: Snell with Sellmeier (or Cauchy) dispersion.
        // vdotn_out decides enter/exit of *this* polygon; n1/n2 are resolved
        // from the stack so nested/overlapping dielectrics refract correctly.
        const nGlass = materialN(matObj, wl);

        let nx = hitEdge.nx, ny = hitEdge.ny;
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
          // Temporarily remove this element from the stack so n2 is the
          // medium surrounding it. Re-add on TIR.
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
          // Total internal reflection: bounce, stack unchanged.
          const vd = vx * (-snx) + vy * (-sny);
          vx = vx - 2 * vd * (-snx);
          vy = vy - 2 * vd * (-sny);
          if (!entering && poppedIdx >= 0) {
            // Roll back the pop — we didn't actually cross.
            stack.splice(poppedIdx, 0, elInfo.el);
          }
        } else {
          const cosT = Math.sqrt(1 - sin2T);
          vx = eta * vx + (eta * cosI - cosT) * snx;
          vy = eta * vy + (eta * cosI - cosT) * sny;
          if (entering) stack.push(elInfo.el);
          // Exit case: pop already performed above, stays popped.
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
    const i = this.segmentCount * 12;
    const d = this.segmentData;
    d[i    ] = x1; d[i + 1] = y1; d[i + 2] = x2; d[i + 3] = y2;
    d[i + 4] = rgb[0] * I1; d[i + 5] = rgb[1] * I1; d[i + 6] = rgb[2] * I1; d[i + 7] = I1;
    d[i + 8] = rgb[0] * I2; d[i + 9] = rgb[1] * I2; d[i + 10] = rgb[2] * I2; d[i + 11] = I2;
    this.segmentCount++;
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
