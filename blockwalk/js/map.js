/** Offline canvas map. Procedural streets, no tile server, no API key. */

import { projectLocal, unprojectLocal } from './geo.js';
import { DEMO_ORIGIN, DEMO_LABEL } from './sample.js';
import { isStreetZoom } from './solar.js';

const GRID = 110;

export class CanvasMap {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.center = { lat: DEMO_ORIGIN.lat, lng: DEMO_ORIGIN.lng };
    this.mpp = 2.4;
    this.stops = [];
    this.parks = [];
    this.drive = [];
    this.walks = [];
    this.areas = [];
    this.showAreas = false;
    this.mode = 'map';
    this.me = null;
    this.selectedId = null;
    this.flux = null;
    this.fluxCanvas = null;
    this.onSelect = () => {};
    this.onLongPress = () => {};
    this.onDragEnd = () => {};
    this.onView = () => {};
    this.pointers = new Map();
    this.drag = null;
    this.cssW = 1;
    this.cssH = 1;
    this._bind();
    this.resize();
  }

  resize() {
    const r = this.canvas.getBoundingClientRect();
    this.cssW = Math.max(1, r.width);
    this.cssH = Math.max(1, r.height);
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.canvas.width = Math.round(this.cssW * dpr);
    this.canvas.height = Math.round(this.cssH * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.draw();
  }

  metersPerPixel() {
    return this.mpp;
  }

  setData(data) {
    this.stops = data.stops || [];
    this.parks = data.parks || [];
    this.drive = data.drive || [];
    this.walks = data.walks || [];
    this.areas = data.areas || [];
    this.showAreas = Boolean(data.showAreas);
    this.mode = data.mode || 'map';
    this.me = data.me || null;
    this.selectedId = data.selectedId || null;
    if (data.flux !== this.flux) {
      this.flux = data.flux || null;
      this.fluxCanvas = null;
    }
    this.draw();
  }

  fit(points, padding) {
    if (!points.length) return;
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const p of points) {
      const w = projectLocal(p.lat, p.lng, DEMO_ORIGIN.lat, DEMO_ORIGIN.lng);
      if (w.x < minX) minX = w.x;
      if (w.x > maxX) maxX = w.x;
      if (w.y < minY) minY = w.y;
      if (w.y > maxY) maxY = w.y;
    }
    const pad = padding || { top: 130, bottom: 340, left: 36, right: 72 };
    const availW = Math.max(40, this.cssW - pad.left - pad.right);
    const availH = Math.max(40, this.cssH - pad.top - pad.bottom);
    const spanX = Math.max(40, maxX - minX);
    const spanY = Math.max(40, maxY - minY);
    this.mpp = Math.max(spanX / availW, spanY / availH) * 1.18;
    const midX = (minX + maxX) / 2;
    const midY = (minY + maxY) / 2;
    const shift = ((pad.bottom - pad.top) / 2) * this.mpp;
    this.center = unprojectLocal(midX, midY - shift, DEMO_ORIGIN.lat, DEMO_ORIGIN.lng);
    this.draw();
    this.onView(this.mpp);
  }

  project(lat, lng) {
    const p = projectLocal(lat, lng, DEMO_ORIGIN.lat, DEMO_ORIGIN.lng);
    const c = projectLocal(this.center.lat, this.center.lng, DEMO_ORIGIN.lat, DEMO_ORIGIN.lng);
    return {
      x: this.cssW / 2 + (p.x - c.x) / this.mpp,
      y: this.cssH / 2 - (p.y - c.y) / this.mpp,
    };
  }

  unproject(x, y) {
    const c = projectLocal(this.center.lat, this.center.lng, DEMO_ORIGIN.lat, DEMO_ORIGIN.lng);
    const wx = c.x + (x - this.cssW / 2) * this.mpp;
    const wy = c.y - (y - this.cssH / 2) * this.mpp;
    return unprojectLocal(wx, wy, DEMO_ORIGIN.lat, DEMO_ORIGIN.lng);
  }

  _bind() {
    const canvas = this.canvas;
    canvas.addEventListener('pointerdown', (e) => this._down(e));
    canvas.addEventListener('pointermove', (e) => this._move(e));
    canvas.addEventListener('pointerup', (e) => this._up(e));
    canvas.addEventListener('pointercancel', (e) => this._up(e));
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      this._zoomAt(e.clientX - rect.left, e.clientY - rect.top, e.deltaY < 0 ? 0.8 : 1.25);
    }, { passive: false });
    window.addEventListener('resize', () => this.resize());
  }

  _zoomAt(x, y, factor) {
    const before = this.unproject(x, y);
    this.mpp = Math.min(80, Math.max(0.4, this.mpp * factor));
    const after = this.unproject(x, y);
    const c = projectLocal(this.center.lat, this.center.lng, DEMO_ORIGIN.lat, DEMO_ORIGIN.lng);
    const b = projectLocal(before.lat, before.lng, DEMO_ORIGIN.lat, DEMO_ORIGIN.lng);
    const a = projectLocal(after.lat, after.lng, DEMO_ORIGIN.lat, DEMO_ORIGIN.lng);
    this.center = unprojectLocal(c.x + (b.x - a.x), c.y + (b.y - a.y), DEMO_ORIGIN.lat, DEMO_ORIGIN.lng);
    this.draw();
    this.onView(this.mpp);
  }

  _localPoint(e) {
    const rect = this.canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  _hitStop(x, y) {
    let best = null;
    let bestD = 22;
    for (const stop of this.stops) {
      if (stop.lat == null) continue;
      const p = this.project(stop.lat, stop.lng);
      const d = Math.hypot(p.x - x, p.y - y);
      if (d < bestD) {
        bestD = d;
        best = stop;
      }
    }
    return best;
  }

  _down(e) {
    this.canvas.setPointerCapture(e.pointerId);
    const p = this._localPoint(e);
    this.pointers.set(e.pointerId, p);
    if (this.pointers.size === 1) {
      const hit = this._hitStop(p.x, p.y);
      this.drag = {
        id: e.pointerId,
        x: p.x,
        y: p.y,
        moved: false,
        hit,
        pin: hit && hit.status === 'flag' ? hit : null,
        timer: setTimeout(() => {
          if (this.drag && !this.drag.moved && !this.drag.hit) {
            const ll = this.unproject(this.drag.x, this.drag.y);
            this.onLongPress(ll, this.drag.x, this.drag.y);
            this.drag.fired = true;
          }
        }, 480),
      };
    }
  }

  _move(e) {
    const p = this._localPoint(e);
    this.pointers.set(e.pointerId, p);
    if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      if (this.pinchDist) {
        const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        this._zoomAt(mid.x, mid.y, this.pinchDist / dist);
      }
      this.pinchDist = dist;
      return;
    }
    if (!this.drag || this.drag.id !== e.pointerId) return;
    const dx = p.x - this.drag.x;
    const dy = p.y - this.drag.y;
    if (Math.hypot(dx, dy) > 6) this.drag.moved = true;
    if (this.drag.pin && this.drag.moved) {
      const ll = this.unproject(p.x, p.y);
      this.drag.pin.lat = ll.lat;
      this.drag.pin.lng = ll.lng;
      this.drag.dropped = ll;
      this.draw();
      return;
    }
    if (this.drag.moved && !this.drag.pin) {
      const c = projectLocal(this.center.lat, this.center.lng, DEMO_ORIGIN.lat, DEMO_ORIGIN.lng);
      this.center = unprojectLocal(c.x - dx * this.mpp, c.y + dy * this.mpp, DEMO_ORIGIN.lat, DEMO_ORIGIN.lng);
      this.drag.x = p.x;
      this.drag.y = p.y;
      this.draw();
    }
  }

  _up(e) {
    const drag = this.drag;
    this.pointers.delete(e.pointerId);
    if (this.pointers.size < 2) this.pinchDist = 0;
    if (!drag || drag.id !== e.pointerId) return;
    clearTimeout(drag.timer);
    this.drag = null;
    if (drag.pin && drag.dropped) this.onDragEnd(drag.pin, drag.dropped);
    else if (!drag.moved && !drag.fired && drag.hit) this.onSelect(drag.hit);
    else if (drag.moved) this.onView(this.mpp);
  }

  draw() {
    const ctx = this.ctx;
    const w = this.cssW;
    const h = this.cssH;
    const sat = this.mode === 'satellite';
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = sat ? '#1c2822' : '#e3eee4';
    ctx.fillRect(0, 0, w, h);
    this._streets(ctx, sat);
    if (this.showAreas) this._areas(ctx);
    if (this.flux && isStreetZoom(this.mpp)) this._flux(ctx);
    this._line(ctx, this.drive, '#1a73e8', 4, []);
    for (const walk of this.walks) this._line(ctx, walk, '#1a73e8', 2, [5, 4]);
    this._stops(ctx);
    this._parks(ctx);
    if (this.me) this._me(ctx);
    const here = projectLocal(this.center.lat, this.center.lng, DEMO_ORIGIN.lat, DEMO_ORIGIN.lng);
    if (Math.hypot(here.x, here.y) < 2500 && this.mpp < 12) {
      ctx.fillStyle = sat ? 'rgba(255,255,255,.75)' : 'rgba(32,33,36,.55)';
      ctx.font = '600 13px Segoe UI, sans-serif';
      ctx.fillText(DEMO_LABEL, 16, 78);
    }
  }

  _streets(ctx, sat) {
    const c = projectLocal(this.center.lat, this.center.lng, DEMO_ORIGIN.lat, DEMO_ORIGIN.lng);
    const halfW = (this.cssW / 2) * this.mpp + GRID;
    const halfH = (this.cssH / 2) * this.mpp + GRID;
    const x0 = Math.floor((c.x - halfW) / GRID) * GRID;
    const x1 = c.x + halfW;
    const y0 = Math.floor((c.y - halfH) / GRID) * GRID;
    const y1 = c.y + halfH;
    ctx.lineCap = 'square';
    for (let x = x0; x <= x1; x += GRID) {
      const major = Math.round(x / GRID) % 4 === 0;
      this._streetLine(ctx, { x, y: y0 }, { x, y: y1 }, major, sat);
    }
    for (let y = y0; y <= y1; y += GRID) {
      const major = Math.round(y / GRID) % 4 === 0;
      this._streetLine(ctx, { x: x0, y }, { x: x1, y }, major, sat);
    }
    if (!sat) {
      ctx.fillStyle = '#c9dfbc';
      const park = this.projectLatLngMeters(40, 360);
      const park2 = this.projectLatLngMeters(180, 460);
      if (park && park2) {
        ctx.fillRect(park.x, park2.y, park2.x - park.x, park.y - park2.y);
      }
    }
  }

  projectLatLngMeters(x, y) {
    const ll = unprojectLocal(x, y, DEMO_ORIGIN.lat, DEMO_ORIGIN.lng);
    return this.project(ll.lat, ll.lng);
  }

  _streetLine(ctx, a, b, major, sat) {
    const aLl = unprojectLocal(a.x, a.y, DEMO_ORIGIN.lat, DEMO_ORIGIN.lng);
    const bLl = unprojectLocal(b.x, b.y, DEMO_ORIGIN.lat, DEMO_ORIGIN.lng);
    const pa = this.project(aLl.lat, aLl.lng);
    const pb = this.project(bLl.lat, bLl.lng);
    ctx.strokeStyle = sat ? (major ? '#445248' : '#314038') : (major ? '#ffffff' : '#f4f7f4');
    ctx.lineWidth = sat ? (major ? 7 : 4) : (major ? 8 : 5);
    ctx.beginPath();
    ctx.moveTo(pa.x, pa.y);
    ctx.lineTo(pb.x, pb.y);
    ctx.stroke();
  }

  _line(ctx, points, color, width, dash) {
    if (!points || points.length < 2) return;
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.setLineDash(dash);
    ctx.beginPath();
    points.forEach((p, i) => {
      const s = this.project(p.lat, p.lng);
      if (i === 0) ctx.moveTo(s.x, s.y);
      else ctx.lineTo(s.x, s.y);
    });
    ctx.stroke();
    ctx.restore();
  }

  _areas(ctx) {
    const colors = ['rgba(26,115,232,.16)', 'rgba(24,128,56,.16)', 'rgba(227,116,0,.16)', 'rgba(142,68,173,.16)'];
    this.areas.forEach((area, i) => {
      if (!area.points || area.points.length < 3) return;
      ctx.beginPath();
      area.points.forEach((p, idx) => {
        const s = this.project(p.lat, p.lng);
        if (idx === 0) ctx.moveTo(s.x, s.y);
        else ctx.lineTo(s.x, s.y);
      });
      ctx.closePath();
      ctx.fillStyle = colors[i % colors.length];
      ctx.fill();
    });
  }

  _flux(ctx) {
    const flux = this.flux;
    if (!flux?.rgba) return;
    if (!this.fluxCanvas) {
      const off = document.createElement('canvas');
      off.width = flux.width;
      off.height = flux.height;
      off.getContext('2d').putImageData(new ImageData(flux.rgba, flux.width, flux.height), 0, 0);
      this.fluxCanvas = off;
    }
    const nw = this.project(flux.north, flux.west);
    const se = this.project(flux.south, flux.east);
    ctx.save();
    ctx.globalAlpha = 0.85;
    ctx.drawImage(this.fluxCanvas, nw.x, nw.y, se.x - nw.x, se.y - nw.y);
    ctx.restore();
  }

  _stops(ctx) {
    const clustered = this.mpp > 8 && this.stops.length > 40;
    if (clustered) {
      const bins = new Map();
      for (const stop of this.stops) {
        if (stop.lat == null) continue;
        const s = this.project(stop.lat, stop.lng);
        const key = `${Math.round(s.x / 36)}:${Math.round(s.y / 36)}`;
        const bin = bins.get(key) || { x: 0, y: 0, n: 0 };
        bin.x += s.x;
        bin.y += s.y;
        bin.n += 1;
        bins.set(key, bin);
      }
      for (const bin of bins.values()) {
        const x = bin.x / bin.n;
        const y = bin.y / bin.n;
        ctx.beginPath();
        ctx.fillStyle = '#1a73e8';
        ctx.arc(x, y, 16, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#fff';
        ctx.font = '700 12px Segoe UI, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(String(bin.n), x, y);
      }
      return;
    }
    for (const stop of this.stops) {
      if (stop.lat == null) continue;
      const s = this.project(stop.lat, stop.lng);
      const flagged = stop.status === 'flag';
      const done = Boolean(stop.disposition);
      ctx.beginPath();
      ctx.fillStyle = '#fff';
      ctx.arc(s.x, s.y, stop.id === this.selectedId ? 9 : 7, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.fillStyle = flagged ? '#e37400' : done ? '#9aa0a6' : '#1a73e8';
      ctx.arc(s.x, s.y, stop.id === this.selectedId ? 6.5 : 4.5, 0, Math.PI * 2);
      ctx.fill();
      if (this.mode === 'satellite') {
        ctx.strokeStyle = 'rgba(255,255,255,.35)';
        ctx.strokeRect(s.x + 6, s.y - 8, 10, 8);
      }
    }
  }

  _parks(ctx) {
    this.parks.forEach((park, i) => {
      const s = this.project(park.lat, park.lng);
      ctx.beginPath();
      ctx.fillStyle = '#174ea6';
      ctx.arc(s.x, s.y, 12, 0, Math.PI * 2);
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#fff';
      ctx.stroke();
      ctx.fillStyle = '#fff';
      ctx.font = '700 11px Segoe UI, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(i + 1), s.x, s.y + 0.5);
    });
  }

  _me(ctx) {
    const s = this.project(this.me.lat, this.me.lng);
    ctx.beginPath();
    ctx.fillStyle = 'rgba(52,168,83,.25)';
    ctx.arc(s.x, s.y, 16, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.fillStyle = '#188038';
    ctx.arc(s.x, s.y, 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.stroke();
  }
}
