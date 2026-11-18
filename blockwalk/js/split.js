/**
 * Split a list into day-sized geographic areas so each day is a tight
 * territory. Capacitated k-means, deterministic given the same input order.
 */

import { projectLocal, centroidLatLng } from './geo.js';

function projectAll(stops) {
  const origin = stops.length ? centroidLatLng(stops) : { lat: 0, lng: 0 };
  return stops.map((s) => ({
    id: s.id,
    ...projectLocal(s.lat, s.lng, origin.lat, origin.lng),
  }));
}

/**
 * @returns {{index:number, stopIds:string[]}[]} days ordered west to east
 */
export function splitIntoDays(stops, doorsPerDay) {
  const cap = Math.max(1, Math.round(Number(doorsPerDay) || 1));
  if (!stops || !stops.length) return [];
  if (stops.length <= cap) return [{ index: 0, stopIds: stops.map((s) => s.id) }];

  const k = Math.ceil(stops.length / cap);
  const pts = projectAll(stops);
  const order = pts
    .map((p, i) => ({ i, x: p.x, y: p.y, id: p.id }))
    .sort((a, b) => a.x - b.x || a.y - b.y || (a.id < b.id ? -1 : 1));

  let centroids = [];
  for (let c = 0; c < k; c++) {
    const pick = order[Math.min(order.length - 1, Math.floor((c + 0.5) * order.length / k))];
    centroids.push({ x: pick.x, y: pick.y });
  }

  let assign = new Array(pts.length).fill(0);
  for (let iter = 0; iter < 16; iter++) {
    const strength = pts.map((p, i) => {
      const ds = centroids.map((c) => Math.hypot(p.x - c.x, p.y - c.y));
      const ranked = ds.map((d, ci) => ({ ci, d })).sort((a, b) => a.d - b.d || a.ci - b.ci);
      const gap = ranked.length > 1 ? ranked[1].d - ranked[0].d : ranked[0].d;
      return { i, gap, ranked };
    });
    strength.sort((a, b) => b.gap - a.gap || a.i - b.i);
    const counts = new Array(k).fill(0);
    const next = new Array(pts.length).fill(0);
    for (const item of strength) {
      let placed = false;
      for (const r of item.ranked) {
        if (counts[r.ci] < cap) {
          next[item.i] = r.ci;
          counts[r.ci] += 1;
          placed = true;
          break;
        }
      }
      if (!placed) {
        let ci = 0;
        for (let c = 1; c < k; c++) if (counts[c] < counts[ci]) ci = c;
        next[item.i] = ci;
        counts[ci] += 1;
      }
    }
    const same = next.every((v, i) => v === assign[i]);
    assign = next;
    const sums = Array.from({ length: k }, () => ({ x: 0, y: 0, n: 0 }));
    pts.forEach((p, i) => {
      const s = sums[assign[i]];
      s.x += p.x;
      s.y += p.y;
      s.n += 1;
    });
    centroids = sums.map((s, ci) => (s.n ? { x: s.x / s.n, y: s.y / s.n } : centroids[ci]));
    if (same) break;
  }

  const groups = Array.from({ length: k }, () => []);
  pts.forEach((p, i) => groups[assign[i]].push(p));
  const meta = groups.map((g, i) => {
    let x = 0;
    let y = 0;
    for (const p of g) {
      x += p.x;
      y += p.y;
    }
    const n = g.length || 1;
    return { i, x: x / n, y: y / n, ids: g.map((p) => p.id) };
  });
  meta.sort((a, b) => a.x - b.x || a.y - b.y);
  return meta
    .filter((g) => g.ids.length)
    .map((g, index) => ({ index, stopIds: g.ids.slice().sort() }));
}

/** Drop finished stops and split what is left into new day areas. */
export function rollForward(days, doneIds, doorsPerDay, stopsById) {
  const done = doneIds instanceof Set ? doneIds : new Set(doneIds);
  const remaining = [];
  const seen = new Set();
  for (const day of days || []) {
    for (const id of day.stopIds || []) {
      if (done.has(id) || seen.has(id)) continue;
      const stop = stopsById.get(id);
      if (stop) {
        seen.add(id);
        remaining.push(stop);
      }
    }
  }
  return splitIntoDays(remaining, doorsPerDay);
}
