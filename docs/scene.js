// Scene data model + geometry builders + JSON serialization.
// Coordinates are in "bench pixels" matching the canvas backing store.

import { MATERIALS } from './spectrum.js';

let nextId = 1;
const genId = () => nextId++;

export function createScene() {
  return {
    bench: { w: 1600, h: 900 },
    emitter: {
      count: 10, wlMin: 400, wlMax: 700,
      raysPerSource: 512, spreadDeg: 0, apertureFactor: 0.01,
    },
    sensorCount: 16,
    elements: [],
    version: 1,
  };
}

export function makeElement(kind, x, y) {
  const base = { id: genId(), kind, x, y, rot: 0 };
  switch (kind) {
    // Default rotations are chosen so that horizontal rays from the left
    // produce a visible optical effect on placement:
    //   prism  — π/6 (~30°): left face at ~50° incidence, well above the
    //            ~44° TIR cutoff for flint. Dispersion is visible.
    //   block  — π/6: otherwise axis-aligned → 0° incidence → ray exits
    //            parallel, no visible refraction.
    //   mirror — π/4 (45°): otherwise horizontal strip that parallel rays
    //            skim past; at 45° it reflects horizontal rays vertically.
    //   lenses — 0: on-axis is the correct optical orientation.
    case 'prism':        return { ...base, rot: Math.PI / 6, size: 120, material: 'flint' };
    case 'block':        return { ...base, rot: Math.PI / 6, w: 180, h: 80, material: 'crown' };
    case 'lens-convex':  return { ...base, h: 110, radius: 220, material: 'crown' };
    case 'lens-concave': return { ...base, w: 30, h: 110, radius: 220, material: 'crown' };
    case 'mirror':       return { ...base, rot: Math.PI / 4, w: 180, h: 6, material: 'mirror' };
    case 'rabbit':       return { ...base, size: 140, material: 'crown' };
    default: throw new Error('unknown element kind: ' + kind);
  }
}

// Local-space polygon vertices for an element.
export function localPolygon(el) {
  switch (el.kind) {
    case 'prism': {
      const s = el.size, h = s * Math.sqrt(3) / 2;
      return [
        { x: 0, y: -2 * h / 3 },
        { x: s / 2, y: h / 3 },
        { x: -s / 2, y: h / 3 },
      ];
    }
    case 'block':
    case 'mirror': {
      const w = el.w / 2, h = el.h / 2;
      return [
        { x: -w, y: -h }, { x: w, y: -h },
        { x: w, y: h },   { x: -w, y: h },
      ];
    }
    case 'lens-convex': {
      const R = el.radius;
      const hh = Math.min(el.h, R * 0.97);
      const phi = Math.asin(hh / R);
      const w = R - R * Math.cos(phi);     // sagitta
      const cxR = -(R - w), cxL = (R - w);
      const N = 24;
      const pts = [];
      // Right arc: angle -phi -> +phi; (0,-h) -> (w,0) -> (0,h)
      for (let i = 0; i <= N; i++) {
        const a = -phi + (2 * phi) * (i / N);
        pts.push({ x: cxR + R * Math.cos(a), y: R * Math.sin(a) });
      }
      // Left arc: angle π-phi -> π+phi; (0,h) -> (-w,0) -> (0,-h)
      for (let i = 1; i < N; i++) {
        const a = (Math.PI - phi) + (2 * phi) * (i / N);
        pts.push({ x: cxL + R * Math.cos(a), y: R * Math.sin(a) });
      }
      return pts;
    }
    case 'rabbit': {
      const u = el.size * 0.01;
      // Rabbit silhouette — ears up, body below. Non-convex polygon;
      // pointInPolygon and per-edge normals handle that fine as long as
      // winding is consistent (clockwise in y-down).
      const pts = [
        [10, -30], [15, -55], [20, -75], [28, -55], [30, -30],
        [45, -15], [50,  10], [45,  35], [30,  45], [ 0,  48],
        [-30, 45], [-45, 35], [-50, 10], [-45, -15], [-30, -30],
        [-28, -55], [-20, -75], [-15, -55], [-10, -30], [0, -25],
      ];
      return pts.map(([x, y]) => ({ x: x * u, y: y * u }));
    }
    case 'lens-concave': {
      const R = el.radius;
      const hh = Math.min(el.h, R * 0.97);
      const w = el.w;
      const alpha = Math.asin(hh / R);
      const d = R - Math.sqrt(R * R - hh * hh);
      const cR = w - d + R;
      const cL = -(w - d + R);
      const N = 20;
      const pts = [];
      pts.push({ x: -w, y: -hh });
      pts.push({ x: w, y: -hh });
      // Right concave arc traversed (w,-h) -> (w-d,0) -> (w,h)
      for (let i = 1; i < N; i++) {
        const t = (Math.PI + alpha) - (2 * alpha) * (i / N);
        pts.push({ x: cR + R * Math.cos(t), y: R * Math.sin(t) });
      }
      pts.push({ x: w, y: hh });
      pts.push({ x: -w, y: hh });
      for (let i = 1; i < N; i++) {
        const t = alpha - (2 * alpha) * (i / N);
        pts.push({ x: cL + R * Math.cos(t), y: R * Math.sin(t) });
      }
      return pts;
    }
  }
}

// World-space edges with outward normals.
export function worldEdges(el) {
  const local = localPolygon(el);
  const cos = Math.cos(el.rot), sin = Math.sin(el.rot);
  const world = local.map(p => ({
    x: el.x + p.x * cos - p.y * sin,
    y: el.y + p.x * sin + p.y * cos,
  }));
  // Signed twice-area via shoelace.
  let twiceArea = 0;
  for (let i = 0; i < world.length; i++) {
    const a = world[i], b = world[(i + 1) % world.length];
    twiceArea += a.x * b.y - b.x * a.y;
  }
  // In y-down screen coords: twiceArea > 0 is clockwise *visually*.
  // For a CW polygon, outward normal = edge rotated 90° CW, i.e. (dy, -dx).
  // For CCW, rotate 90° CCW, i.e. (-dy, dx).
  const cw = twiceArea > 0;
  const edges = [];
  for (let i = 0; i < world.length; i++) {
    const a = world[i], b = world[(i + 1) % world.length];
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1e-9;
    const nx = cw ? dy / len : -dy / len;
    const ny = cw ? -dx / len : dx / len;
    edges.push({ p1: a, p2: b, nx, ny, elementId: el.id });
  }
  return { edges, polygon: world };
}

export function pointInPolygon(poly, x, y) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y;
    const xj = poly[j].x, yj = poly[j].y;
    if ((yi > y) !== (yj > y) &&
        x < (xj - xi) * (y - yi) / (yj - yi + 1e-12) + xi)
      inside = !inside;
  }
  return inside;
}

export function materialOptics(matKey) {
  const m = MATERIALS[matKey];
  if (!m) return null;
  return m;
}

export function serializeScene(scene) {
  return JSON.stringify({
    version: scene.version,
    bench: scene.bench,
    emitter: scene.emitter,
    sensorCount: scene.sensorCount,
    elements: scene.elements.map(({ _selected, ...rest }) => rest),
  }, null, 2);
}

export function deserializeScene(text) {
  const data = JSON.parse(text);
  if (!data || data.version !== 1) throw new Error('unsupported scene version');
  const scene = createScene();
  scene.bench = data.bench;
  scene.emitter = { apertureFactor: 0.01, ...data.emitter };
  scene.sensorCount = data.sensorCount;
  scene.elements = data.elements.map(e => ({ ...e, id: genId() }));
  return scene;
}
