#!/usr/bin/env node
// Verify tracer output against reference snapshots.
//
// Usage:
//   node tools/trace-verify.js [snapshot-name]
//   node tools/trace-verify.js prism-rainbow
//   node tools/trace-verify.js                  # verifies all snapshots
//
// Loads each snapshot, re-runs the tracer on the same scene, and compares
// segments and sensor bins. Reports max errors per field.
//
// This is the harness for verifying a future GPU tracer: replace the
// JS tracer call with GPU readback and run the same comparisons.

import { readFileSync, readdirSync } from 'fs';
import { Tracer } from '../docs/js/raytracer.js';
import { createScene, makeElement, deserializeScene } from '../docs/js/scene.js';

const SNAPSHOT_DIR = 'test/snapshots';
const SEG_FLOATS = 12;

// Tolerance: CPU float vs GPU float, or JS re-run (should be exact).
const POS_TOL = 1e-4;     // positions (bench pixels)
const COLOR_TOL = 1e-4;   // premultiplied color channels
const INTENSITY_TOL = 1e-4;
const SENSOR_TOL = 1e-3;  // sensor bin totals (accumulated)

function rebuildScene(snapScene) {
  const scene = createScene();
  Object.assign(scene.bench, snapScene.bench);
  scene.emitter = { ...snapScene.emitter };
  scene.emitter.disabled = new Set(snapScene.emitter.disabled || []);
  scene.sensorCount = snapScene.sensorCount;
  scene.elements = (snapScene.elements || []).map(e => ({ ...e }));
  scene.runtime = { micLevels: null, wlPerSource: null };
  return scene;
}

function verify(name) {
  const snapPath = `${SNAPSHOT_DIR}/${name}.json`;
  const snap = JSON.parse(readFileSync(snapPath, 'utf-8'));
  const scene = rebuildScene(snap.scene);

  const tracer = new Tracer();
  tracer.trace(scene);

  const ref = snap.output;
  const errors = [];

  // --- Segment count ---
  if (tracer.segmentCount !== ref.segmentCount) {
    errors.push(`segment count: got ${tracer.segmentCount}, expected ${ref.segmentCount}`);
  }

  // --- Segment data ---
  const segCount = Math.min(tracer.segmentCount, ref.segmentCount);
  let maxPosErr = 0, maxColorErr = 0, maxIntErr = 0;
  let posErrs = 0, colorErrs = 0, intErrs = 0;
  const fieldNames = ['p1x','p1y','p2x','p2y','c1r','c1g','c1b','I1','c2r','c2g','c2b','I2'];

  for (let i = 0; i < segCount; i++) {
    const off = i * SEG_FLOATS;
    const refSeg = ref.segments[i];
    const vals = [
      refSeg.p1x, refSeg.p1y, refSeg.p2x, refSeg.p2y,
      refSeg.c1r, refSeg.c1g, refSeg.c1b, refSeg.I1,
      refSeg.c2r, refSeg.c2g, refSeg.c2b, refSeg.I2,
    ];
    for (let f = 0; f < SEG_FLOATS; f++) {
      const got = tracer.segmentData[off + f];
      const exp = vals[f];
      const err = Math.abs(got - exp);
      if (f < 4) {
        if (err > maxPosErr) maxPosErr = err;
        if (err > POS_TOL) posErrs++;
      } else if (f === 7 || f === 11) {
        if (err > maxIntErr) maxIntErr = err;
        if (err > INTENSITY_TOL) intErrs++;
      } else {
        if (err > maxColorErr) maxColorErr = err;
        if (err > COLOR_TOL) colorErrs++;
      }
    }
  }

  // --- Sensor bins ---
  let maxSensorErr = 0, sensorErrs = 0;
  for (let s = 0; s < ref.sensorCount; s++) {
    for (let b = 0; b < ref.binCount; b++) {
      const got = tracer.sensorBins[s * ref.binCount + b];
      const exp = ref.sensorBins[s][b];
      const err = Math.abs(got - exp);
      if (err > maxSensorErr) maxSensorErr = err;
      if (err > SENSOR_TOL) sensorErrs++;
    }
  }

  // --- Sensor totals ---
  let maxTotalErr = 0;
  for (let s = 0; s < ref.sensorCount; s++) {
    let got = 0;
    for (let b = 0; b < ref.binCount; b++) got += tracer.sensorBins[s * ref.binCount + b];
    const exp = ref.sensorTotals[s];
    const err = exp > 0 ? Math.abs(got - exp) / exp : Math.abs(got - exp);
    if (err > maxTotalErr) maxTotalErr = err;
  }

  const ok = posErrs === 0 && colorErrs === 0 && intErrs === 0 && sensorErrs === 0
    && tracer.segmentCount === ref.segmentCount;

  console.log(`  ${name.padEnd(20)} segs=${ref.segmentCount.toString().padStart(5)}  ` +
    `pos=${maxPosErr.toExponential(1).padStart(8)}  ` +
    `color=${maxColorErr.toExponential(1).padStart(8)}  ` +
    `int=${maxIntErr.toExponential(1).padStart(8)}  ` +
    `sensor=${maxSensorErr.toExponential(1).padStart(8)}  ` +
    `totRel=${(maxTotalErr * 100).toFixed(2).padStart(6)}%  ` +
    `${ok ? 'PASS' : 'FAIL'}`);

  if (!ok) {
    if (tracer.segmentCount !== ref.segmentCount)
      errors.push(`  segment count mismatch: ${tracer.segmentCount} vs ${ref.segmentCount}`);
    if (posErrs) errors.push(`  ${posErrs} position errors (max ${maxPosErr.toExponential(2)})`);
    if (colorErrs) errors.push(`  ${colorErrs} color errors (max ${maxColorErr.toExponential(2)})`);
    if (intErrs) errors.push(`  ${intErrs} intensity errors (max ${maxIntErr.toExponential(2)})`);
    if (sensorErrs) errors.push(`  ${sensorErrs} sensor bin errors (max ${maxSensorErr.toExponential(2)})`);
    for (const e of errors) console.log(e);
  }

  return ok;
}

// --- Run ---
const snapArg = process.argv[2];
let pass = 0, fail = 0;

console.log('Tracer snapshot verification\n');

if (snapArg) {
  verify(snapArg) ? pass++ : fail++;
} else {
  const files = readdirSync(SNAPSHOT_DIR).filter(f => f.endsWith('.json')).sort();
  if (files.length === 0) {
    console.log('  No snapshots found. Run: node tools/trace-snapshot.js');
    process.exit(1);
  }
  for (const f of files) {
    const name = f.replace('.json', '');
    verify(name) ? pass++ : fail++;
  }
}

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
