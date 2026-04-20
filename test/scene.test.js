import { test, assert, assertClose } from './run.js';
import {
  createScene, makeElement, localPolygon, worldEdges, pointInPolygon,
  materialOptics, serializeScene, deserializeScene, CANONICAL_BENCH,
} from '../docs/scene.js';

// --- createScene ---

test('createScene: returns bench + emitter + sensorCount + elements', () => {
  const s = createScene();
  assert(s.bench && s.bench.w > 0 && s.bench.h > 0);
  assert(s.emitter && typeof s.emitter.count === 'number');
  assert(typeof s.sensorCount === 'number');
  assert(Array.isArray(s.elements));
});

// --- CANONICAL_BENCH ---

test('CANONICAL_BENCH: portrait golden ratio', () => {
  assert(CANONICAL_BENCH.h > CANONICAL_BENCH.w, 'bench should be portrait');
  assertClose(CANONICAL_BENCH.h / CANONICAL_BENCH.w, (1 + Math.sqrt(5)) / 2, 0.02);
});

// --- makeElement ---

test('makeElement: prism has id, kind, position, size, material', () => {
  const el = makeElement('prism', 100, 200);
  assert(el.kind === 'prism');
  assert(el.x === 100 && el.y === 200);
  assert(el.size > 0);
  assert(typeof el.material === 'string');
  assert(typeof el.id === 'string' && el.id.length > 0);
});

test('makeElement: block has w and h', () => {
  const el = makeElement('block', 0, 0);
  assert(el.kind === 'block');
  assert(el.w > 0 && el.h > 0);
});

test('makeElement: mirror defaults to mirror material', () => {
  const el = makeElement('mirror', 0, 0);
  assert(el.material === 'mirror');
});

test('makeElement: ids are unique', () => {
  const a = makeElement('prism', 0, 0);
  const b = makeElement('prism', 0, 0);
  assert(a.id !== b.id, 'consecutive elements should have different ids');
});

// --- localPolygon ---

test('localPolygon: prism returns 3 vertices', () => {
  const el = makeElement('prism', 0, 0);
  const poly = localPolygon(el);
  assert(poly.length === 3, `prism should have 3 vertices, got ${poly.length}`);
});

test('localPolygon: block returns 4 vertices', () => {
  const el = makeElement('block', 0, 0);
  const poly = localPolygon(el);
  assert(poly.length === 4);
});

test('localPolygon: mirror returns 4 vertices', () => {
  const el = makeElement('mirror', 0, 0);
  const poly = localPolygon(el);
  assert(poly.length === 4);
});

// --- worldEdges ---

test('worldEdges: returns edges and polygon', () => {
  const el = makeElement('prism', 100, 200);
  const { edges, polygon } = worldEdges(el);
  assert(edges.length === 3, 'prism has 3 edges');
  assert(polygon.length === 3, 'prism has 3 world vertices');
});

test('worldEdges: edges have normals', () => {
  const el = makeElement('block', 100, 100);
  el.rot = 0;
  const { edges } = worldEdges(el);
  for (const e of edges) {
    assert(typeof e.nx === 'number' && typeof e.ny === 'number');
    const len = Math.hypot(e.nx, e.ny);
    assertClose(len, 1, 0.001, 'normals should be unit length');
  }
});

test('worldEdges: edges carry elementId', () => {
  const el = makeElement('block', 0, 0);
  const { edges } = worldEdges(el);
  assert(edges.every(e => e.elementId === el.id));
});

test('worldEdges: rotation moves vertices', () => {
  const el = makeElement('block', 100, 100);
  el.rot = 0;
  const { polygon: p0 } = worldEdges(el);
  el.rot = Math.PI / 4;
  const { polygon: p1 } = worldEdges(el);
  const moved = p0.some((v, i) => Math.abs(v.x - p1[i].x) > 1 || Math.abs(v.y - p1[i].y) > 1);
  assert(moved, 'rotating should move world vertices');
});

// --- pointInPolygon ---

test('pointInPolygon: center of block is inside', () => {
  const el = makeElement('block', 200, 200);
  el.rot = 0;
  const { polygon } = worldEdges(el);
  assert(pointInPolygon(polygon, 200, 200), 'center should be inside');
});

test('pointInPolygon: far away is outside', () => {
  const el = makeElement('block', 200, 200);
  el.rot = 0;
  const { polygon } = worldEdges(el);
  assert(!pointInPolygon(polygon, 0, 0), 'far point should be outside');
});

test('pointInPolygon: works for prism', () => {
  const el = makeElement('prism', 300, 300);
  el.rot = 0;
  const { polygon } = worldEdges(el);
  assert(pointInPolygon(polygon, 300, 300), 'prism center should be inside');
  assert(!pointInPolygon(polygon, 0, 0), 'far point should be outside');
});

// --- materialOptics ---

test('materialOptics: returns material object for known key', () => {
  const m = materialOptics('crown');
  assert(m && m.type === 'dielectric');
});

test('materialOptics: returns null for unknown key', () => {
  assert(materialOptics('nonexistent') === null);
});

// --- serialize / deserialize ---

test('serializeScene + deserializeScene roundtrip', () => {
  const scene = createScene();
  scene.elements.push(makeElement('prism', 100, 200));
  scene.elements.push(makeElement('block', 300, 400));
  const json = serializeScene(scene);
  const restored = deserializeScene(json);
  assert(restored.elements.length === 2);
  assert(restored.elements[0].kind === 'prism');
  assert(restored.elements[1].kind === 'block');
  assert(restored.bench.w === scene.bench.w);
  assert(restored.emitter.count === scene.emitter.count);
});

test('deserializeScene: rescales to canonical bench', () => {
  const json = JSON.stringify({
    version: 1,
    bench: { w: 100, h: 200 },
    emitter: { count: 4, wlMin: 400, wlMax: 700, raysPerSource: 10, spreadDeg: 0, disabled: [] },
    sensorCount: 8,
    elements: [{ kind: 'prism', x: 50, y: 100, size: 30, material: 'crown', rot: 0 }],
  });
  const restored = deserializeScene(json);
  assertClose(restored.bench.w, CANONICAL_BENCH.w, 1);
  assertClose(restored.bench.h, CANONICAL_BENCH.h, 1);
  assert(restored.elements[0].x !== 50, 'element x should be rescaled');
});

test('serializeScene: output is valid JSON', () => {
  const scene = createScene();
  const json = serializeScene(scene);
  const parsed = JSON.parse(json);
  assert(parsed.version === 1);
});
