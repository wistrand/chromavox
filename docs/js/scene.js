// Scene data model + geometry builders + JSON serialization.
// Coordinates are in "bench pixels" matching the canvas backing store.

import { MATERIALS } from './spectrum.js';
import { ELEMENTS } from './elements.js';

// Stable UUIDs for element IDs — survive serialization, undo/redo,
// and session boundaries. Used by the song format to match elements
// across keyframes.
const genId = () =>
  typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = Math.random() * 16 | 0;
        return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
      });
// Legacy compat: bumpIdCeiling is a no-op with UUIDs.
export function bumpIdCeiling(_n) {}

// Canonical bench: portrait, golden ratio. h / w = φ ≈ 1.618.
// w = round(900 / φ) = 556. The renderer letterboxes the canvas to this
// aspect, so element coordinates are stable across viewport sizes.
export const CANONICAL_BENCH = { w: 556, h: 900 };

let _generation = 0;
export function bumpGeneration(scene) { scene.generation = ++_generation; }

export function createScene() {
  return {
    bench: { ...CANONICAL_BENCH },
    emitter: {
      count: 24, wlMin: 400, wlMax: 700,
      raysPerSource: 512, spreadDeg: 0, apertureFactor: 0.01,
      disabled: new Set(),
    },
    // Transient per-frame state that is never serialized. Replaced
    // wholesale on scene transitions (clear / load / preset) so
    // nothing needs to be manually nulled.
    runtime: { micLevels: null, wlPerSource: null },
    sensorCount: 24,
    elements: [],
    version: 1,
    generation: ++_generation,
  };
}

export function makeElement(kind, x, y) {
  const def = ELEMENTS[kind];
  if (!def) throw new Error('unknown element kind: ' + kind);
  const el = { id: genId(), kind, x, y, rot: 0, material: def.material };
  for (const [key, desc] of Object.entries(def.props)) {
    if (desc.default != null) {
      el[key] = desc.default;
    }
  }
  return el;
}

