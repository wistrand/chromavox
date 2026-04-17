// UI: input handling, property panel, save/load.

import { makeElement, worldEdges, pointInPolygon, serializeScene, deserializeScene, bumpIdCeiling } from './scene.js';
import { MATERIALS } from './spectrum.js';

// Undo/redo. Snapshots the mutable scene state (elements, emitter settings,
// sensor count, bench) as a JSON string. Rapid drags and slider scrubs are
// batched: `beginEdit` captures the pre-state lazily, `endEdit` commits if
// anything actually changed.
// Build an SVG icon for an Add-menu item by rendering the element's actual
// polygon (default rotation included). Single source of geometry — relies on
// `worldEdges` so any change to `localPolygon` automatically updates the
// menu icons.
function buildElementIcon(kind) {
  const el = makeElement(kind, 0, 0);
  const { polygon } = worldEdges(el);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of polygon) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  const W = Math.max(1, maxX - minX);
  const H = Math.max(1, maxY - minY);
  const pad = Math.max(W, H) * 0.06;
  const vbW = W + 2 * pad;
  const vbH = H + 2 * pad;
  const pts = polygon.map(p =>
    `${(p.x - minX + pad).toFixed(1)},${(p.y - minY + pad).toFixed(1)}`
  ).join(' ');
  const sw = (Math.max(vbW, vbH) * 0.045).toFixed(2);
  return `<svg class="tmi-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${vbW.toFixed(1)} ${vbH.toFixed(1)}" preserveAspectRatio="xMidYMid meet"><polygon points="${pts}" fill="rgba(140,200,255,0.22)" stroke="rgba(210,225,240,0.9)" stroke-width="${sw}" stroke-linejoin="round"/></svg>`;
}

function hexToHue(hex) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex || '');
  if (!m) return 0;
  const r = parseInt(m[1], 16) / 255;
  const g = parseInt(m[2], 16) / 255;
  const b = parseInt(m[3], 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const d = max - min;
  if (d === 0) return 0;
  let h;
  if (max === r)      h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else                h = (r - g) / d + 4;
  h *= 60;
  if (h < 0) h += 360;
  return h;
}

function hslToHex(h, s, l) {
  const hp = h / 360;
  const to2 = n => {
    const k = (n + hp * 12) % 12;
    const a = s * Math.min(l, 1 - l);
    const c = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(Math.max(0, Math.min(1, c)) * 255).toString(16).padStart(2, '0');
  };
  return '#' + to2(0) + to2(8) + to2(4);
}

class History {
  constructor(limit = 50) {
    this.past = [];
    this.future = [];
    this.limit = limit;
    this.pending = null;
  }
  _snap(scene) {
    return JSON.stringify({
      bench: scene.bench,
      emitter: {
        count: scene.emitter.count,
        wlMin: scene.emitter.wlMin,
        wlMax: scene.emitter.wlMax,
        raysPerSource: scene.emitter.raysPerSource,
        spreadDeg: scene.emitter.spreadDeg,
        apertureFactor: scene.emitter.apertureFactor,
        disabled: [...(scene.emitter.disabled ?? [])],
      },
      sensorCount: scene.sensorCount,
      elements: scene.elements.map(({ _selected, ...rest }) => rest),
    });
  }
  _restore(scene, snap) {
    const data = JSON.parse(snap);
    scene.bench = data.bench;
    Object.assign(scene.emitter, data.emitter);
    scene.emitter.disabled = new Set(data.emitter.disabled || []);
    scene.sensorCount = data.sensorCount;
    scene.elements = data.elements.map(e => ({ ...e }));
    let maxId = 0;
    for (const el of scene.elements) if (el.id > maxId) maxId = el.id;
    bumpIdCeiling(maxId);
  }
  begin(scene) {
    if (this.pending !== null) return;
    this.pending = this._snap(scene);
  }
  commit(scene) {
    if (this.pending === null) return;
    const cur = this._snap(scene);
    if (cur !== this.pending) {
      this.past.push(this.pending);
      if (this.past.length > this.limit) this.past.shift();
      this.future.length = 0;
    }
    this.pending = null;
  }
  undo(scene) {
    if (!this.past.length) return false;
    const cur = this._snap(scene);
    this._restore(scene, this.past.pop());
    this.future.push(cur);
    return true;
  }
  redo(scene) {
    if (!this.future.length) return false;
    const cur = this._snap(scene);
    this._restore(scene, this.future.pop());
    this.past.push(cur);
    return true;
  }
}

