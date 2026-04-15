// WebGL2 renderer. Draws ray segments additively (the light field) and an
// overlay of optical elements, emitters, and sensors.

const VS = `#version 300 es
in vec2 aPos;
in vec4 aColor;
uniform vec2 uBench;         // bench size in logical units
out vec4 vColor;
void main() {
  vec2 p = aPos / uBench;    // 0..1
  p.y = 1.0 - p.y;           // flip to y-up clip space
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
  vColor = aColor;
}`;

const FS = `#version 300 es
precision mediump float;
in vec4 vColor;
uniform float uGain;
out vec4 outColor;
void main() {
  outColor = vec4(vColor.rgb * uGain, vColor.a);
}`;

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', { antialias: true, premultipliedAlpha: false });
    if (!gl) throw new Error('WebGL2 not supported');
    this.gl = gl;
    this.program = buildProgram(gl, VS, FS);
    this.aPos = gl.getAttribLocation(this.program, 'aPos');
    this.aColor = gl.getAttribLocation(this.program, 'aColor');
    this.uBench = gl.getUniformLocation(this.program, 'uBench');
    this.uGain = gl.getUniformLocation(this.program, 'uGain');
    this.rayBuf = gl.createBuffer();
    this.overlayBuf = gl.createBuffer();
    this.overlayData = new Float32Array(0);
    this.overlayCount = 0;
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rect = this.canvas.getBoundingClientRect();
    this.canvas.width = Math.max(2, Math.floor(rect.width * dpr));
    this.canvas.height = Math.max(2, Math.floor(rect.height * dpr));
    this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
  }

  benchSize() {
    // Map canvas aspect to bench logical size (fixed short axis).
    const aspect = this.canvas.width / this.canvas.height;
    const h = 900;
    const w = Math.round(h * aspect);
    return { w, h };
  }

  draw(scene, tracer) {
    const gl = this.gl;
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this.program);
    gl.uniform2f(this.uBench, scene.bench.w, scene.bench.h);

    // --- Ray pass (additive) ---
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.uniform1f(this.uGain, 1.0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.rayBuf);
    gl.bufferData(gl.ARRAY_BUFFER,
      tracer.vertexData.subarray(0, tracer.vertexCount * 6), gl.DYNAMIC_DRAW);
    this.bindAttrs();
    gl.lineWidth(1);
    gl.drawArrays(gl.LINES, 0, tracer.vertexCount);

    // --- Overlay pass (alpha) ---
    this.buildOverlay(scene);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.uniform1f(this.uGain, 1.0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.overlayBuf);
    gl.bufferData(gl.ARRAY_BUFFER,
      this.overlayData.subarray(0, this.overlayCount * 6), gl.DYNAMIC_DRAW);
    this.bindAttrs();
    gl.drawArrays(gl.LINES, 0, this.overlayCount);
  }

  bindAttrs() {
    const gl = this.gl;
    const stride = 6 * 4;
    gl.enableVertexAttribArray(this.aPos);
    gl.vertexAttribPointer(this.aPos, 2, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(this.aColor);
    gl.vertexAttribPointer(this.aColor, 4, gl.FLOAT, false, stride, 2 * 4);
  }

  ensureOverlayCapacity(nVerts) {
    const needed = nVerts * 6;
    if (this.overlayData.length < needed) {
      this.overlayData = new Float32Array(Math.max(needed, this.overlayData.length * 2 || 2048));
    }
  }

  pushOverlayVertex(x, y, r, g, b, a) {
    const i = this.overlayCount * 6;
    this.overlayData[i] = x;
    this.overlayData[i + 1] = y;
    this.overlayData[i + 2] = r;
    this.overlayData[i + 3] = g;
    this.overlayData[i + 4] = b;
    this.overlayData[i + 5] = a;
    this.overlayCount++;
  }

  buildOverlay(scene) {
    this.overlayCount = 0;
    // Rough upper bound of vertices.
    let estimate = 8 + scene.emitter.count * 2 + scene.sensorCount * 2;
    for (const el of scene.elements) estimate += 100;
    this.ensureOverlayCapacity(estimate * 2);

    const { bench } = scene;

    // Bench outline.
    this.rect(0, 0, bench.w, bench.h, 0.35, 0.4, 0.5, 0.6);

    // Emitter ticks on left wall. With mic active, each tick extends into
    // a band-volume bar.
    const levels = scene.emitter.micLevels;
    const srcStripH = bench.h / scene.emitter.count;
    for (let s = 0; s < scene.emitter.count; s++) {
      const y = (s + 0.5) * srcStripH;
      this.line(2, y, 20, y, 1, 1, 0.6, 0.9);
      if (levels && levels[s] > 0.02) {
        const v = Math.min(1, levels[s]);
        const len = 24 + v * 140;
        this.line(22, y, 22 + len, y, 1, 0.85, 0.4, 0.4 + 0.6 * v);
      }
    }
    // Sensor ticks on right wall.
    const senStripH = bench.h / scene.sensorCount;
    for (let s = 0; s < scene.sensorCount; s++) {
      const y = (s + 0.5) * senStripH;
      this.line(bench.w - 20, y, bench.w - 2, y, 0.6, 1, 0.9, 0.9);
    }

    // Elements.
    for (const el of scene.elements) {
      const { polygon } = worldEdgesCached(el);
      const col = elementColor(el);
      this.polyOutline(polygon, col[0], col[1], col[2], col[3]);
      if (el._selected) {
        // Selection handle.
        this.rect(el.x - 8, el.y - 8, 16, 16, 1, 1, 1, 0.8);
      }
    }
  }

  line(x1, y1, x2, y2, r, g, b, a) {
    this.pushOverlayVertex(x1, y1, r, g, b, a);
    this.pushOverlayVertex(x2, y2, r, g, b, a);
  }
  rect(x, y, w, h, r, g, b, a) {
    this.line(x, y, x + w, y, r, g, b, a);
    this.line(x + w, y, x + w, y + h, r, g, b, a);
    this.line(x + w, y + h, x, y + h, r, g, b, a);
    this.line(x, y + h, x, y, r, g, b, a);
  }
  polyOutline(poly, r, g, b, a) {
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i], q = poly[(i + 1) % poly.length];
      this.line(p.x, p.y, q.x, q.y, r, g, b, a);
    }
  }
}

