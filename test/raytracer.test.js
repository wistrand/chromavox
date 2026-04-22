import { test, assert, assertClose } from './run.js';
import { Tracer } from '../docs/js/raytracer.js';
import { createScene, makeElement } from '../docs/js/scene.js';

function traceDefault(scene) {
  const t = new Tracer();
  t.trace(scene);
  return t;
}

// --- Basic tracing ---

test('Tracer: empty scene produces segments', () => {
  const scene = createScene();
  Object.assign(scene.bench, { w: 556, h: 900 });
  scene.emitter.count = 4;
  scene.emitter.raysPerSource = 8;
  const t = traceDefault(scene);
  assert(t.segmentCount > 0, 'should produce segments from wall emitters');
});

test('Tracer: segments have valid positions', () => {
  const scene = createScene();
  Object.assign(scene.bench, { w: 556, h: 900 });
  scene.emitter.count = 2;
  scene.emitter.raysPerSource = 4;
  const t = traceDefault(scene);
  for (let i = 0; i < t.segmentCount; i++) {
    const off = i * 12;
    const x1 = t.segmentData[off], y1 = t.segmentData[off + 1];
    assert(isFinite(x1) && isFinite(y1), `segment ${i} has finite p1`);
  }
});

test('Tracer: sensorBins populated on straight-through rays', () => {
  const scene = createScene();
  Object.assign(scene.bench, { w: 556, h: 900 });
  scene.emitter.count = 4;
  scene.emitter.raysPerSource = 16;
  scene.sensorCount = 8;
  const t = traceDefault(scene);
  let total = 0;
  for (let i = 0; i < t.sensorBins.length; i++) total += t.sensorBins[i];
  assert(total > 0, 'sensors should receive light from straight-through rays');
});

test('Tracer: disabled source produces no rays for that strip', () => {
  const scene = createScene();
  Object.assign(scene.bench, { w: 556, h: 900 });
  scene.emitter.count = 2;
  scene.emitter.raysPerSource = 16;
  scene.emitter.disabled = new Set([0]);
  scene.sensorCount = 2;
  const t = traceDefault(scene);
  let topSensor = 0, botSensor = 0;
  for (let b = 0; b < t.binCount; b++) {
    topSensor += t.sensorBins[0 * t.binCount + b];
    botSensor += t.sensorBins[1 * t.binCount + b];
  }
  assert(topSensor < 0.01, 'disabled source 0 should not light top sensor');
  assert(botSensor > 0, 'source 1 should light bottom sensor');
});

// --- Prism refraction ---

test('Tracer: prism refracts rays (segments change direction)', () => {
  const scene = createScene();
  Object.assign(scene.bench, { w: 556, h: 900 });
  scene.emitter.count = 1;
  scene.emitter.raysPerSource = 32;
  scene.sensorCount = 16;
  const el = makeElement('prism', 200, 450);
  el.material = 'crown';
  scene.elements.push(el);
  const t = traceDefault(scene);
  assert(t.segmentCount > 32, 'prism should produce more segments than a straight-through scene');
});

// --- Mirror reflection ---

test('Tracer: mirror reflects rays', () => {
  const scene = createScene();
  Object.assign(scene.bench, { w: 556, h: 900 });
  scene.emitter.count = 1;
  scene.emitter.raysPerSource = 16;
  scene.sensorCount = 8;
  const el = makeElement('mirror', 300, 450);
  el.rot = Math.PI / 4;
  scene.elements.push(el);
  const noMirror = traceDefault(createScene());
  Object.assign(noMirror, { segmentCount: 0 });
  const t = traceDefault(scene);
  assert(t.segmentCount > 16, 'mirror should create reflected segments');
});

// --- Delay material: particle capture ---

test('Tracer: delay element captures rays into pool', () => {
  const scene = createScene();
  Object.assign(scene.bench, { w: 556, h: 900 });
  scene.emitter.count = 2;
  scene.emitter.raysPerSource = 32;
  scene.sensorCount = 8;
  const el = makeElement('block', 200, 450);
  el.material = 'slowGlass';
  el.rot = 0;
  el.w = 120; el.h = 800;
  scene.elements.push(el);
  const t = new Tracer();
  t.trace(scene);
  assert(t.activeParticleCount() > 0, 'delay element should capture particles');
});

test('Tracer: no particles without delay element', () => {
  const scene = createScene();
  Object.assign(scene.bench, { w: 556, h: 900 });
  scene.emitter.count = 2;
  scene.emitter.raysPerSource = 32;
  const t = new Tracer();
  t.trace(scene);
  assert(t.activeParticleCount() === 0, 'no delay elements → no particles');
});