export class UI {
  constructor(scene, canvas, onChange) {
    this.scene = scene;
    this.canvas = canvas;
    this.onChange = onChange;
    this.tool = 'select';
    this.selected = null;
    this.dragging = null;
    this.history = new History();
    this.bindControls();
    this.bindTools();
    this.bindCanvas();
    this.bindSceneButtons();
    this.bindShortcuts();
    this.refreshEmitterLabels();
  }

  beginEdit() { this.history.begin(this.scene); }
  // Don't commit history while a drag is in flight — otherwise an
  // unrelated event (Shift keyup, slider change) can prematurely seal the
  // pending snapshot and the rest of the drag won't be recorded.
  endEdit()   { if (this.dragging) return; this.history.commit(this.scene); }

  bindShortcuts() {
    const STEP = 5;
    const ROT_STEP = 1 * Math.PI / 180;
    const SIZE_STEP = 8;
    const bumpSize = (el, d) => {
      switch (el.kind) {
        case 'prism':
        case 'rabbit':
          el.size = Math.max(20, el.size + d);
          break;
        case 'block':
          el.w = Math.max(20, el.w + d);
          el.h = Math.max(10, el.h + d * 0.5);
          break;
        case 'mirror':
          el.w = Math.max(20, el.w + d);
          break;
        case 'lens-convex':
          el.h = Math.max(40, el.h + d);
          el.radius = Math.max(80, el.radius + d);
          break;
        case 'lens-concave':
          el.h = Math.max(40, el.h + d);
          break;
        case 'circle':
          el.radius = Math.max(15, el.radius + d);
          break;
      }
    };

    window.addEventListener('keydown', e => {
      if (e.target.matches('input, select, textarea')) return;

      // Don't let UI shortcuts compete with an in-progress mouse drag —
      // lets the user play keyboard notes (or anything else) while moving
      // an element without delete/move/rotate/undo hijacking the gesture.
      if (this.dragging) return;

      if (e.ctrlKey || e.metaKey) {
        if (e.key === 'z' && !e.shiftKey) {
          e.preventDefault();
          if (this.history.undo(this.scene)) { this.select(null); this.rebuildSensorReadout(); this.syncControls(); this.onChange(); }
          return;
        }
        if ((e.key === 'z' && e.shiftKey) || e.key === 'y') {
          e.preventDefault();
          if (this.history.redo(this.scene)) { this.select(null); this.rebuildSensorReadout(); this.syncControls(); this.onChange(); }
          return;
        }
      }

      if (!this.selected) return;

      if (e.key === 'Backspace' || e.key === 'Delete') {
        e.preventDefault();
        this.beginEdit();
        const dead = this.selected;
        this.scene.elements = this.scene.elements.filter(el => el !== dead);
        this.select(null);
        this.endEdit();
        this.onChange();
        return;
      }

      let handled = true;
      if (e.shiftKey && e.key === 'ArrowLeft')       { this.beginEdit(); this.selected.rot -= ROT_STEP; }
      else if (e.shiftKey && e.key === 'ArrowRight') { this.beginEdit(); this.selected.rot += ROT_STEP; }
      else if (e.shiftKey && e.key === 'ArrowUp')    { this.beginEdit(); bumpSize(this.selected,  SIZE_STEP); }
      else if (e.shiftKey && e.key === 'ArrowDown')  { this.beginEdit(); bumpSize(this.selected, -SIZE_STEP); }
      else if (e.key === 'ArrowLeft')  { this.beginEdit(); this.selected.x -= STEP; }
      else if (e.key === 'ArrowRight') { this.beginEdit(); this.selected.x += STEP; }
      else if (e.key === 'ArrowUp')    { this.beginEdit(); this.selected.y -= STEP; }
      else if (e.key === 'ArrowDown')  { this.beginEdit(); this.selected.y += STEP; }
      else handled = false;

      if (handled) {
        e.preventDefault();
        this.renderPropPanel();
        this.onChange();
      }
    });

    window.addEventListener('keyup', e => {
      if (e.key.startsWith('Arrow') || e.key === 'Shift') this.endEdit();
    });
  }

