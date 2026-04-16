// WebGL2 renderer. Two passes:
//   - Ray pass: per segment = one instanced quad, width and soft falloff
//     computed in the fragment shader (SDF). Additive blend.
//   - Overlay pass: element outlines + emitter/sensor ticks. Alpha blend,
//     plain line primitives.

import { worldEdges } from './scene.js';

const RAY_VS = `#version 300 es
in vec2 aCorner;     // (along, side) in {(0,-1),(0,1),(1,-1),(1,1)}
in vec4 aSeg;        // p1.xy, p2.xy
in vec4 aCol1;       // premultiplied color1 + alpha1
in vec4 aCol2;       // premultiplied color2 + alpha2
uniform vec2 uBench;
uniform float uWidth;
out float vAlong;
out float vSide;
out vec4 vCol1;
out vec4 vCol2;
void main() {
  vec2 p1 = aSeg.xy;
  vec2 p2 = aSeg.zw;
  vec2 dir = p2 - p1;
  float len = max(length(dir), 1e-6);
  vec2 u = dir / len;
  vec2 n = vec2(-u.y, u.x);
  vec2 center = mix(p1, p2, aCorner.x);
  vec2 pos = center + n * uWidth * aCorner.y;
  vec2 nd = pos / uBench;
  nd.y = 1.0 - nd.y;
  gl_Position = vec4(nd * 2.0 - 1.0, 0.0, 1.0);
  vAlong = aCorner.x;
  vSide = aCorner.y;
  vCol1 = aCol1;
  vCol2 = aCol2;
}`;

const RAY_FS = `#version 300 es
precision mediump float;
in float vAlong;
in float vSide;
in vec4 vCol1;
in vec4 vCol2;
out vec4 outColor;
void main() {
  float d = abs(vSide);
  // Soft cubic falloff from 1.0 at center to 0.0 at edge.
  float amp = 1.0 - smoothstep(0.0, 1.0, d);
  vec4 c = mix(vCol1, vCol2, vAlong);
  outColor = vec4(c.rgb * amp, c.a * amp);
}`;

const OVERLAY_VS = `#version 300 es
in vec2 aPos;
in vec4 aColor;
uniform vec2 uBench;
out vec4 vColor;
void main() {
  vec2 p = aPos / uBench;
  p.y = 1.0 - p.y;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
  vColor = aColor;
}`;

