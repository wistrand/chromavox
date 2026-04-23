// Tests for docs/js/auto-place.js against the "Visa från Utanmyra"
// song — a characterful 35-emitter, 112 BPM, E-minor piece where the
// melody sits in emitters ~19–34 (upper half) and the bass in 0–8.
//
// Invariants we care about (for any random draw):
//   - returned element is inside the bench
//   - returned element doesn't overlap any existing scene element
//   - returned element's AABB doesn't fall into the song's melody band
//   - if the scene had no spinning elements, exactly one tempo-sync
//     spin adjustment is returned (targeting an existing element)
//   - song analysis matches the _scale annotation (melody upper, bass
//     lower, bpm and duration intact)

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { test, assert, assertClose } from './run.js';
import {
  autoPlace, analyzeSong, analyzeScene,
} from '../docs/js/auto-place.js';
import {
  createScene, makeElement, worldEdges, overlapsAny,
} from '../docs/js/scene.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SONG_PATH = resolve(__dirname, '../docs/songs/visa-fran-utanmyra.json');
const song = JSON.parse(readFileSync(SONG_PATH, 'utf8'));

// --- Helpers ---

// Build a scene seeded with the song's first-keyframe elements, so the
// existing-element set matches what a user would see on load.
function sceneFromFirstKeyframe() {
  const scene = createScene();
  scene.emitter.count = song.global.emitter.count;
  scene.sensorCount = song.global.sensorCount;
  const kf = song.keyframes[0];
  for (const data of kf.elements) {
    const el = makeElement(data.kind, data.x, data.y);
    Object.assign(el, data);
    scene.elements.push(el);
  }
  return scene;
}

function aabb(el) {
  const poly = worldEdges(el).polygon;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of poly) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, maxX, minY, maxY };
}

function melodyYRange(features, scene) {
  const stripH = scene.bench.h / scene.emitter.count;
  return {
    yLo: scene.bench.h - (features.melodyHi + 1) * stripH,
    yHi: scene.bench.h - features.melodyLo * stripH,
  };
}

// --- analyzeSong ---

test('auto-place: analyzeSong preserves bpm and duration', () => {
  const scene = sceneFromFirstKeyframe();
  const f = analyzeSong(song, scene);
  assert(f.bpm === 112, 'bpm from song');
  assertClose(f.duration, 34.286, 1e-3);
  assert(f.N === 35, 'emitter count from song global');
});

test('auto-place: analyzeSong detects melody in upper emitters', () => {
  // Utanmyra's melody lives in emitters 19–34 per the song's own _scale
  // annotation; the weighted centroid should fall well above mid-range.
  const scene = sceneFromFirstKeyframe();
  const f = analyzeSong(song, scene);
  assert(f.centroid > 18,
    `centroid should be upper-half (got ${f.centroid.toFixed(1)}, N=35)`);
  // Melody band's peak must sit in the upper half.
  const peak = (f.melodyLo + f.melodyHi) / 2;
  assert(peak >= 18, `melody peak ≥ 18 (got ${peak.toFixed(1)})`);
  // Melody band is capped to N/2 = 17 emitters wide.
  assert(f.melodyHi - f.melodyLo + 1 <= Math.ceil(f.N / 2) + 1,
    'melody band capped near N/2');
});

test('auto-place: analyzeSong quiet band is outside melody', () => {
  const scene = sceneFromFirstKeyframe();
  const f = analyzeSong(song, scene);
  const overlapsMelody =
    f.quietLo <= f.melodyHi && f.quietHi >= f.melodyLo;
  assert(!overlapsMelody,
    `quiet [${f.quietLo}..${f.quietHi}] must not overlap melody ` +
    `[${f.melodyLo}..${f.melodyHi}]`);
});

test('auto-place: analyzeSong bass ratio is present but smaller than treble', () => {
  const scene = sceneFromFirstKeyframe();
  const f = analyzeSong(song, scene);
  assert(f.bassRatio > 0, 'bass ratio > 0 (song has bass notes)');
  assert(f.trebleRatio > f.bassRatio,
    `treble (${f.trebleRatio.toFixed(2)}) > bass (${f.bassRatio.toFixed(2)}) ` +
    `for a melody-in-upper piece`);
});

// --- analyzeScene ---