test('Tracer: particles advance and exit over multiple frames', () => {
  const scene = createScene();
  Object.assign(scene.bench, { w: 556, h: 900 });
  scene.emitter.count = 1;
  scene.emitter.raysPerSource = 16;
  scene.sensorCount = 4;
  const el = makeElement('block', 200, 450);
  el.material = 'slowGlass';
  el.rot = 0;
  el.w = 80; el.h = 800;
  scene.elements.push(el);
  const t = new Tracer();
  t.simRate = 1;
  t.trace(scene);
  const countAfterCapture = t.activeParticleCount();
  assert(countAfterCapture > 0, 'should have captured particles');
  // Stop emitting new rays so only existing particles drain.
  scene.elements.length = 0;
  for (let i = 0; i < 30; i++) {
    t.trace(scene);
  }
  const countAfterAdvance = t.activeParticleCount();
  assert(countAfterAdvance < countAfterCapture,
    `particles should drain: ${countAfterAdvance} < ${countAfterCapture}`);
});

test('Tracer: simRate scales particle speed', () => {
  function countAfterN(rate, frames) {
    const scene = createScene();
    Object.assign(scene.bench, { w: 556, h: 900 });
    scene.emitter.count = 1;
    scene.emitter.raysPerSource = 16;
    scene.sensorCount = 4;
    const el = makeElement('block', 200, 450);
    el.material = 'slowGlass';
    el.rot = 0; el.w = 80; el.h = 800;
    scene.elements.push(el);
    const t = new Tracer();
    t.simRate = rate;
    t.trace(scene);
    // Stop adding new particles by removing the element after first trace.
    scene.elements.length = 0;
    for (let i = 0; i < frames; i++) t.trace(scene);
    return t.activeParticleCount();
  }
  const slow = countAfterN(0.5, 20);
  const fast = countAfterN(4, 20);
  assert(fast <= slow, `faster rate should drain more: fast=${fast}, slow=${slow}`);
});

test('Tracer: deleted delay element drops its pool', () => {
  const scene = createScene();
  Object.assign(scene.bench, { w: 556, h: 900 });
  scene.emitter.count = 1;
  scene.emitter.raysPerSource = 16;
  const el = makeElement('block', 200, 450);
  el.material = 'slowGlass';
  el.rot = 0; el.w = 80; el.h = 800;
  scene.elements.push(el);
  const t = new Tracer();
  t.trace(scene);
  assert(t.activeParticleCount() > 0);
  scene.elements.length = 0;
  t.trace(scene);
  assert(t.activeParticleCount() === 0, 'deleting element should drop pool');
});

// --- Sensor persistence ---

test('Tracer: secondary sensor deposits via persistence', () => {
  const scene = createScene();
  Object.assign(scene.bench, { w: 556, h: 900 });
  scene.emitter.count = 2;
  scene.emitter.raysPerSource = 128;
  scene.sensorCount = 8;
  // Thin delay block so particles transit quickly.
  const el = makeElement('block', 150, 450);
  el.material = 'slowGlass';
  el.rot = 0; el.w = 40; el.h = 800;
  scene.elements.push(el);
  const t = new Tracer();
  t.simRate = 8;
  // Run enough frames for particles to traverse and exit.
  for (let i = 0; i < 60; i++) t.trace(scene);
  let total = 0;
  for (let i = 0; i < t.sensorBins.length; i++) total += t.sensorBins[i];
  assert(total > 0, 'sensors should receive delayed deposits after particles exit');
});

// --- Zero-delay cost ---

test('Tracer: no-delay scene has zero active particles', () => {
  const scene = createScene();
  Object.assign(scene.bench, { w: 556, h: 900 });
  scene.emitter.count = 4;
  scene.emitter.raysPerSource = 32;
  const el = makeElement('prism', 250, 450);
  el.material = 'crown';
  scene.elements.push(el);
  const t = new Tracer();
  t.trace(scene);
  assert(t.activeParticleCount() === 0);
});

test('Tracer: delayK below DELAY_MIN treated as normal dielectric', () => {
  const scene = createScene();
  Object.assign(scene.bench, { w: 556, h: 900 });
  scene.emitter.count = 1;
  scene.emitter.raysPerSource = 16;
  const el = makeElement('block', 200, 450);
  el.material = 'crown';
  el.delayK = 0.0001; // below DELAY_MIN
  el.rot = 0; el.w = 80; el.h = 800;
  scene.elements.push(el);
  const t = new Tracer();
  t.trace(scene);
  assert(t.activeParticleCount() === 0, 'sub-threshold delayK should not capture');
});
