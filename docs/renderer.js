// WebGL2 renderer. Three passes:
//   1. Rays rendered into an FBO as instanced SDF quads (additive).
//   2. Screen is cleared and the FBO is blitted via a fullscreen quad; then
//      each element interior is drawn with a polygon-SDF fragment shader
//      that samples the FBO with a per-pixel offset to distort the rays
//      underneath (refractive glass look). Material parameters differ per
//      material — sharp edges for diamond, softer for crown, opaque tint
//      for mirrors, etc.
//   3. Overlay lines on top (bench outline, emitter/sensor ticks, element
//      outlines, selection handle). Alpha blend.

import { worldEdges } from './scene.js';
import { wavelengthToRGB } from './spectrum.js';

const MAX_EDGES = 128;

const RAY_VS = `#version 300 es
in vec2 aCorner;
in vec4 aSeg;
in vec4 aCol1;
in vec4 aCol2;
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
precision highp float;
in float vAlong;
in float vSide;
in vec4 vCol1;
in vec4 vCol2;
out vec4 outColor;
void main() {
  float d = abs(vSide);
  float amp = 1.0 - smoothstep(0.0, 1.0, d);
  vec4 c = mix(vCol1, vCol2, vAlong);
  outColor = vec4(c.rgb * amp, c.a * amp);
}`;

const BLIT_VS = `#version 300 es
in vec2 aCorner;
out vec2 vUV;
void main() {
  vUV = aCorner;
  gl_Position = vec4(aCorner * 2.0 - 1.0, 0.0, 1.0);
}`;

const BLIT_FS = `#version 300 es
precision highp float;
in vec2 vUV;
uniform sampler2D uTex;
out vec4 outColor;
void main() {
  // Reinhard tone-map the HDR ray FBO to [0,1] for display. Channels
  // sum freely past 1 in the FBO; the curve compresses softly so colors
  // stay distinct instead of clamping to white.
  vec3 hdr = texture(uTex, vUV).rgb;
  outColor = vec4(hdr / (1.0 + hdr), 1.0);
}`;

// Element shader: draws a bounding quad in world space, discards pixels
// outside the polygon (SDF), and inside the polygon samples the FBO with
// an offset driven by distance from the nearest edge — so the ray image
// underneath distorts as if bent by a lens.
const ELEM_VS = `#version 300 es
in vec2 aCorner;
uniform vec2 uAabbMin;
uniform vec2 uAabbMax;
uniform vec2 uBench;
out vec2 vBench;
out vec2 vUV;
void main() {
  vBench = mix(uAabbMin, uAabbMax, aCorner);
  vec2 nd = vBench / uBench;
  nd.y = 1.0 - nd.y;
  vUV = vec2(nd.x, nd.y);
  gl_Position = vec4(nd * 2.0 - 1.0, 0.0, 1.0);
}`;