test('auto-place: analyzeScene flags Utanmyra starter elements', () => {
  const scene = sceneFromFirstKeyframe();
  const syn = analyzeScene(scene);
  assert(syn.hasPrism, 'has prism');
  assert(syn.hasLensConvex, 'has convex lens');
  assert(syn.hasMirrorConcave, 'has concave mirror');
  assert(syn.hasSpinning, 'prism-bottom has spin 0.14');
  assert(syn.prisms.length === 1);
  assert(syn.lensesConvex.length === 1);
  assert(syn.mirrorsConcave.length === 1);
});

// --- autoPlace end-to-end ---

test('auto-place: returns a valid element placed inside bench', () => {
  const scene = sceneFromFirstKeyframe();
  const result = autoPlace(scene, song);
  assert(!result.error, `expected success, got error: ${result.error || ''}`);
  assert(result.element, 'element returned');
  const el = result.element;
  assert(el.x > 0 && el.x < scene.bench.w, 'x in bench');
  assert(el.y > 0 && el.y < scene.bench.h, 'y in bench');
  const box = aabb(el);
  assert(box.minX > 0 && box.maxX < scene.bench.w, 'AABB x inside bench');
  assert(box.minY > 0 && box.maxY < scene.bench.h, 'AABB y inside bench');
});

test('auto-place: returned element does not overlap existing scene', () => {
  const scene = sceneFromFirstKeyframe();
  const result = autoPlace(scene, song);
  assert(!result.error, result.error);
  assert(!overlapsAny(result.element, scene.elements),
    'element must not overlap existing');
});

test('auto-place: returned element avoids the melody band', () => {
  const scene = sceneFromFirstKeyframe();
  const result = autoPlace(scene, song);
  assert(!result.error, result.error);
  const f = analyzeSong(song, scene);
  const mel = melodyYRange(f, scene);
  const box = aabb(result.element);
  const intersects = !(box.maxY < mel.yLo || box.minY > mel.yHi);
  assert(!intersects,
    `element AABB y [${box.minY.toFixed(1)}..${box.maxY.toFixed(1)}] ` +
    `must not intersect melody band [${mel.yLo.toFixed(1)}..${mel.yHi.toFixed(1)}]`);
});

test('auto-place: no spin adjustments when scene already has spin', () => {
  // Utanmyra's first keyframe has a spinning prism, so Auto shouldn't
  // add tempo-sync spin to another element.
  const scene = sceneFromFirstKeyframe();
  const result = autoPlace(scene, song);
  assert(!result.error, result.error);
  assert(Array.isArray(result.adjustments));
  assert(result.adjustments.length === 0,
    `expected 0 adjustments (scene already spins), got ${result.adjustments.length}`);
});

test('auto-place: tempo-syncs one element when nothing was spinning', () => {
  // Strip spin from the seed scene to trigger the sync-one path.
  const scene = sceneFromFirstKeyframe();
  for (const el of scene.elements) el.spin = 0;
  const result = autoPlace(scene, song);
  assert(!result.error, result.error);
  assert(result.adjustments.length === 1,
    `expected 1 spin adjustment, got ${result.adjustments.length}`);
  const adj = result.adjustments[0];
  assert(typeof adj.spin === 'number' && adj.spin !== 0, 'spin value nonzero');
  // Target is one of the existing elements.
  const target = scene.elements.find(e => e.id === adj.id);
  assert(target, 'adjustment id matches existing element');
  // Cap is ±π rad/s (the ±180°/s slider range).
  assert(Math.abs(adj.spin) <= Math.PI + 1e-6,
    `spin magnitude ≤ π, got ${adj.spin}`);
});

test('auto-place: produces varied kinds across repeated calls', () => {
  // Randomness-driven, but over enough draws the set of picked kinds
  // should contain at least two distinct entries on this song + scene.
  const seen = new Set();
  for (let i = 0; i < 40; i++) {
    const scene = sceneFromFirstKeyframe();
    const r = autoPlace(scene, song);
    if (!r.error) seen.add(r.element.kind);
    if (seen.size >= 2) break;
  }
  assert(seen.size >= 2,
    `expected ≥ 2 distinct kinds over 40 draws, saw only {${[...seen].join(', ')}}`);
});

test('auto-place: works with no song (scene-only fallback)', () => {
  const scene = sceneFromFirstKeyframe();
  const result = autoPlace(scene, null);
  assert(!result.error, `scene-only path should succeed: ${result.error || ''}`);
  assert(result.element, 'element returned');
  // No melody veto when song is absent, but still must not overlap.
  assert(!overlapsAny(result.element, scene.elements));
});
