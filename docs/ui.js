// UI: input handling, property panel, save/load.

import { makeElement, worldEdges, pointInPolygon, serializeScene, deserializeScene, bumpIdCeiling } from './scene.js';
import { MATERIALS } from './spectrum.js';

// Undo/redo. Snapshots the mutable scene state (elements, emitter settings,
// sensor count, bench) as a JSON string. Rapid drags and slider scrubs are
// batched: `beginEdit` captures the pre-state lazily, `endEdit` commits if
// anything actually changed.
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
  endEdit()   { this.history.commit(this.scene); }

  bindShortcuts() {
    const STEP = 5;
    const ROT_STEP = 1 * Math.PI / 180;

    window.addEventListener('keydown', e => {
      if (e.target.matches('input, select, textarea')) return;

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
      if (e.shiftKey && e.key === 'ArrowLeft')  { this.beginEdit(); this.selected.rot -= ROT_STEP; }
      else if (e.shiftKey && e.key === 'ArrowRight') { this.beginEdit(); this.selected.rot += ROT_STEP; }
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
    for (const [id, key, cast] of map) {
      const el = document.getElementById(id);
      if (key === 'apertureFactor') el.value = Math.round(this.scene.emitter[key] * 100);
      else el.value = this.scene.emitter[key];
      el.addEventListener('input', () => {
        this.beginEdit();
        this.scene.emitter[key] = cast(el.value, 10);
        this.refreshEmitterLabels();
        this.onChange();
      });
      el.addEventListener('change', () => this.endEdit());
    }
    const sc = document.getElementById('sensor-count');
    sc.value = this.scene.sensorCount;
    sc.addEventListener('input', () => {
      this.beginEdit();
      this.scene.sensorCount = parseInt(sc.value, 10);
      document.getElementById('sensor-count-val').textContent = sc.value;
      this.onChange();
      this.rebuildSensorReadout();
    });
    sc.addEventListener('change', () => this.endEdit());
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
    const btns = document.querySelectorAll('.tools button');
    btns.forEach(b => b.addEventListener('click', () => {
      btns.forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      this.tool = b.dataset.tool;
    }));
  }

  // --- Canvas pointer events ---
  bindCanvas() {
    const c = this.canvas;
    c.addEventListener('pointerdown', e => this.onDown(e));
    c.addEventListener('pointermove', e => this.onMove(e));
    c.addEventListener('pointerup', e => this.onUp(e));
    c.addEventListener('pointercancel', e => this.onUp(e));
    c.addEventListener('contextmenu', e => e.preventDefault());
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

    // Click on left-wall tick area toggles that source. Shift-click solos it.
    if (x >= 0 && x <= 30) {
      const n = this.scene.emitter.count;
      const sIdx = Math.max(0, Math.min(n - 1, Math.floor(y / (this.scene.bench.h / n))));
      const dis = this.scene.emitter.disabled || (this.scene.emitter.disabled = new Set());
      this.beginEdit();
      if (e.shiftKey) {
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
    if (!this.dragging || !this.selected) return;
    const { x, y } = this.canvasToBench(e.clientX, e.clientY);
    if (this.dragging.type === 'move') {
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

    // Size params per kind
    const sizeFields = {
      'prism':        [['size', 40, 300]],
      'rabbit':       [['size', 60, 300]],
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

    // Mobile panel toggle.
    const tog = document.getElementById('panel-toggle');
    tog.addEventListener('click', () => {
      const app = document.getElementById('app');
      if (app.classList.contains('show-left')) {
        app.classList.remove('show-left');
        app.classList.add('show-right');
      } else if (app.classList.contains('show-right')) {
        app.classList.remove('show-right');
      } else {
        app.classList.add('show-left');
      }
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