const ELEM_FS = `#version 300 es
precision highp float;
#define MAX_EDGES ${MAX_EDGES}
in vec2 vBench;
in vec2 vUV;
uniform vec2 uAabbMin;
uniform vec2 uAabbMax;
uniform int uEdgeCount;
uniform vec4 uEdges[MAX_EDGES];
uniform vec3 uTint;
uniform float uTintStrength;
uniform float uMagnitude;
uniform float uFalloff;
uniform vec3 uEdgeGlow;
uniform float uEdgeGlowAmp;
uniform float uEdgeWidth;
uniform float uOpaque;       // 1.0 → ignore FBO (opaque tint); 0.0 → refractive sample
uniform vec2 uBench;
uniform sampler2D uFbo;
out vec4 outColor;

void main() {
  // Polygon SDF via loop over edges. Also tracks the closest edge point so
  // we can derive a distortion direction.
  float minDist2 = 1e18;
  vec2 nearest = vec2(0.0);
  bool inside = false;
  for (int i = 0; i < MAX_EDGES; i++) {
    if (i >= uEdgeCount) break;
    vec2 a = uEdges[i].xy;
    vec2 b = uEdges[i].zw;
    vec2 ba = b - a;
    vec2 pa = vBench - a;
    float denom = max(dot(ba, ba), 1e-12);
    float h = clamp(dot(pa, ba) / denom, 0.0, 1.0);
    vec2 q = a + ba * h;
    vec2 diff = vBench - q;
    float d2 = dot(diff, diff);
    if (d2 < minDist2) { minDist2 = d2; nearest = q; }
    // Point-in-polygon crossing test (even-odd rule).
    if (abs(b.y - a.y) > 1e-9) {
      bool crossY = (a.y > vBench.y) != (b.y > vBench.y);
      if (crossY) {
        float xCross = a.x + (vBench.y - a.y) * (b.x - a.x) / (b.y - a.y);
        if (vBench.x < xCross) inside = !inside;
      }
    }
  }
  if (!inside) discard;

  float dist = sqrt(minDist2);

  // Shared light-facing factor: edges whose outward normal faces the
  // upper-left light (Y is down, so upper-left = (-1, -1)) are both
  // brighter (rim glint) AND refract more strongly (distortion).
  vec2 light = normalize(vec2(-1.0, -1.0));
  vec2 outward = normalize(nearest - vBench + vec2(1e-5));
  float facing = dot(outward, light);          // -1..+1
  float facingT = clamp(facing * 0.5 + 0.5, 0.0, 1.0);  // 0..1

  // Base sample from the FBO (HDR ray image). The distortion direction
  // is taken from the polygon centroid, not the nearest edge, to avoid
  // the medial-axis discontinuity. Reinhard tone-mapped to [0,1] before
  // mixing so additive ray pile-ups become smooth bright colors instead
  // of clamping to white.
  vec3 baseRgb;
  if (uOpaque < 0.5) {
    vec2 center = 0.5 * (uAabbMin + uAabbMax);
    vec2 centerDir = normalize(vBench - center + vec2(1e-5));
    float edgeT = 1.0 - smoothstep(0.0, uFalloff, dist);
    float distortScale = mix(0.35, 1.0, facingT);
    vec2 offsetBench = -centerDir * uMagnitude * edgeT * distortScale;
    vec2 offsetUV = offsetBench / uBench;
    offsetUV.y = -offsetUV.y;
    vec2 uv = clamp(vUV + offsetUV, vec2(0.0), vec2(1.0));
    vec3 hdr = texture(uFbo, uv).rgb;
    baseRgb = hdr / (1.0 + hdr);
  } else {
    baseRgb = vec3(0.0);
  }

  // Tint + edge glow. Apply the tint both multiplicatively (rays through
  // glass pick up its color, colored-glass filter look) and additively
  // (body is visible even where no rays reach).
  vec3 filtered = mix(baseRgb, baseRgb * uTint, uTintStrength * 0.8);
  vec3 tinted = filtered + uTint * uTintStrength;
  float glowT = 1.0 - smoothstep(0.0, uEdgeWidth, dist);
  vec3 glow = uEdgeGlow * uEdgeGlowAmp * glowT;
  vec3 rgb = tinted + glow;

  // Rim highlight: same light direction; peaks where the edge faces the light.
  float rimFacing = max(0.0, facing);
  float rimBand = 1.0 - smoothstep(0.0, uEdgeWidth * 2.0, dist);
  float rim = pow(rimFacing, 3.0) * rimBand * 0.6;

  // Opaque materials use the tint as body color; refractive overlay composites.
  if (uOpaque > 0.5) {
    outColor = vec4(uTint + glow + vec3(1.0) * rim, 1.0);
  } else {
    outColor = vec4(rgb + vec3(1.0) * rim, 1.0);
  }
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
precision highp float;
in vec4 vColor;
out vec4 outColor;
void main() { outColor = vColor; }`;