const OVERLAY_FS = `#version 300 es
precision mediump float;
in vec4 vColor;
out vec4 outColor;
void main() { outColor = vColor; }`;

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', { antialias: true, premultipliedAlpha: false });
    if (!gl) throw new Error('WebGL2 not supported');
    this.gl = gl;

    // Ray program (SDF quads, instanced).
    this.rayProgram = buildProgram(gl, RAY_VS, RAY_FS);
    this.ray = {
      aCorner: gl.getAttribLocation(this.rayProgram, 'aCorner'),
      aSeg:    gl.getAttribLocation(this.rayProgram, 'aSeg'),
      aCol1:   gl.getAttribLocation(this.rayProgram, 'aCol1'),
      aCol2:   gl.getAttribLocation(this.rayProgram, 'aCol2'),
      uBench:  gl.getUniformLocation(this.rayProgram, 'uBench'),
      uWidth:  gl.getUniformLocation(this.rayProgram, 'uWidth'),
    };
    // Static quad corners: triangle strip (along, side).
    this.cornerBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.cornerBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      0, -1,  0, 1,  1, -1,  1, 1,
    ]), gl.STATIC_DRAW);
    // Per-segment instance buffer.
    this.segBuf = gl.createBuffer();

    // Overlay program (plain lines, alpha blend).
    this.overlayProgram = buildProgram(gl, OVERLAY_VS, OVERLAY_FS);
    this.overlay = {
      aPos:   gl.getAttribLocation(this.overlayProgram, 'aPos'),
      aColor: gl.getAttribLocation(this.overlayProgram, 'aColor'),
      uBench: gl.getUniformLocation(this.overlayProgram, 'uBench'),
    };
    this.overlayBuf = gl.createBuffer();
    this.overlayData = new Float32Array(0);
    this.overlayCount = 0;

    // Width of rays in bench units. 2–3 is a nice range for a 900-tall bench.
    this.rayWidth = 2.5;

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
    const aspect = this.canvas.width / this.canvas.height;
    const h = 900;
    const w = Math.round(h * aspect);
    return { w, h };
  }

  draw(scene, tracer) {
    const gl = this.gl;
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);

    // --- Ray pass (instanced SDF quads, additive) ---
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.useProgram(this.rayProgram);
    gl.uniform2f(this.ray.uBench, scene.bench.w, scene.bench.h);
    gl.uniform1f(this.ray.uWidth, this.rayWidth);

    // Upload segment data (12 floats per segment).
    gl.bindBuffer(gl.ARRAY_BUFFER, this.segBuf);
    gl.bufferData(gl.ARRAY_BUFFER,
      tracer.segmentData.subarray(0, tracer.segmentCount * 12), gl.DYNAMIC_DRAW);
    const segStride = 12 * 4;
    gl.enableVertexAttribArray(this.ray.aSeg);
    gl.vertexAttribPointer(this.ray.aSeg, 4, gl.FLOAT, false, segStride, 0);
    gl.vertexAttribDivisor(this.ray.aSeg, 1);
    gl.enableVertexAttribArray(this.ray.aCol1);
    gl.vertexAttribPointer(this.ray.aCol1, 4, gl.FLOAT, false, segStride, 4 * 4);
    gl.vertexAttribDivisor(this.ray.aCol1, 1);
    gl.enableVertexAttribArray(this.ray.aCol2);
    gl.vertexAttribPointer(this.ray.aCol2, 4, gl.FLOAT, false, segStride, 8 * 4);
    gl.vertexAttribDivisor(this.ray.aCol2, 1);

    // Static quad corners (per vertex).
    gl.bindBuffer(gl.ARRAY_BUFFER, this.cornerBuf);
    gl.enableVertexAttribArray(this.ray.aCorner);
    gl.vertexAttribPointer(this.ray.aCorner, 2, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(this.ray.aCorner, 0);

    if (tracer.segmentCount > 0) {
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, tracer.segmentCount);
    }

    // Clean up divisors so the overlay pass isn't confused.
    gl.vertexAttribDivisor(this.ray.aSeg, 0);
    gl.vertexAttribDivisor(this.ray.aCol1, 0);
    gl.vertexAttribDivisor(this.ray.aCol2, 0);

    // --- Overlay pass (alpha) ---
    this.buildOverlay(scene);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(this.overlayProgram);
    gl.uniform2f(this.overlay.uBench, scene.bench.w, scene.bench.h);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.overlayBuf);
    gl.bufferData(gl.ARRAY_BUFFER,
      this.overlayData.subarray(0, this.overlayCount * 6), gl.DYNAMIC_DRAW);
    const ovStride = 6 * 4;
    gl.enableVertexAttribArray(this.overlay.aPos);
    gl.vertexAttribPointer(this.overlay.aPos, 2, gl.FLOAT, false, ovStride, 0);
    gl.enableVertexAttribArray(this.overlay.aColor);
    gl.vertexAttribPointer(this.overlay.aColor, 4, gl.FLOAT, false, ovStride, 2 * 4);
    gl.drawArrays(gl.LINES, 0, this.overlayCount);
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
    let estimate = 8 + scene.emitter.count * 2 + scene.sensorCount * 2;
    for (const el of scene.elements) estimate += 100;
    this.ensureOverlayCapacity(estimate * 2);

    const { bench } = scene;

    this.rect(0, 0, bench.w, bench.h, 0.35, 0.4, 0.5, 0.6);

    // Emitter ticks on left wall. Disabled sources draw dim; with mic active,
    // enabled sources extend into an amber band-volume bar.
    const levels = scene.emitter.micLevels;
    const disabled = scene.emitter.disabled;
    const srcStripH = bench.h / scene.emitter.count;
    for (let s = 0; s < scene.emitter.count; s++) {
      const y = (s + 0.5) * srcStripH;
      const off = disabled && disabled.has(s);
      const a = off ? 0.3 : 1.0;
      for (let dy = -1; dy <= 1; dy++) {
        this.line(0, y + dy, 14, y + dy, 1, 1, 0.7, a);
      }
      if (!off && levels && levels[s] > 0.02) {
        const v = Math.min(1, levels[s]);
        const len = 24 + v * 140;
        const x0 = 16;
        for (let dy = -1; dy <= 1; dy++) {
          this.line(x0, y + dy, x0 + len, y + dy, 1, 0.85, 0.4, 0.4 + 0.6 * v);
        }
      }
    }
    const senStripH = bench.h / scene.sensorCount;
    for (let s = 0; s < scene.sensorCount; s++) {
      const y = (s + 0.5) * senStripH;
      this.line(bench.w - 20, y, bench.w - 2, y, 0.6, 1, 0.9, 0.9);
    }

    for (const el of scene.elements) {
      const { polygon } = worldEdgesCached(el);
      const col = elementColor(el);
      this.polyOutline(polygon, col[0], col[1], col[2], col[3]);
      if (el._selected) {
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
    case 'mirror':       return [0.85, 0.85, 1.0, 0.9];
    case 'mirror-red':   return [1.0, 0.4, 0.4, 0.9];
    case 'mirror-green': return [0.4, 1.0, 0.5, 0.9];
    case 'mirror-blue':  return [0.4, 0.5, 1.0, 0.9];
    case 'flint':        return [1.0, 0.7, 0.8, 0.85];
    case 'crown':        return [0.6, 0.9, 1.0, 0.85];
    case 'fused':        return [0.8, 1.0, 0.9, 0.85];
    case 'water':        return [0.6, 0.8, 1.0, 0.85];
    case 'diamond':      return [1.0, 1.0, 0.8, 0.9];
    case 'hyper':        return [1.0, 0.5, 1.0, 0.9];
    default:             return [1, 1, 1, 0.8];
  }
}

function worldEdgesCached(el) {
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
