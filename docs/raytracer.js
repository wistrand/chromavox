// CPU ray tracer. Emits per-frame line segment vertex data for the WebGL2
// renderer and updates per-sensor spectrum bins.

import { wavelengthToRGB, materialN, materialAbsorption, mirrorReflectance } from './spectrum.js';
import { worldEdges, pointInPolygon, materialOptics } from './scene.js';

const EPS = 1e-4;
const MAX_BOUNCES = 12;
const GLASS_LOSS = 0.985;       // per-surface attenuation
const BASE_INTENSITY = 1.6;

// Per-frame output buffers, reused across frames.
export class Tracer {
  constructor() {
    this.vertexData = new Float32Array(0);   // x, y, r, g, b, a per vertex
    this.vertexCount = 0;
    this.sensorBins = null;                    // Float32Array [sensor][bin] flat
    this.sensorCount = 0;
    this.binCount = 64;
  }

  ensureVertexCapacity(n) {
    const needed = n * 6;
    if (this.vertexData.length < needed) {
      this.vertexData = new Float32Array(Math.max(needed, this.vertexData.length * 2 || 4096));
    }
  }

  pushVertex(x, y, r, g, b, a) {
    const i = this.vertexCount * 6;
    this.vertexData[i] = x;
    this.vertexData[i + 1] = y;
    this.vertexData[i + 2] = r;
    this.vertexData[i + 3] = g;
    this.vertexData[i + 4] = b;
    this.vertexData[i + 5] = a;
    this.vertexCount++;
  }

  // Main trace call. Produces line segments and sensor deposits.
  trace(scene) {
    this.vertexCount = 0;
    const { bench, emitter, sensorCount, elements } = scene;

    // Build edges for all elements.
    const edges = [];
    const elementMap = new Map();
    for (const el of elements) {
      const { edges: eEdges, polygon } = worldEdges(el);
      elementMap.set(el.id, { el, polygon });
      for (const e of eEdges) edges.push(e);
    }

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
    this.ensureVertexCapacity(totalRays * (MAX_BOUNCES + 1) * 2);

    const wlMin = emitter.wlMin, wlMax = emitter.wlMax;
    const wlRange = Math.max(1, wlMax - wlMin);
    const wlPer = emitter.wlPerSource;

    // Source is modelled as an extended aperture across its y-strip. Rays
    // are emitted from random-looking positions along the aperture with
    // decorrelated wavelengths and small angular jitter, so each beam looks
    // like a wide continuous ribbon of light rather than a visible fan.
    const PHI = 0.6180339887498949;
    const PSI = 0.7548776662466927;
    for (let s = 0; s < nSrc; s++) {
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
                     edges, elementMap, bench, sensorX, sensorStripH);
      }
    }
  }

  castRay(ox, oy, dx, dy, wl, rgb, intensity, edges, elementMap, bench, sensorX, sensorStripH) {
    let x = ox, y = oy, vx = dx, vy = dy;
    let I = intensity;

    // Determine starting medium: inside any dielectric polygon?
    let insideEl = null;
    for (const [, v] of elementMap) {
      const m = materialOptics(v.el.material);
      if (m && m.type === 'dielectric' && pointInPolygon(v.polygon, x, y)) {
        insideEl = v.el; break;
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
      // Bench walls: top, bottom, left (behind), right (sensors).
      const walls = [
        { p1: { x: 0, y: 0 },          p2: { x: bench.w, y: 0 },          kind: 'abs' },
        { p1: { x: bench.w, y: 0 },    p2: { x: bench.w, y: bench.h },    kind: 'sensor' },
        { p1: { x: bench.w, y: bench.h }, p2: { x: 0, y: bench.h },       kind: 'abs' },
        { p1: { x: 0, y: bench.h },    p2: { x: 0, y: 0 },                kind: 'abs' },
      ];
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
      let Iend = I;
      if (insideEl) {
        const inMat = materialOptics(insideEl.material);
        const alpha = materialAbsorption(inMat, wl);
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
        I *= mirrorReflectance(matObj, wl);
      } else {
        // Dielectric: Snell with Sellmeier (or Cauchy) dispersion.
        const nGlass = materialN(matObj, wl);

        let nx = hitEdge.nx, ny = hitEdge.ny;
        const vdotn_out = vx * nx + vy * ny;
        let n1, n2;
        let snx, sny;
        if (vdotn_out < 0) {
          n1 = 1.0; n2 = nGlass;
          snx = nx; sny = ny;
          insideEl = elInfo.el;
        } else {
          n1 = nGlass; n2 = 1.0;
          snx = -nx; sny = -ny;
          insideEl = null;
        }
        const eta = n1 / n2;
        const cosI = -(vx * snx + vy * sny);
        const sin2T = eta * eta * (1 - cosI * cosI);
        if (sin2T > 1) {
          const vd = vx * (-snx) + vy * (-sny);
          vx = vx - 2 * vd * (-snx);
          vy = vy - 2 * vd * (-sny);
          // TIR stays inside glass — insideEl unchanged from before the exit test.
          insideEl = elInfo.el;
        } else {
          const cosT = Math.sqrt(1 - sin2T);
          vx = eta * vx + (eta * cosI - cosT) * snx;
          vy = eta * vy + (eta * cosI - cosT) * sny;
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
    this.pushVertex(x1, y1, rgb[0] * I1, rgb[1] * I1, rgb[2] * I1, I1);
    this.pushVertex(x2, y2, rgb[0] * I2, rgb[1] * I2, rgb[2] * I2, I2);
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
