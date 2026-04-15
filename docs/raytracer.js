// CPU ray tracer. Emits per-frame line segment vertex data for the WebGL2
// renderer and updates per-sensor spectrum bins.

import { wavelengthToRGB, cauchyN } from './spectrum.js';
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

    for (let s = 0; s < nSrc; s++) {
      const ey = (s + 0.5) * srcStripH;
      for (let k = 0; k < raysPer; k++) {
        // Wavelength: sample deterministically across range per source.
        const tW = (s * raysPer + k) / Math.max(1, (nSrc * raysPer - 1));
        const wl = wlMin + wlRange * ((k + 0.5) / raysPer);
        const rgb = wavelengthToRGB(wl);
        // Direction: straight across (+x) with spread.
        const a = (raysPer === 1) ? 0 : (k / (raysPer - 1) - 0.5) * spreadRad;
        const dirX = Math.cos(a), dirY = Math.sin(a);
        const intensity = BASE_INTENSITY / Math.sqrt(raysPer);
        this.castRay(emX, ey, dirX, dirY, wl, rgb, intensity,
                     edges, elementMap, bench, sensorX, sensorStripH);
        // mark tW used
        void tW;
      }
    }
  }

  castRay(ox, oy, dx, dy, wl, rgb, intensity, edges, elementMap, bench, sensorX, sensorStripH) {
    let x = ox, y = oy, vx = dx, vy = dy;
    let I = intensity;

    // Determine starting medium: inside any glass polygon?
    let insideEl = null;
    for (const [id, v] of elementMap) {
      if (pointInPolygon(v.polygon, x, y) && materialOptics(v.el.material)) {
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
      this.emitSeg(x, y, hx, hy, rgb, I);

      if (hitWall) {
        if (hitWall.kind === 'sensor') {
          // Deposit into sensor bin based on y position and wavelength.
          const sIdx = Math.min(this.sensorCount - 1, Math.max(0, Math.floor(hy / sensorStripH)));
          const binIdx = Math.min(this.binCount - 1, Math.max(0,
            Math.floor((wl - 380) / (780 - 380) * this.binCount)));
          this.sensorBins[sIdx * this.binCount + binIdx] += I;
        }
        return; // absorbed
      }

      // Element edge: dispatch by element material.
      const elInfo = elementMap.get(hitEdge.elementId);
      const mat = elInfo.el.material;

      if (mat === 'mirror') {
        // Reflect.
        const nx = hitEdge.nx, ny = hitEdge.ny;
        const vdotn = vx * nx + vy * ny;
        vx = vx - 2 * vdotn * nx;
        vy = vy - 2 * vdotn * ny;
        I *= 0.98;
      } else {
        // Dielectric: Snell with Cauchy dispersion.
        const glass = materialOptics(mat);
        if (!glass) return;
        const nGlass = cauchyN(glass.A, glass.B, wl);

        // Outward normal points away from glass interior (into air).
        let nx = hitEdge.nx, ny = hitEdge.ny;
        const vdotn_out = vx * nx + vy * ny;
        let n1, n2;
        let snx, sny;       // normal pointing into incident medium
        if (vdotn_out < 0) {
          // entering glass
          n1 = 1.0; n2 = nGlass;
          snx = nx; sny = ny;
          insideEl = elInfo.el;
        } else {
          // exiting glass
          n1 = nGlass; n2 = 1.0;
          snx = -nx; sny = -ny;
          insideEl = null;
        }
        const eta = n1 / n2;
        const cosI = -(vx * snx + vy * sny);      // positive
        const sin2T = eta * eta * (1 - cosI * cosI);
        if (sin2T > 1) {
          // Total internal reflection.
          const vdotn = vx * (-snx) + vy * (-sny);
          vx = vx - 2 * vdotn * (-snx);
          vy = vy - 2 * vdotn * (-sny);
        } else {
          const cosT = Math.sqrt(1 - sin2T);
          vx = eta * vx + (eta * cosI - cosT) * snx;
          vy = eta * vy + (eta * cosI - cosT) * sny;
        }
        // Renormalise (guard against drift).
        const len = Math.hypot(vx, vy);
        vx /= len; vy /= len;
        I *= GLASS_LOSS;
      }

      // Advance origin slightly past hit to avoid self-intersection.
      x = hx + vx * EPS * 10;
      y = hy + vy * EPS * 10;
      if (I < 0.002) return;
    }
  }

  emitSeg(x1, y1, x2, y2, rgb, I) {
    this.pushVertex(x1, y1, rgb[0] * I, rgb[1] * I, rgb[2] * I, I);
    this.pushVertex(x2, y2, rgb[0] * I, rgb[1] * I, rgb[2] * I, I);
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