  // --- Emitter / sensor sliders ---
  bindControls() {
    const map = [
      ['emitter-count', 'count', parseInt],
      ['wl-min', 'wlMin', parseInt],
      ['wl-max', 'wlMax', parseInt],
      ['rays-per', 'raysPerSource', parseInt],
      ['spread', 'spreadDeg', parseInt],
      ['aperture', 'apertureFactor', v => parseInt(v, 10) / 100],
    ];
    const sc = document.getElementById('sensor-count');
    const sensorFactor = () =>
      Math.max(1, parseInt(document.getElementById('sensor-factor').value, 10) || 1);
    const applySync = () => {
      const target = Math.min(parseInt(sc.max, 10),
        Math.max(1, this.scene.emitter.count * sensorFactor()));
      this.scene.sensorCount = target;
      sc.value = target;
      document.getElementById('sensor-count-val').textContent = target;
      this.rebuildSensorReadout();
    };

    for (const [id, key, cast] of map) {
      const el = document.getElementById(id);
      if (key === 'apertureFactor') el.value = Math.round(this.scene.emitter[key] * 100);
      else el.value = this.scene.emitter[key];
      el.addEventListener('input', () => {
        this.beginEdit();
        this.scene.emitter[key] = cast(el.value, 10);
        this.refreshEmitterLabels();
        if (key === 'count' && document.getElementById('sensor-sync').checked) {
          applySync();
        }
        this.onChange();
      });
      el.addEventListener('change', () => this.endEdit());
    }
    sc.value = this.scene.sensorCount;
    const factorIn = document.getElementById('sensor-factor');
    const syncIn = document.getElementById('sensor-sync');
    const syncFactorRow = () => {
      const on = syncIn.checked;
      const row = document.getElementById('sensor-factor-row');
      row.classList.toggle('row-disabled', !on);
      factorIn.disabled = !on;
    };
    syncFactorRow();

    sc.addEventListener('input', () => {
      this.beginEdit();
      this.scene.sensorCount = parseInt(sc.value, 10);
      document.getElementById('sensor-count-val').textContent = sc.value;
      // Manual change overrides sync.
      syncIn.checked = false;
      syncFactorRow();
      this.onChange();
      this.rebuildSensorReadout();
    });
    sc.addEventListener('change', () => this.endEdit());

    // When sync is turned on, snap sensor count to source × factor; either
    // way, refresh the factor-row enabled state.
    syncIn.addEventListener('change', e => {
      syncFactorRow();
      if (!e.target.checked) return;
      this.beginEdit();
      applySync();
      this.endEdit();
      this.onChange();
    });

    // Factor slider re-syncs immediately if sync is on.
    factorIn.addEventListener('input', () => {
      document.getElementById('sensor-factor-val').textContent = factorIn.value;
      if (!syncIn.checked) return;
      this.beginEdit();
      applySync();
      this.onChange();
    });
    factorIn.addEventListener('change', () => this.endEdit());
  }

  syncControls() {
    document.getElementById('emitter-count').value = this.scene.emitter.count;
    document.getElementById('wl-min').value = this.scene.emitter.wlMin;
    document.getElementById('wl-max').value = this.scene.emitter.wlMax;
    document.getElementById('rays-per').value = this.scene.emitter.raysPerSource;
    document.getElementById('spread').value = this.scene.emitter.spreadDeg;
    document.getElementById('aperture').value = Math.round((this.scene.emitter.apertureFactor ?? 0.01) * 100);
    document.getElementById('sensor-count').value = this.scene.sensorCount;
    this.refreshEmitterLabels();
  }
  refreshEmitterLabels() {
    document.getElementById('emitter-count-val').textContent = this.scene.emitter.count;
    document.getElementById('wl-min-val').textContent = this.scene.emitter.wlMin;
    document.getElementById('wl-max-val').textContent = this.scene.emitter.wlMax;
    document.getElementById('rays-per-val').textContent = this.scene.emitter.raysPerSource;
    document.getElementById('spread-val').textContent = this.scene.emitter.spreadDeg;
    document.getElementById('aperture-val').textContent = (this.scene.emitter.apertureFactor ?? 0.01).toFixed(2);
    document.getElementById('sensor-count-val').textContent = this.scene.sensorCount;
  }