// Per-material visual parameters for the element pass.
const LOOK = {
  crown:         { tint: [0.55, 0.80, 1.00], tintStrength: 0.08, magnitude: 5,  falloff: 40, edgeGlow: [0.7, 0.9, 1.0], edgeGlowAmp: 0.35, edgeWidth: 4,  opaque: false },
  flint:         { tint: [1.00, 0.70, 0.80], tintStrength: 0.08, magnitude: 7,  falloff: 40, edgeGlow: [1.0, 0.7, 0.8], edgeGlowAmp: 0.35, edgeWidth: 4,  opaque: false },
  fused:         { tint: [0.85, 1.00, 0.95], tintStrength: 0.05, magnitude: 3,  falloff: 35, edgeGlow: [0.8, 1.0, 0.9], edgeGlowAmp: 0.25, edgeWidth: 3,  opaque: false },
  water:         { tint: [0.50, 0.75, 1.00], tintStrength: 0.10, magnitude: 4,  falloff: 55, edgeGlow: [0.5, 0.7, 1.0], edgeGlowAmp: 0.30, edgeWidth: 5,  opaque: false },
  diamond:       { tint: [1.00, 1.00, 0.90], tintStrength: 0.04, magnitude: 13, falloff: 22, edgeGlow: [1.0, 1.0, 0.8], edgeGlowAmp: 0.80, edgeWidth: 2,  opaque: false },
  hyper:         { tint: [1.00, 0.50, 1.00], tintStrength: 0.12, magnitude: 15, falloff: 30, edgeGlow: [1.0, 0.5, 1.0], edgeGlowAmp: 0.45, edgeWidth: 3,  opaque: false },
  slowGlass:     { tint: [0.55, 0.45, 0.95], tintStrength: 0.18, magnitude: 9,  falloff: 50, edgeGlow: [0.7, 0.6, 1.0], edgeGlowAmp: 0.45, edgeWidth: 4,  opaque: false },
  mirror:        { tint: [0.75, 0.80, 0.95], tintStrength: 1.0,  magnitude: 0,  falloff: 1,  edgeGlow: [1.0, 1.0, 1.0], edgeGlowAmp: 0.70, edgeWidth: 2,  opaque: true },
  'mirror-red':  { tint: [0.95, 0.25, 0.25], tintStrength: 1.0,  magnitude: 0,  falloff: 1,  edgeGlow: [1.0, 0.6, 0.6], edgeGlowAmp: 0.65, edgeWidth: 2,  opaque: true },
  'mirror-green':{ tint: [0.25, 0.90, 0.40], tintStrength: 1.0,  magnitude: 0,  falloff: 1,  edgeGlow: [0.6, 1.0, 0.7], edgeGlowAmp: 0.65, edgeWidth: 2,  opaque: true },
  'mirror-blue': { tint: [0.25, 0.40, 1.00], tintStrength: 1.0,  magnitude: 0,  falloff: 1,  edgeGlow: [0.6, 0.7, 1.0], edgeGlowAmp: 0.65, edgeWidth: 2,  opaque: true },
};
const DEFAULT_LOOK = LOOK.crown;

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', { antialias: true, premultipliedAlpha: false });
    if (!gl) throw new Error('WebGL2 not supported');
    this.gl = gl;
    // HDR float framebuffer for rays — required so additive blending can
    // accumulate past 1.0 without clamping. Tone-mapping happens in the
    // blit and element fragment shaders. Falls back to RGBA8 if the
    // extension is unavailable (older mobile GPUs).
    this.hdrEnabled = !!gl.getExtension('EXT_color_buffer_float');

    // --- Programs ---
    this.rayProgram = buildProgram(gl, RAY_VS, RAY_FS);
    this.ray = {
      aCorner: gl.getAttribLocation(this.rayProgram, 'aCorner'),
      aSeg:    gl.getAttribLocation(this.rayProgram, 'aSeg'),
      aCol1:   gl.getAttribLocation(this.rayProgram, 'aCol1'),
      aCol2:   gl.getAttribLocation(this.rayProgram, 'aCol2'),
      uBench:  gl.getUniformLocation(this.rayProgram, 'uBench'),
      uWidth:  gl.getUniformLocation(this.rayProgram, 'uWidth'),
    };

    this.blitProgram = buildProgram(gl, BLIT_VS, BLIT_FS);
    this.blit = {
      aCorner: gl.getAttribLocation(this.blitProgram, 'aCorner'),
      uTex:    gl.getUniformLocation(this.blitProgram, 'uTex'),
    };

    this.elemProgram = buildProgram(gl, ELEM_VS, ELEM_FS);
    this.elem = {
      aCorner:       gl.getAttribLocation(this.elemProgram, 'aCorner'),
      uAabbMin:      gl.getUniformLocation(this.elemProgram, 'uAabbMin'),
      uAabbMax:      gl.getUniformLocation(this.elemProgram, 'uAabbMax'),
      uBench:        gl.getUniformLocation(this.elemProgram, 'uBench'),
      uEdgeCount:    gl.getUniformLocation(this.elemProgram, 'uEdgeCount'),
      uEdges:        gl.getUniformLocation(this.elemProgram, 'uEdges[0]'),
      uTint:         gl.getUniformLocation(this.elemProgram, 'uTint'),
      uTintStrength: gl.getUniformLocation(this.elemProgram, 'uTintStrength'),
      uMagnitude:    gl.getUniformLocation(this.elemProgram, 'uMagnitude'),
      uFalloff:      gl.getUniformLocation(this.elemProgram, 'uFalloff'),
      uEdgeGlow:     gl.getUniformLocation(this.elemProgram, 'uEdgeGlow'),
      uEdgeGlowAmp:  gl.getUniformLocation(this.elemProgram, 'uEdgeGlowAmp'),
      uEdgeWidth:    gl.getUniformLocation(this.elemProgram, 'uEdgeWidth'),
      uOpaque:       gl.getUniformLocation(this.elemProgram, 'uOpaque'),
      uFbo:          gl.getUniformLocation(this.elemProgram, 'uFbo'),
    };

    this.overlayProgram = buildProgram(gl, OVERLAY_VS, OVERLAY_FS);
    this.overlay = {
      aPos:   gl.getAttribLocation(this.overlayProgram, 'aPos'),
      aColor: gl.getAttribLocation(this.overlayProgram, 'aColor'),
      uBench: gl.getUniformLocation(this.overlayProgram, 'uBench'),
    };

    // --- Static geometry ---
    // Ray quad corners: triangle strip (along, side).
    this.rayCornerBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.rayCornerBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      0, -1,  0, 1,  1, -1,  1, 1,
    ]), gl.STATIC_DRAW);
    // Unit quad corners for blit and element programs: triangle strip (0..1).
    this.unitQuadBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.unitQuadBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      0, 0,  1, 0,  0, 1,  1, 1,
    ]), gl.STATIC_DRAW);

    // --- Dynamic buffers ---
    this.segBuf = gl.createBuffer();
    this.overlayBuf = gl.createBuffer();
    this.overlayData = new Float32Array(0);
    this.overlayCount = 0;

    // --- Framebuffer for ray image ---
    this.fbo = gl.createFramebuffer();
    this.fboTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.fboTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    // Scratch for per-element edge uploads.
    this._edgeData = new Float32Array(MAX_EDGES * 4);

    // Width of rays in bench units. 2–3 is a nice range for a 900-tall bench.
    this.rayWidth = 2.5;

    // Refractive distortion through glass is optional; the rim glint and
    // tint stay on regardless.
    this.distortEnabled = false;

    // Sensor readout smoothing state. Lives on the renderer so
    // resetReadout() can flush it without a separate callback chain.
    this._displayBins = new Float32Array(0);
    this._peakMax = 1e-6;
    this._blurBuf = new Float32Array(0);

    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  resize() {
    // Size the bench-viewport to the largest 556:900 box that fits the
    // stage, enforcing both width and height constraints.  Pure CSS
    // aspect-ratio + max-* can't handle both axes simultaneously on
    // narrow mobile screens (height: 100% wins, max-width clamps
    // width, and the aspect ratio breaks).
    const vp = this.canvas.parentElement;
    const stage = vp.parentElement;
    const stageW = stage.clientWidth;
    const stageH = stage.clientHeight;
    const ASPECT = 556 / 900;
    let w = stageH * ASPECT;
    let h = stageH;
    if (w > stageW) { w = stageW; h = stageW / ASPECT; }
    vp.style.width  = Math.floor(w) + 'px';
    vp.style.height = Math.floor(h) + 'px';

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.max(2, Math.floor(w * dpr));
    this.canvas.height = Math.max(2, Math.floor(h * dpr));
    this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    // Reallocate the FBO color attachment as RGBA16F when supported so the
    // ray pass can accumulate beyond 1.0 in linear HDR space.
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.fboTex);
    if (this.hdrEnabled) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, this.canvas.width, this.canvas.height, 0,
        gl.RGBA, gl.HALF_FLOAT, null);
    } else {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, this.canvas.width, this.canvas.height, 0,
        gl.RGBA, gl.UNSIGNED_BYTE, null);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.fboTex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  benchSize() {
    // Letterbox: bench is locked to the canonical aspect (portrait, golden
    // ratio). CSS handles the actual letterbox by pinning the canvas's
    // display aspect; the renderer just trusts the canvas size it was given.
    return { w: 556, h: 900 };
  }

  draw(scene, tracer) {
    const gl = this.gl;

    // --- Pass 1: rays → FBO ---
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.useProgram(this.rayProgram);
    gl.uniform2f(this.ray.uBench, scene.bench.w, scene.bench.h);
    gl.uniform1f(this.ray.uWidth, this.rayWidth);
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
    gl.bindBuffer(gl.ARRAY_BUFFER, this.rayCornerBuf);
    gl.enableVertexAttribArray(this.ray.aCorner);
    gl.vertexAttribPointer(this.ray.aCorner, 2, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(this.ray.aCorner, 0);
    if (tracer.segmentCount > 0) {
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, tracer.segmentCount);
    }
    gl.vertexAttribDivisor(this.ray.aSeg, 0);
    gl.vertexAttribDivisor(this.ray.aCol1, 0);
    gl.vertexAttribDivisor(this.ray.aCol2, 0);

    // --- Pass 2a: blit FBO → screen ---
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.disable(gl.BLEND);
    gl.useProgram(this.blitProgram);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.fboTex);
    gl.uniform1i(this.blit.uTex, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.unitQuadBuf);
    gl.enableVertexAttribArray(this.blit.aCorner);
    gl.vertexAttribPointer(this.blit.aCorner, 2, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    // --- Pass 2b: element interiors (distortion sampling the FBO) ---
    gl.useProgram(this.elemProgram);
    gl.uniform2f(this.elem.uBench, scene.bench.w, scene.bench.h);
    gl.uniform1i(this.elem.uFbo, 0); // FBO texture still bound on unit 0
    gl.bindBuffer(gl.ARRAY_BUFFER, this.unitQuadBuf);
    gl.enableVertexAttribArray(this.elem.aCorner);
    gl.vertexAttribPointer(this.elem.aCorner, 2, gl.FLOAT, false, 0, 0);
    for (const el of scene.elements) {
      this.drawElement(el);
    }

    // --- Pass 3: overlay (alpha-blended lines) ---
    this.buildOverlay(scene, tracer);
    gl.enable(gl.BLEND);
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

  drawElement(el) {
    const gl = this.gl;
    const { polygon } = worldEdges(el);
    const n = Math.min(polygon.length, MAX_EDGES);
    const look = LOOK[el.material] || DEFAULT_LOOK;

    // Fill edge uniform buffer.
    const ed = this._edgeData;
    for (let i = 0; i < n; i++) {
      const a = polygon[i], b = polygon[(i + 1) % polygon.length];
      ed[i * 4    ] = a.x;
      ed[i * 4 + 1] = a.y;
      ed[i * 4 + 2] = b.x;
      ed[i * 4 + 3] = b.y;
    }
    // Zero out unused edges to keep the fragment loop a no-op past uEdgeCount.
    for (let i = n * 4; i < ed.length; i++) ed[i] = 0;

    // AABB of polygon, padded so the distortion reach stays inside the quad.
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < polygon.length; i++) {
      const p = polygon[i];
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
    const pad = Math.max(look.falloff, look.edgeWidth) + 4;
    minX -= pad; minY -= pad; maxX += pad; maxY += pad;

    gl.uniform1i(this.elem.uEdgeCount, n);
    gl.uniform4fv(this.elem.uEdges, ed);
    gl.uniform2f(this.elem.uAabbMin, minX, minY);
    gl.uniform2f(this.elem.uAabbMax, maxX, maxY);
    // Per-element color override takes precedence over the material's tint.
    // Overridden colors also get a much stronger mix so the body reads as
    // that color, not just as a faint sheen.
    let tint = look.tint, edgeGlow = look.edgeGlow;
    let tintStrength = look.tintStrength;
    if (el.color) {
      const rgb = hexToRgb(el.color);
      tint = rgb;
      edgeGlow = rgb;
      tintStrength = 0.45;
    }
    gl.uniform3fv(this.elem.uTint, tint);
    gl.uniform1f(this.elem.uTintStrength, tintStrength);
    gl.uniform1f(this.elem.uMagnitude, this.distortEnabled ? look.magnitude : 0);
    gl.uniform1f(this.elem.uFalloff, look.falloff);
    gl.uniform3fv(this.elem.uEdgeGlow, edgeGlow);
    gl.uniform1f(this.elem.uEdgeGlowAmp, look.edgeGlowAmp);
    gl.uniform1f(this.elem.uEdgeWidth, look.edgeWidth);
    gl.uniform1f(this.elem.uOpaque, look.opaque ? 1.0 : 0.0);

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
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

  buildOverlay(scene, tracer) {
    this.overlayCount = 0;
    const binCount = tracer?.binCount ?? 64;
    // Per-sensor mini-spectrum is 64 bins × 6 stacked lines × 2 verts per line.
    let estimate = 8 + scene.emitter.count * 2 + scene.sensorCount * (2 + binCount * 6);
    for (const el of scene.elements) estimate += 100;
    this.ensureOverlayCapacity(estimate * 2);

    const { bench } = scene;
    this.rect(0, 0, bench.w, bench.h, 0.35, 0.4, 0.5, 0.6);

    const levels = scene.runtime.micLevels;
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

    // Mini-spectrum is drawn directly on the right wall (overlapping the
    // sensor tick area) only when the right side-panel readout isn't on
    // screen — e.g. mobile drawer closed, or panel scrolled off.
    const rp = (typeof document !== 'undefined') ? document.getElementById('right-panel') : null;
    let showMini = false;
    if (rp) {
      const rr = rp.getBoundingClientRect();
      showMini = rr.width === 0 || rr.left >= window.innerWidth - 1;
    }

    if (showMini && tracer && tracer.sensorBins && tracer.sensorCount === scene.sensorCount) {
      const stripW = Math.min(72, bench.w * 0.06);
      const stripH = Math.min(6, senStripH * 0.45);
      const x0 = bench.w - 2 - stripW;
      const binW = stripW / binCount;
      for (let s = 0; s < scene.sensorCount; s++) {
        const y = (s + 0.5) * senStripH;
        let maxVal = 1e-6;
        for (let b = 0; b < binCount; b++) {
          const v = tracer.sensorBins[s * binCount + b];
          if (v > maxVal) maxVal = v;
        }
        for (let b = 0; b < binCount; b++) {
          const v = tracer.sensorBins[s * binCount + b] / maxVal;
          if (v < 0.02) continue;
          const wl = 380 + (b + 0.5) / binCount * 400;
          const rgb = wavelengthToRGB(wl);
          const r = rgb[0] * v, g = rgb[1] * v, bl = rgb[2] * v;
          const bx = x0 + b * binW;
          for (let dy = -stripH * 0.5; dy <= stripH * 0.5; dy += 1) {
            this.line(bx, y + dy, bx + binW + 0.5, y + dy, r, g, bl, 0.95);
          }
        }
      }
    } else {
      // Plain ticks when the side-panel readout is taking the role.
      for (let s = 0; s < scene.sensorCount; s++) {
        const y = (s + 0.5) * senStripH;
        this.line(bench.w - 20, y, bench.w - 2, y, 0.6, 1, 0.9, 0.9);
      }
    }

    for (const el of scene.elements) {
      const { polygon } = worldEdges(el);
      const col = elementOutlineColor(el);
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

  // --- Sensor readout (right panel canvas bars) ---

  resetReadout() {
    this._displayBins = new Float32Array(0);
    this._peakMax = 1e-6;
  }

  updateReadout(scene, tracer) {
    const host = document.getElementById('sensor-readout');
    const bars = host.children;
    if (bars.length !== scene.sensorCount) return;
    const binCount = tracer.binCount;
    const totalBins = scene.sensorCount * binCount;

    if (this._displayBins.length !== totalBins) {
      this._displayBins = new Float32Array(totalBins);
      this._peakMax = 1e-6;
    }
    if (this._blurBuf.length < binCount) this._blurBuf = new Float32Array(binCount);

    // Temporal IIR: displayBins lerps toward sensorBins.
    const IIR = 0.3;
    for (let i = 0; i < totalBins; i++) {
      this._displayBins[i] += (tracer.sensorBins[i] - this._displayBins[i]) * IIR;
    }

    // Slow-decaying peak normalization.
    let curMax = 1e-6;
    for (let i = 0; i < totalBins; i++) {
      if (this._displayBins[i] > curMax) curMax = this._displayBins[i];
    }
    this._peakMax = Math.max(curMax, this._peakMax * 0.95);

    for (let s = 0; s < scene.sensorCount; s++) {
      const c = bars[s].querySelector('canvas');
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, c.width, c.height);

      // Gaussian blur across bins: [0.25, 0.5, 0.25] kernel.
      const base = s * binCount;
      const blur = this._blurBuf;
      for (let b = 0; b < binCount; b++) {
        const prev = b > 0 ? this._displayBins[base + b - 1] : this._displayBins[base + b];
        const cur  = this._displayBins[base + b];
        const next = b < binCount - 1 ? this._displayBins[base + b + 1] : cur;
        blur[b] = prev * 0.25 + cur * 0.5 + next * 0.25;
      }

      const wlMin = 380, wlMax = 780;
      for (let b = 0; b < binCount; b++) {
        const v = blur[b] / this._peakMax;
        if (v <= 0) continue;
        const wl = wlMin + (b + 0.5) / binCount * (wlMax - wlMin);
        const rgb = wavelengthToRGB(wl);
        const a = Math.min(1, v);
        ctx.fillStyle = `rgba(${(rgb[0] * 255)|0},${(rgb[1] * 255)|0},${(rgb[2] * 255)|0},${a})`;
        const x = (b / binCount) * c.width;
        const w = c.width / binCount + 1;
        ctx.fillRect(x, 0, w, c.height);
      }
    }
  }
}

// Overlay outline color per material. Interior colors are now handled by the
// element pass; this is just a faint edge stroke for selection feedback.
function elementOutlineColor(el) {
  switch (el.material) {
    case 'mirror':       return [0.85, 0.85, 1.0, 0.9];
    case 'mirror-red':   return [1.0, 0.4, 0.4, 0.9];
    case 'mirror-green': return [0.4, 1.0, 0.5, 0.9];
    case 'mirror-blue':  return [0.4, 0.5, 1.0, 0.9];
    case 'flint':        return [1.0, 0.7, 0.8, 0.6];
    case 'crown':        return [0.6, 0.9, 1.0, 0.6];
    case 'fused':        return [0.8, 1.0, 0.9, 0.6];
    case 'water':        return [0.6, 0.8, 1.0, 0.6];
    case 'diamond':      return [1.0, 1.0, 0.8, 0.7];
    case 'hyper':        return [1.0, 0.5, 1.0, 0.7];
    case 'slowGlass':    return [0.7, 0.6, 1.0, 0.7];
    default:             return [1, 1, 1, 0.6];
  }
}

function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return [1, 1, 1];
  return [parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255];
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
