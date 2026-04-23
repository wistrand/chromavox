#!/usr/bin/env node
// Minimal test runner. No external dependencies.
// Usage: node test/run.js

let passed = 0, failed = 0, errors = [];

export function test(name, fn) {
  try {
    fn();
    passed++;
  } catch (e) {
    failed++;
    errors.push({ name, message: e.message });
  }
}

export function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

export function assertClose(a, b, eps = 1e-6, msg) {
  if (Math.abs(a - b) > eps)
    throw new Error(msg || `expected ${a} ≈ ${b} (±${eps}), delta=${Math.abs(a - b)}`);
}

export function assertThrows(fn, msg) {
  let threw = false;
  try { fn(); } catch { threw = true; }
  if (!threw) throw new Error(msg || 'expected function to throw');
}

// Import and run all test modules, then report.
(async () => {
  const modules = [
    './spectrum.test.js',
    './scene.test.js',
    './raytracer.test.js',
    './synth-worklet.test.js',
    './midi.test.js',
  ];
  for (const m of modules) {
    try {
      await import(m);
    } catch (e) {
      failed++;
      errors.push({ name: `import ${m}`, message: e.message });
    }
  }
  console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
  if (errors.length) {
    for (const e of errors) {
      console.log(`\n  FAIL: ${e.name}`);
      console.log(`    ${e.message}`);
    }
    process.exit(1);
  }
})();