function elementColor(el) {
  switch (el.material) {
    case 'mirror': return [0.85, 0.85, 1.0, 0.9];
    case 'flint':  return [1.0, 0.7, 0.8, 0.85];
    case 'crown':  return [0.6, 0.9, 1.0, 0.85];
    case 'fused':  return [0.8, 1.0, 0.9, 0.85];
    case 'water':  return [0.6, 0.8, 1.0, 0.85];
    case 'diamond':return [1.0, 1.0, 0.8, 0.9];
    case 'hyper':  return [1.0, 0.5, 1.0, 0.9];
    default:       return [1, 1, 1, 0.8];
  }
}

// Geometry import (placed here to keep the renderer self-contained at call site).
import { worldEdges } from './scene.js';
const _geomCache = new WeakMap();
function worldEdgesCached(el) {
  // Cache busts when any element prop changes; keep simple by recomputing.
  // For perf this can be improved, but element counts are small.
  return worldEdges(el);
}

function buildProgram(gl, vs, fs) {
  const v = buildShader(gl, gl.VERTEX_SHADER, vs);
  const f = buildShader(gl, gl.FRAGMENT_SHADER, fs);
  const p = gl.createProgram();
  gl.attachShader(p, v); gl.attachShader(p, f);
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS))
    throw new Error('Program link failed: ' + gl.getProgramInfoLog(p));
  return p;
}
function buildShader(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src); gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS))
    throw new Error('Shader compile failed: ' + gl.getShaderInfoLog(s));
  return s;
}