// Local-space polygon vertices for an element.
export function localPolygon(el) {
  switch (el.kind) {
    case 'diamond': {
      // Round brilliant cut side profile: flat table on top, slanted
      // crown out to the widest girdle, tapering down to a single
      // culet point. Ratios (table half-width, crown height, pavilion
      // depth — all relative to size) are tunable via el.table, el.crown,
      // el.pavilion; defaults come from the element schema.
      const s = el.size;
      const w = s / 2;                          // girdle half-width
      const tw = w * (el.table    ?? 0.53);     // table half-width (Tolkowsky ideal)
      const hc = s * (el.crown    ?? 0.162);    // crown height (34.5° crown angle)
      const hp = s * (el.pavilion ?? 0.431);    // pavilion depth (40.75° pavilion angle)
      return [
        { x: -tw, y: -hc }, // table-left
        { x:  tw, y: -hc }, // table-right
        { x:   w, y:   0 }, // girdle-right
        { x:   0, y:  hp }, // culet
        { x:  -w, y:   0 }, // girdle-left
      ];
    }
    case 'prism': {
      const s = el.size, h = s * Math.sqrt(3) / 2;
      return [
        { x: 0, y: -2 * h / 3 },
        { x: s / 2, y: h / 3 },
        { x: -s / 2, y: h / 3 },
      ];
    }
    case 'circle': {
      const R = el.radius;
      const N = 128;
      const pts = [];
      // Clockwise winding in y-down: angle goes around the right side first.
      for (let i = 0; i < N; i++) {
        const a = (i / N) * 2 * Math.PI;
        pts.push({ x: R * Math.cos(a), y: R * Math.sin(a) });
      }
      return pts;
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
    case 'mirror-concave':
    case 'mirror-convex': {
      const R = el.radius;
      const hh = Math.min(el.h, R * 0.97);
      const phi = Math.asin(hh / R);
      const sag = R - R * Math.cos(phi);
      const convex = el.kind === 'mirror-convex';
      const capThick = 3;
      const N = 24;
      const pts = [];
      if (convex) {
        // Convex: arc center far left at -(R-sag). Surface bulges right.
        // At a=0: x = -(R-sag)+R = sag. At a=±phi: x = 0.
        const cx = -(R - sag);
        pts.push({ x: -capThick, y: -hh });
        for (let i = 0; i <= N; i++) {
          const a = -phi + (2 * phi) * (i / N);
          pts.push({ x: cx + R * Math.cos(a), y: R * Math.sin(a) });
        }
        pts.push({ x: -capThick, y: hh });
      } else {
        // Concave: dish shape, non-convex polygon. Even-odd fill
        // handles it (same as rabbit).
        // Arc center at (R, 0). At angle π+phi: (sag, -hh) = top-right.
        // At angle π: (0, 0) = center. At angle π-phi: (sag, +hh) = bot.
        // CW in y-down: back-top → top-right → arc sweeping down through
        // recessed center → bottom-right → back-bottom.
        const cx = R;
        pts.push({ x: -capThick, y: -hh });  // back top-left
        pts.push({ x: sag, y: -hh });         // top cap right
        // Arc: sweep π+phi → π-phi (top to bottom through center)
        for (let i = 1; i < N; i++) {
          const a = (Math.PI + phi) - (2 * phi) * (i / N);
          pts.push({ x: cx + R * Math.cos(a), y: R * Math.sin(a) });
        }
        pts.push({ x: sag, y: hh });          // bottom cap right
        pts.push({ x: -capThick, y: hh });    // back bottom-left
      }
      return pts;
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

// Local-space axis-aligned bounding box, returned as `{ w, h }`. Derived
// directly from element schema fields instead of walking the polygon —
// `localPolygon` allocates a fresh array + N `{x, y}` objects per call
// (128 for a circle), which is fine for save/overlap/selection but too
// much for a per-frame path like smoke source packing. O(1), zero
// allocations. Caller multiplies by whatever rotation / position it
// needs externally.
export function localAABB(el) {
  switch (el.kind) {
    case 'diamond': {
      const s = el.size;
      const hc = s * (el.crown    ?? 0.162);
      const hp = s * (el.pavilion ?? 0.431);
      return { w: s, h: hc + hp };
    }
    case 'prism': {
      const s = el.size;
      return { w: s, h: s * Math.sqrt(3) / 2 };
    }
    case 'circle': {
      const d = 2 * el.radius;
      return { w: d, h: d };
    }
    case 'block':
    case 'mirror': {
      return { w: el.w, h: el.h };
    }
    case 'lens-convex': {
      const R = el.radius;
      const hh = Math.min(el.h, R * 0.97);
      const sag = R - Math.sqrt(R * R - hh * hh);
      return { w: 2 * sag, h: 2 * hh };
    }
    case 'lens-concave': {
      const R = el.radius;
      const hh = Math.min(el.h, R * 0.97);
      return { w: 2 * el.w, h: 2 * hh };
    }
    case 'mirror-concave':
    case 'mirror-convex': {
      const R = el.radius;
      const hh = Math.min(el.h, R * 0.97);
      const sag = R - Math.sqrt(R * R - hh * hh);
      // Back cap adds 3 px behind the arc on the axis.
      return { w: sag + 3, h: 2 * hh };
    }
    case 'rabbit': {
      // Bounds read once from the hardcoded polygon in localPolygon:
      // x ∈ [-50, +50] (w = 100), y ∈ [-75, +48] (h = 123).
      const u = el.size * 0.01;
      return { w: 100 * u, h: 123 * u };
    }
  }
  return { w: 100, h: 100 }; // unknown kind — generic default
}

// World-space edges with outward normals.  Returns a mix of segment and
// arc edges.  Segment: { type:'seg', p1, p2, nx, ny, elementId }.
// Arc: { type:'arc', cx, cy, R, a0, a1, convex, elementId }.
// `polygon` is always the dense vertex list (for pointInPolygon / overlap).
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
  const cw = twiceArea > 0;

  // Arc-bearing elements: emit analytic arcs instead of polygon facets.
  const arcEdges = _arcEdges(el, cos, sin, cw);
  if (arcEdges) return { edges: arcEdges, polygon: world };

  // Polygon-only elements (prism, block, mirror, rabbit).
  const edges = [];
  for (let i = 0; i < world.length; i++) {
    const a = world[i], b = world[(i + 1) % world.length];
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1e-9;
    const nx = cw ? dy / len : -dy / len;
    const ny = cw ? -dx / len : dx / len;
    edges.push({ type: 'seg', p1: a, p2: b, nx, ny, elementId: el.id });
  }
  return { edges, polygon: world };
}

// Build analytic arc edges for lens-convex, lens-concave, circle,
// mirror-concave, mirror-convex.  Returns null for non-arc elements.
function _arcEdges(el, cos, sin, cw) {
  const TWO_PI = 2 * Math.PI;
  const id = el.id;

  // Transform a local-space point to world.
  const toW = (lx, ly) => ({
    x: el.x + lx * cos - ly * sin,
    y: el.y + lx * sin + ly * cos,
  });
  // Rotate an angle by the element rotation.
  const rotA = a => {
    let r = a + el.rot;
    // Normalize to (-pi, pi].
    r = r - TWO_PI * Math.floor((r + Math.PI) / TWO_PI);
    return r;
  };

  if (el.kind === 'circle') {
    // Full circle: one arc, a0=0, a1=2pi (full).
    const wc = toW(0, 0);
    return [{ type: 'arc', cx: wc.x, cy: wc.y, R: el.radius,
              a0: rotA(0), a1: rotA(0) + TWO_PI, convex: true, elementId: id }];
  }

  if (el.kind === 'lens-convex') {
    const R = el.radius;
    const hh = Math.min(el.h, R * 0.97);
    const phi = Math.asin(hh / R);
    const w = R - R * Math.cos(phi);
    // Right arc: center at local (-(R-w), 0), spans angle -phi to +phi.
    const cxR = -(R - w);
    const wcR = toW(cxR, 0);
    // Left arc: center at local (R-w, 0), spans angle pi-phi to pi+phi.
    const cxL = R - w;
    const wcL = toW(cxL, 0);
    return [
      { type: 'arc', cx: wcR.x, cy: wcR.y, R, a0: rotA(-phi), a1: rotA(phi),
        convex: true, elementId: id },
      { type: 'arc', cx: wcL.x, cy: wcL.y, R, a0: rotA(Math.PI - phi), a1: rotA(Math.PI + phi),
        convex: true, elementId: id },
    ];
  }

  if (el.kind === 'lens-concave') {
    const R = el.radius;
    const hh = Math.min(el.h, R * 0.97);
    const w = el.w;
    const alpha = Math.asin(hh / R);
    const d = R - Math.sqrt(R * R - hh * hh);
    const cR = w - d + R;       // local x of right arc center
    const cL = -(w - d + R);    // local x of left arc center
    const wcR = toW(cR, 0);
    const wcL = toW(cL, 0);
    // Right concave arc: center far right, small arc around angle π.
    // CCW span from (π-α) to (π+α) = 2α.
    const rA0 = Math.PI - alpha, rA1 = Math.PI + alpha;
    // Left concave arc: center far left, small arc around angle 0.
    // CCW span from -α to +α = 2α.
    const lA0 = -alpha, lA1 = alpha;
    // Flat cap edges: top and bottom.
    const tl = toW(-w, -hh), tr = toW(w, -hh);
    const bl = toW(-w, hh), br = toW(w, hh);
    const edges = [];
    // Top cap.
    edges.push(_segEdge(tl, tr, cw, id));
    // Right concave arc.
    edges.push({ type: 'arc', cx: wcR.x, cy: wcR.y, R,
      a0: rotA(rA0), a1: rotA(rA1), convex: false, elementId: id });
    // Bottom cap.
    edges.push(_segEdge(br, bl, cw, id));
    // Left concave arc.
    edges.push({ type: 'arc', cx: wcL.x, cy: wcL.y, R,
      a0: rotA(lA0), a1: rotA(lA1), convex: false, elementId: id });
    return edges;
  }

  if (el.kind === 'mirror-concave' || el.kind === 'mirror-convex') {
    const R = el.radius;
    const hh = Math.min(el.h, R * 0.97);
    const phi = Math.asin(hh / R);
    const sag = R - R * Math.cos(phi);
    const convex = el.kind === 'mirror-convex';
    const capThick = 3;
    let lcx, a0, a1;
    if (convex) {
      // Center far left at -(R-sag), arc spans -phi to +phi.
      lcx = -(R - sag);
      a0 = -phi; a1 = phi;
    } else {
      // Center far right at R, arc spans π-phi to π+phi.
      lcx = R;
      a0 = Math.PI - phi; a1 = Math.PI + phi;
    }
    const wc = toW(lcx, 0);
    // Arc edge endpoints: convex at x=0, concave at x=sag.
    const edgeX = convex ? 0 : sag;
    const topBack = toW(-capThick, -hh), topArc = toW(edgeX, -hh);
    const botBack = toW(-capThick, hh), botArc = toW(edgeX, hh);
    const edges = [];
    edges.push(_segEdge(topBack, topArc, cw, id));
    edges.push({ type: 'arc', cx: wc.x, cy: wc.y, R,
      a0: rotA(a0), a1: rotA(a1), convex, elementId: id });
    edges.push(_segEdge(botArc, botBack, cw, id));
    edges.push(_segEdge(botBack, topBack, cw, id));
    return edges;
  }

  return null; // Not an arc-bearing element.
}

function _segEdge(a, b, cw, elementId) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1e-9;
  const nx = cw ? dy / len : -dy / len;
  const ny = cw ? -dx / len : dx / len;
  return { type: 'seg', p1: a, p2: b, nx, ny, elementId };
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

// --- Overlap detection ---

function edgesIntersect(e1, e2) {
  const d1x = e1.p2.x - e1.p1.x, d1y = e1.p2.y - e1.p1.y;
  const d2x = e2.p2.x - e2.p1.x, d2y = e2.p2.y - e2.p1.y;
  const denom = d1x * d2y - d1y * d2x;
  if (Math.abs(denom) < 1e-9) return false;
  const ex = e2.p1.x - e1.p1.x, ey = e2.p1.y - e1.p1.y;
  const t = (ex * d2y - ey * d2x) / denom;
  const u = (ex * d1y - ey * d1x) / denom;
  return t > 0 && t < 1 && u > 0 && u < 1;
}

export function elementsOverlap(elA, elB) {
  // Use the dense polygon for overlap — no arc intersection needed.
  const a = worldEdges(elA), b = worldEdges(elB);
  const aSegs = _polySegs(a.polygon);
  const bSegs = _polySegs(b.polygon);
  for (const ea of aSegs) {
    for (const eb of bSegs) {
      if (edgesIntersect(ea, eb)) return true;
    }
  }
  if (pointInPolygon(b.polygon, elA.x, elA.y)) return true;
  if (pointInPolygon(a.polygon, elB.x, elB.y)) return true;
  return false;
}

function _polySegs(poly) {
  const segs = [];
  for (let i = 0; i < poly.length; i++) {
    segs.push({ p1: poly[i], p2: poly[(i + 1) % poly.length] });
  }
  return segs;
}

export function overlapsAny(el, elements) {
  for (const other of elements) {
    if (other === el) continue;
    if (elementsOverlap(el, other)) return true;
  }
  return false;
}

export function materialOptics(matKey) {
  const m = MATERIALS[matKey];
  if (!m) return null;
  return m;
}

// Plural forms for element kinds. `${count} ${_pluralKind[kind]}`.
const _PLURAL_KIND = {
  prism: 'prisms',
  block: 'blocks',
  'lens-convex': 'convex lenses',
  'lens-concave': 'concave lenses',
  mirror: 'mirrors',
  'mirror-concave': 'concave mirrors',
  'mirror-convex': 'convex mirrors',
  circle: 'circles',
  rabbit: 'rabbits',
};
function _kindPhrase(kind, count) {
  const lbl = (ELEMENTS[kind]?.label || kind).toLowerCase();
  if (count === 1) return lbl;
  return `${count} ${_PLURAL_KIND[kind] || lbl}`;
}

// Compact auto-title from scene content. Examples:
//   "empty"
//   "3 prisms - sine"
//   "3 prisms, 2 mirrors - vocoder"
//   "3 prisms, 2 mirrors +1 more - acid"
export function autoTitle(scene) {
  const counts = {};
  for (const el of scene.elements) counts[el.kind] = (counts[el.kind] || 0) + 1;
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  let parts;
  if (entries.length === 0) parts = 'empty';
  else {
    const top = entries.slice(0, 2).map(([k, n]) => _kindPhrase(k, n));
    parts = top.join(', ');
    const rest = entries.length - 2;
    if (rest > 0) parts += ` +${rest} more`;
  }
  const carrier = scene.synth?.carrier;
  return carrier ? `${parts} - ${carrier}` : parts;
}

export function serializeScene(scene) {
  const out = {
    version: scene.version,
    title: autoTitle(scene),
    date: new Date().toISOString(),
    bench: scene.bench,
    emitter: { ...scene.emitter, disabled: [...(scene.emitter.disabled ?? [])] },
    sensorCount: scene.sensorCount,
    elements: scene.elements.map(({ _selected, ...rest }) => rest),
  };
  if (scene.synth) out.synth = scene.synth;
  return JSON.stringify(out, null, 2);
}

export function deserializeScene(text) {
  const data = JSON.parse(text);
  if (!data || data.version !== 1) throw new Error('unsupported scene version');
  const scene = createScene();
  // Preserve the saved bench size. Legacy scenes from before the letterbox
  // change (1600×900) are rescaled to the canonical 556×900; all others
  // keep their coordinates as-is.
  const srcW = data.bench?.w || CANONICAL_BENCH.w;
  const srcH = data.bench?.h || CANONICAL_BENCH.h;
  const legacy = srcW >= 1600 && srcH === 900;
  const sx = legacy ? CANONICAL_BENCH.w / srcW : 1;
  const sy = legacy ? CANONICAL_BENCH.h / srcH : 1;
  const ssize = Math.sqrt(sx * sy);
  scene.bench = legacy
    ? { ...CANONICAL_BENCH }
    : { w: srcW, h: srcH };
  scene.emitter = { apertureFactor: 0.01, ...data.emitter };
  scene.emitter.disabled = new Set(Array.isArray(data.emitter?.disabled) ? data.emitter.disabled : []);
  scene.sensorCount = data.sensorCount;
  const SIZE_KEYS = ['size', 'w', 'h', 'radius'];
  scene.elements = data.elements.map(e => {
    const el = { ...e, id: e.id || genId(), x: e.x * sx, y: e.y * sy };
    if (legacy) {
      for (const k of SIZE_KEYS) {
        if (typeof el[k] === 'number') el[k] *= ssize;
      }
    }
    return el;
  });
  if (data.synth) scene.synth = data.synth;
  if (data.title) scene.title = data.title;
  if (data.date) scene.date = data.date;
  return scene;
}
