#!/usr/bin/env node
// Generate a tracer reference snapshot for a scene.
//
// Usage:
//   node tools/trace-snapshot.js [preset-name]
//   node tools/trace-snapshot.js prism-rainbow
//   node tools/trace-snapshot.js                 # runs all presets + empty scene
//
// Output: test/snapshots/<name>.json
//
// Each snapshot contains the scene config, ray input parameters, segment
// output, and sensor bins. A future GPU tracer can compare its output
// against these snapshots to verify correctness.

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { Tracer } from '../docs/js/raytracer.js';
import { createScene, deserializeScene } from '../docs/js/scene.js';

const SNAPSHOT_DIR = 'test/snapshots';
mkdirSync(SNAPSHOT_DIR, { recursive: true });

function loadPreset(name) {
  const text = readFileSync(`docs/presets/${name}.json`, 'utf-8');
  return deserializeScene(text);
}

function snapshot(name, scene) {
  // Use fixed emitter settings for reproducibility.
  scene.emitter.raysPerSource = Math.min(scene.emitter.raysPerSource, 64);
  scene.runtime = { micLevels: null, wlPerSource: null };

  const tracer = new Tracer();
  tracer.trace(scene);

  // Extract segment data.
  const segments = [];
  for (let i = 0; i < tracer.segmentCount; i++) {
    const off = i * 12;
    segments.push({
      p1x: tracer.segmentData[off + 0],
      p1y: tracer.segmentData[off + 1],
      p2x: tracer.segmentData[off + 2],
      p2y: tracer.segmentData[off + 3],
      c1r: tracer.segmentData[off + 4],
      c1g: tracer.segmentData[off + 5],
      c1b: tracer.segmentData[off + 6],
      I1:  tracer.segmentData[off + 7],
      c2r: tracer.segmentData[off + 8],
      c2g: tracer.segmentData[off + 9],
      c2b: tracer.segmentData[off + 10],
      I2:  tracer.segmentData[off + 11],
    });
  }

  // Extract sensor bins.
  const sensorBins = [];
  for (let s = 0; s < tracer.sensorCount; s++) {
    const bins = [];
    for (let b = 0; b < tracer.binCount; b++) {
      bins.push(tracer.sensorBins[s * tracer.binCount + b]);
    }
    sensorBins.push(bins);
  }

  // Sensor totals for quick comparison.
  const sensorTotals = sensorBins.map(bins => bins.reduce((a, b) => a + b, 0));

  const snap = {
    name,
    scene: {
      bench: scene.bench,
      emitter: { ...scene.emitter, disabled: [...(scene.emitter.disabled ?? [])] },
      sensorCount: scene.sensorCount,
      elementCount: scene.elements.length,
      elements: scene.elements.map(({ _selected, ...rest }) => rest),
    },
    output: {
      segmentCount: tracer.segmentCount,
      segments,
      sensorCount: tracer.sensorCount,
      binCount: tracer.binCount,
      sensorBins,
      sensorTotals,
    },
  };

  const path = `${SNAPSHOT_DIR}/${name}.json`;
  writeFileSync(path, JSON.stringify(snap, null, 2));
  console.log(`  ${name}: ${tracer.segmentCount} segments, ${tracer.sensorCount} sensors → ${path}`);
  return snap;
}

// --- Run ---
const presetArg = process.argv[2];

if (presetArg) {
  const scene = loadPreset(presetArg);
  snapshot(presetArg, scene);
} else {
  // Empty scene (straight-through).
  const empty = createScene();
  empty.emitter.count = 8;
  empty.emitter.raysPerSource = 32;
  empty.sensorCount = 8;
  snapshot('empty', empty);

  // All presets (index + test presets).
  const index = JSON.parse(readFileSync('docs/presets/index.json', 'utf-8'));
  const testPresets = [
    'test-nested', 'test-tir', 'test-grazing', 'test-multibounce',
    'test-hyper-refract', 'test-dichroic-chain', 'test-mixed',
    'test-concave-mirror', 'test-convex-mirror',
  ];
  const all = index.map(e => e.file.replace('.json', '')).concat(testPresets);
  for (const name of all) {
    try {
      const scene = loadPreset(name);
      snapshot(name, scene);
    } catch (err) {
      console.error(`  ${name}: ERROR — ${err.message}`);
    }
  }
}