  // --- Tool palette ---
  bindTools() {
    const btns = document.querySelectorAll('.tools > button');
    const placeable = new Set(['prism', 'block', 'lens-convex', 'lens-concave', 'mirror', 'rabbit', 'circle']);

    const place = kind => {
      this.beginEdit();
      const cx = this.scene.bench.w / 2;
      const cy = this.scene.bench.h / 2;
      const el = makeElement(kind, cx, cy);
      this.scene.elements.push(el);
      this.select(el);
      this.endEdit();
      this.onChange();
      btns.forEach(x => x.classList.toggle('active', x.dataset.tool === 'select'));
      this.tool = 'select';
    };

    btns.forEach(b => b.addEventListener('click', () => {
      const kind = b.dataset.tool;
      if (placeable.has(kind)) {
        place(kind);
      } else {
        btns.forEach(x => x.classList.remove('active'));
        b.classList.add('active');
        this.tool = kind;
      }
    }));

    // Add-element menu (div-based so future custom renderings fit).
    const addMenu = document.getElementById('add-menu');
    const addToggle = document.getElementById('add-toggle');
    const closeMenu = () => addMenu.classList.remove('open');
    addToggle.addEventListener('click', e => {
      e.stopPropagation();
      if (addMenu.classList.contains('open')) {
        addMenu.classList.remove('open');
        return;
      }
      const r = addToggle.getBoundingClientRect();
      addMenu.style.top = `${r.bottom + 4}px`;
      addMenu.style.left = `${r.left}px`;
      addMenu.classList.add('open');
    });
    addMenu.querySelectorAll('.tool-menu-item').forEach(item => {
      const kind = item.dataset.tool;
      // Render the element's actual polygon as the menu icon — re-uses the
      // same geometry as `localPolygon` / `worldEdges`, no duplication.
      item.insertAdjacentHTML('afterbegin', buildElementIcon(kind));
      item.addEventListener('click', () => {
        if (placeable.has(kind)) place(kind);
        closeMenu();
      });
    });
    document.addEventListener('click', e => {
      if (addMenu.classList.contains('open') && !addMenu.contains(e.target) && e.target !== addToggle) {
        closeMenu();
      }
    });
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && addMenu.classList.contains('open')) closeMenu();
    });
  }

  // --- Canvas pointer events ---
  bindCanvas() {
    const c = this.canvas;
    this.pointers = new Map();
    c.addEventListener('pointerdown', e => this.onDown(e));
    c.addEventListener('pointermove', e => this.onMove(e));
    c.addEventListener('pointerup', e => this.onUp(e));
    c.addEventListener('pointercancel', e => this.onUp(e));
    c.addEventListener('contextmenu', e => e.preventDefault());
  }

  _captureBaseSize(el) {
    return { size: el.size, w: el.w, h: el.h, radius: el.radius };
  }
  _applyPinchScale(el, base, s) {
    switch (el.kind) {
      case 'prism':
      case 'rabbit':
        el.size = Math.max(20, base.size * s);
        break;
      case 'block':
        el.w = Math.max(20, base.w * s);
        el.h = Math.max(10, base.h * s);
        break;
      case 'mirror':
        el.w = Math.max(20, base.w * s);
        break;
      case 'lens-convex':
        el.h = Math.max(40, base.h * s);
        el.radius = Math.max(80, base.radius * s);
        break;
      case 'lens-concave':
        el.h = Math.max(40, base.h * s);
        el.radius = Math.max(80, base.radius * s);
        break;
      case 'circle':
        el.radius = Math.max(15, base.radius * s);
        break;
    }
  }
  _applyEmitterToggle(sIdx, solo) {
    const n = this.scene.emitter.count;
    const dis = this.scene.emitter.disabled || (this.scene.emitter.disabled = new Set());
    this.beginEdit();
    if (solo) {
      const onlyOn = !dis.has(sIdx) && dis.size === n - 1;
      dis.clear();
      if (!onlyOn) {
        for (let i = 0; i < n; i++) if (i !== sIdx) dis.add(i);
      }
    } else {
      if (dis.has(sIdx)) dis.delete(sIdx); else dis.add(sIdx);
    }
    this.endEdit();
    this.onChange();
  }
  _startPinchIfTwoPointers() {
    if (this.pointers.size !== 2 || !this.selected) return;
    const pts = [...this.pointers.values()];
    const dx = pts[1].x - pts[0].x, dy = pts[1].y - pts[0].y;
    const dist = Math.hypot(dx, dy) || 1;
    const angle = Math.atan2(dy, dx);
    this.beginEdit();
    this.dragging = {
      type: 'pinch',
      startDist: dist,
      startAngle: angle,
      startRot: this.selected.rot,
      baseSize: this._captureBaseSize(this.selected),
    };
  }

  canvasToBench(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    const { w: bw, h: bh } = this.scene.bench;
    const x = (clientX - rect.left) / rect.width * bw;
    const y = (clientY - rect.top) / rect.height * bh;
    return { x, y };
  }

  hitTestElement(x, y) {
    for (let i = this.scene.elements.length - 1; i >= 0; i--) {
      const el = this.scene.elements[i];
      const { polygon } = worldEdges(el);
      if (pointInPolygon(polygon, x, y)) return el;
    }
    return null;
  }

  onDown(e) {
    this.canvas.setPointerCapture(e.pointerId);
    const { x, y } = this.canvasToBench(e.clientX, e.clientY);
    this.pointers.set(e.pointerId, { x, y });

    // Second simultaneous pointer on a selected element starts a pinch
    // (scale + rotate) gesture, superseding any single-pointer drag.
    if (this.pointers.size === 2 && this.selected) {
      this._startPinchIfTwoPointers();
      return;
    }

    // Click on left-wall tick area toggles that source. Shift-click or long
    // press (≥450 ms) solos it.
    if (x >= 0 && x <= 30) {
      const n = this.scene.emitter.count;
      const sIdx = Math.max(0, Math.min(n - 1, Math.floor(y / (this.scene.bench.h / n))));
      if (e.shiftKey) {
        this._applyEmitterToggle(sIdx, true);
        return;
      }
      const pending = { pointerId: e.pointerId, sIdx, x, y, applied: false, timer: 0 };
      this.emitterPending = pending;
      // Identity check inside the closure: a stale timer from a previous
      // press must not fire against the current pending object.
      pending.timer = setTimeout(() => {
        if (this.emitterPending === pending) {
          this._applyEmitterToggle(sIdx, true);
          pending.applied = true;
        }
      }, 450);
      return;
    }

    const hit = this.hitTestElement(x, y);
    if (this.tool === 'select') {
      if (hit) {
        this.beginEdit();
        this.select(hit);
        if (e.shiftKey || e.button === 2) {
          const a = Math.atan2(y - hit.y, x - hit.x);
          this.dragging = { type: 'rotate', startAngle: a, startRot: hit.rot };
        } else {
          this.dragging = { type: 'move', dx: hit.x - x, dy: hit.y - y };
        }
      } else {
        this.select(null);
      }
    } else if (this.tool === 'delete') {
      if (hit) {
        this.beginEdit();
        this.scene.elements = this.scene.elements.filter(e => e !== hit);
        this.select(null);
        this.endEdit();
        this.onChange();
      }
    } else {
      // Place a new element of this kind.
      this.beginEdit();
      const el = makeElement(this.tool, x, y);
      this.scene.elements.push(el);
      this.select(el);
      this.dragging = { type: 'move', dx: 0, dy: 0 };
      document.querySelectorAll('.tools button').forEach(b => {
        b.classList.toggle('active', b.dataset.tool === 'select');
      });
      this.tool = 'select';
      this.onChange();
    }
  }

  onMove(e) {
    const { x, y } = this.canvasToBench(e.clientX, e.clientY);
    if (this.pointers.has(e.pointerId)) {
      this.pointers.set(e.pointerId, { x, y });
    }
    // Cancel a pending emitter long-press if the pointer drifts too far.
    if (this.emitterPending && this.emitterPending.pointerId === e.pointerId) {
      const dx = x - this.emitterPending.x, dy = y - this.emitterPending.y;
      if (dx * dx + dy * dy > 18 * 18) {
        clearTimeout(this.emitterPending.timer);
        this.emitterPending = null;
      }
      return;
    }
    if (!this.dragging || !this.selected) return;
    if (this.dragging.type === 'pinch' && this.pointers.size >= 2) {
      const pts = [...this.pointers.values()];
      const dx = pts[1].x - pts[0].x, dy = pts[1].y - pts[0].y;
      const dist = Math.hypot(dx, dy) || 1;
      const angle = Math.atan2(dy, dx);
      const scale = dist / this.dragging.startDist;
      this.selected.rot = this.dragging.startRot + (angle - this.dragging.startAngle);
      this._applyPinchScale(this.selected, this.dragging.baseSize, scale);
      this.renderPropPanel();
      this.onChange();
    } else if (this.dragging.type === 'move') {
      this.selected.x = x + this.dragging.dx;
      this.selected.y = y + this.dragging.dy;
      this.onChange();
    } else if (this.dragging.type === 'rotate') {
      const a = Math.atan2(y - this.selected.y, x - this.selected.x);
      this.selected.rot = this.dragging.startRot + (a - this.dragging.startAngle);
      this.renderPropPanel();
      this.onChange();
    }
  }

  onUp(e) {
    try { this.canvas.releasePointerCapture(e.pointerId); } catch {}
    this.pointers.delete(e.pointerId);
    // Emitter long-press / click resolution.
    if (this.emitterPending && this.emitterPending.pointerId === e.pointerId) {
      clearTimeout(this.emitterPending.timer);
      if (!this.emitterPending.applied) {
        this._applyEmitterToggle(this.emitterPending.sIdx, false);
      }
      this.emitterPending = null;
      return;
    }
    // End pinch only when fewer than two pointers remain.
    if (this.dragging?.type === 'pinch' && this.pointers.size < 2) {
      this.dragging = null;
      this.endEdit();
      return;
    }
    this.dragging = null;
    this.endEdit();
  }

  select(el) {
    if (this.selected) this.selected._selected = false;
    this.selected = el;
    if (el) el._selected = true;
    this.renderPropPanel();
    this.onChange();
  }

  // --- Property panel ---
  renderPropPanel() {
    const panel = document.getElementById('prop-panel');
    panel.innerHTML = '';
    const el = this.selected;
    if (!el) { panel.innerHTML = '<em>No selection</em>'; return; }

    const addRow = (label, input) => {
      const row = document.createElement('div');
      row.className = 'prop';
      const lab = document.createElement('label');
      lab.textContent = label;
      row.appendChild(lab);
      row.appendChild(input);
      panel.appendChild(row);
    };

    const title = document.createElement('div');
    title.innerHTML = `<strong>${el.kind}</strong> #${el.id}`;
    panel.appendChild(title);

    // Rotation
    const rot = document.createElement('input');
    rot.type = 'range'; rot.min = -180; rot.max = 180; rot.step = 1;
    rot.value = Math.round(el.rot * 180 / Math.PI);
    rot.addEventListener('input', () => {
      this.beginEdit();
      el.rot = parseFloat(rot.value) * Math.PI / 180;
      this.onChange();
    });
    rot.addEventListener('change', () => this.endEdit());
    addRow('Rotation', rot);

    // Material: mirror elements pick among mirror variants; everything else
    // picks among dielectrics.
    const wantType = (el.kind === 'mirror') ? 'mirror' : 'dielectric';
    const sel = document.createElement('select');
    for (const k of Object.keys(MATERIALS)) {
      if (MATERIALS[k].type !== wantType) continue;
      const opt = document.createElement('option');
      opt.value = k; opt.textContent = k;
      if (k === el.material) opt.selected = true;
      sel.appendChild(opt);
    }
    sel.addEventListener('change', () => {
      this.beginEdit();
      el.material = sel.value;
      this.endEdit();
      this.onChange();
    });
    addRow('Material', sel);

    // Color override: optional per-element tint that replaces the material's
    // default visual color. Reset button clears el.color so the material
    // default is restored.
    const MATERIAL_COLOR_HINT = {
      crown: '#8ccbff', flint: '#ffb3cc', fused: '#d9ffe6', water: '#80bfff',
      diamond: '#ffffe6', hyper: '#ff80ff', slowGlass: '#9b80e0',
      mirror: '#bfccff', 'mirror-red': '#ff6666',
      'mirror-green': '#66ff6e', 'mirror-blue': '#6670ff',
    };
    const colorRow = document.createElement('div');
    colorRow.style.display = 'flex';
    colorRow.style.gap = '4px';
    const colorInput = document.createElement('input');
    colorInput.type = 'color';
    colorInput.style.flex = '1';
    const initialColor = el.color || MATERIAL_COLOR_HINT[el.material] || '#cccccc';
    colorInput.value = initialColor;
    const resetBtn = document.createElement('button');
    resetBtn.textContent = '×';
    resetBtn.title = 'Reset to material default';
    colorRow.appendChild(colorInput);
    colorRow.appendChild(resetBtn);
    addRow('Color', colorRow);

    // Hue slider lets the user scrub through the spectrum live. Mirrors the
    // color picker value both ways.
    const hueInput = document.createElement('input');
    hueInput.type = 'range';
    hueInput.min = 0; hueInput.max = 360; hueInput.step = 1;
    hueInput.value = hexToHue(initialColor);
    hueInput.style.background = 'linear-gradient(to right, #f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00)';
    addRow('Hue', hueInput);

    colorInput.addEventListener('input', () => {
      this.beginEdit();
      el.color = colorInput.value;
      hueInput.value = hexToHue(el.color);
      this.onChange();
    });
    colorInput.addEventListener('change', () => this.endEdit());
    hueInput.addEventListener('input', () => {
      this.beginEdit();
      const hex = hslToHex(parseInt(hueInput.value, 10), 1, 0.5);
      el.color = hex;
      colorInput.value = hex;
      this.onChange();
    });
    hueInput.addEventListener('change', () => this.endEdit());
    resetBtn.addEventListener('click', () => {
      this.beginEdit();
      delete el.color;
      this.endEdit();
      const fallback = MATERIAL_COLOR_HINT[el.material] || '#cccccc';
      colorInput.value = fallback;
      hueInput.value = hexToHue(fallback);
      this.onChange();
    });

    // Delay slider — overrides the material's `delayK`. Audio echo per
    // bench unit of internal path. Mirrors don't accumulate inside-stack
    // time so the slider has no effect on them; shown for consistency.
    const DELAY_MAX = 0.005; // s per bench unit; max ~1 s through 200 units
    const delayRow = document.createElement('div');
    delayRow.style.display = 'flex';
    delayRow.style.gap = '4px';
    const delayInput = document.createElement('input');
    delayInput.type = 'range';
    delayInput.min = 0; delayInput.max = 100; delayInput.step = 1;
    delayInput.style.flex = '1';
    const matDelay = MATERIALS[el.material]?.delayK ?? 0;
    const initialDelay = (typeof el.delayK === 'number') ? el.delayK : matDelay;
    delayInput.value = Math.round((initialDelay / DELAY_MAX) * 100);
    const delayResetBtn = document.createElement('button');
    delayResetBtn.textContent = '×';
    delayResetBtn.title = 'Zero delay';
    delayRow.appendChild(delayInput);
    delayRow.appendChild(delayResetBtn);
    addRow('Delay', delayRow);

    delayInput.addEventListener('input', () => {
      this.beginEdit();
      el.delayK = (parseInt(delayInput.value, 10) / 100) * DELAY_MAX;
      this.onChange();
    });
    delayInput.addEventListener('change', () => this.endEdit());
    delayResetBtn.addEventListener('click', () => {
      this.beginEdit();
      el.delayK = 0;
      this.endEdit();
      delayInput.value = 0;
      this.onChange();
    });

    // Size params per kind
    const sizeFields = {
      'prism':        [['size', 40, 300]],
      'rabbit':       [['size', 60, 300]],
      'circle':       [['radius', 20, 300]],
      'block':        [['w', 40, 400], ['h', 20, 300]],
      'lens-convex':  [['h', 40, 300], ['radius', 80, 1200]],
      'lens-concave': [['w', 20, 200], ['h', 40, 300], ['radius', 80, 800]],
      'mirror':       [['w', 30, 400], ['h', 2, 20]],
    };
    for (const [key, min, max] of sizeFields[el.kind] || []) {
      const inp = document.createElement('input');
      inp.type = 'range'; inp.min = min; inp.max = max; inp.step = 1;
      inp.value = el[key];
      inp.addEventListener('input', () => {
        this.beginEdit();
        el[key] = parseFloat(inp.value);
        this.onChange();
      });
      inp.addEventListener('change', () => this.endEdit());
      addRow(key, inp);
    }

    // Delete
    const del = document.createElement('button');
    del.textContent = 'Delete';
    del.addEventListener('click', () => {
      this.beginEdit();
      this.scene.elements = this.scene.elements.filter(e => e !== el);
      this.select(null);
      this.endEdit();
      this.onChange();
    });
    panel.appendChild(del);
  }

  // --- Save / load / clear ---
  bindSceneButtons() {
    document.getElementById('save').addEventListener('click', () => {
      const text = serializeScene(this.scene);
      const blob = new Blob([text], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = 'chromavox.json';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });

    const fileInput = document.getElementById('file-input');
    document.getElementById('load').addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', async () => {
      const f = fileInput.files[0];
      if (!f) return;
      const text = await f.text();
      try {
        this.beginEdit();
        const scene = deserializeScene(text);
        Object.assign(this.scene, scene);
        window.dispatchEvent(new Event('resize'));
        this.syncControls();
        this.select(null);
        this.rebuildSensorReadout();
        this.endEdit();
        this.onChange();
      } catch (err) {
        alert('Load failed: ' + err.message);
      }
      fileInput.value = '';
    });

    document.getElementById('clear').addEventListener('click', () => {
      this.beginEdit();
      this.scene.elements = [];
      this.select(null);
      this.endEdit();
      this.onChange();
    });

    this.bindPresets();

    // Per-side drawer toggles. Simple on/off each.
    const app = document.getElementById('app');
    document.getElementById('left-toggle').addEventListener('click', () => {
      app.classList.toggle('show-left');
    });
    document.getElementById('right-toggle').addEventListener('click', () => {
      app.classList.toggle('show-right');
    });
  }

  async bindPresets() {
    const sel = document.getElementById('preset-select');
    try {
      const list = await (await fetch('presets/index.json')).json();
      for (const p of list) {
        const opt = document.createElement('option');
        opt.value = p.file; opt.textContent = p.label;
        sel.appendChild(opt);
      }
    } catch {
      sel.disabled = true;
      return;
    }
    sel.addEventListener('change', async () => {
      const file = sel.value;
      if (!file) return;
      try {
        this.beginEdit();
        const text = await (await fetch('presets/' + file)).text();
        const scene = deserializeScene(text);
        Object.assign(this.scene, scene);
        window.dispatchEvent(new Event('resize'));
        this.syncControls();
        this.select(null);
        this.rebuildSensorReadout();
        this.endEdit();
        this.onChange();
      } catch (err) {
        alert('Preset load failed: ' + err.message);
      }
      sel.value = '';
    });
  }

  // Sensor readout rebuild (when sensor count changes).
  rebuildSensorReadout() {
    const host = document.getElementById('sensor-readout');
    host.innerHTML = '';
    for (let i = 0; i < this.scene.sensorCount; i++) {
      const bar = document.createElement('div');
      bar.className = 'sensor-bar';
      const c = document.createElement('canvas');
      c.width = 128; c.height = 14;
      bar.appendChild(c);
      host.appendChild(bar);
    }
  }
}
