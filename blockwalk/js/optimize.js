/**
 * On-phone optimizer used in demo mode and whenever Google Route Optimization
 * is unreachable. Fixed start and end. Nearest-neighbor and farthest-insertion
 * construction, then 2-opt and Or-opt. Knocked stops stay a locked prefix.
 * Locked stops keep their relative order.
 */

import { equirectMeters, haversineMeters, meanLatitude } from './geo.js';

function routeCost(nodes, start, end, dist) {
  let c = 0;
  let prev = start;
  for (const node of nodes) {
    c += dist(prev, node);
    prev = node;
  }
  c += dist(prev, end);
  return c;
}

function hasLocked(nodes, a, b, locked) {
  if (!locked || locked.size === 0) return false;
  for (let i = a; i <= b; i++) if (locked.has(nodes[i].id)) return true;
  return false;
}

function gapEnds(nodes, a, len, k, start, end) {
  const remain = nodes.length - len;
  const at = (i) => (i < a ? nodes[i] : nodes[i + len]);
  const left = k === 0 ? start : at(k - 1);
  const right = k === remain ? end : at(k);
  return { left, right };
}

/** Cost change for lifting nodes[a, a+len) and reinserting at gap k of the shortened route. */
export function segmentMoveDelta(nodes, a, len, k, start, end, dist) {
  const n = nodes.length;
  const A = a === 0 ? start : nodes[a - 1];
  const B = nodes[a];
  const C = nodes[a + len - 1];
  const D = a + len >= n ? end : nodes[a + len];
  const { left, right } = gapEnds(nodes, a, len, k, start, end);
  return -dist(A, B) - dist(C, D) + dist(A, D) - dist(left, right) + dist(left, B) + dist(C, right);
}

export function twoOptDelta(nodes, a, b, start, end, dist) {
  const n = nodes.length;
  const A = a === 0 ? start : nodes[a - 1];
  const B = nodes[a];
  const C = nodes[b];
  const D = b === n - 1 ? end : nodes[b + 1];
  return -dist(A, B) - dist(C, D) + dist(A, C) + dist(B, D);
}

function reverseRange(nodes, a, b) {
  while (a < b) {
    const tmp = nodes[a];
    nodes[a] = nodes[b];
    nodes[b] = tmp;
    a += 1;
    b -= 1;
  }
}

function applySegmentMove(nodes, a, len, k) {
  const seg = nodes.splice(a, len);
  nodes.splice(k, 0, ...seg);
}

function insertBest(skeleton, point, start, end, dist) {
  let bestI = skeleton.length;
  let bestD = Infinity;
  for (let i = 0; i <= skeleton.length; i++) {
    const prev = i === 0 ? start : skeleton[i - 1];
    const next = i === skeleton.length ? end : skeleton[i];
    const delta = dist(prev, point) + dist(point, next) - dist(prev, next);
    if (delta < bestD) {
      bestD = delta;
      bestI = i;
    }
  }
  const next = skeleton.slice();
  next.splice(bestI, 0, point);
  return next;
}

function buildInsertion(rest, start, end, dist, farthest) {
  const locked = rest.filter((p) => p.locked);
  const free = rest.filter((p) => !p.locked);
  if (!free.length) return locked.slice();
  let lat = 0;
  let lng = 0;
  for (const p of rest) {
    lat += p.lat;
    lng += p.lng;
  }
  const center = { lat: lat / rest.length, lng: lng / rest.length };
  free.sort((a, b) => {
    const da = farthest ? dist(b, center) - dist(a, center) : dist(a, start) - dist(b, start);
    return da || (a.id < b.id ? -1 : 1);
  });
  let route = locked.slice();
  for (const p of free) route = insertBest(route, p, start, end, dist);
  return route;
}

function nearestNeighbor(rest, start, dist) {
  const left = rest.slice();
  const route = [];
  let cur = start;
  while (left.length) {
    let bi = 0;
    let bd = Infinity;
    for (let i = 0; i < left.length; i++) {
      const d = dist(cur, left[i]);
      if (d < bd || (d === bd && left[i].id < left[bi].id)) {
        bd = d;
        bi = i;
      }
    }
    cur = left.splice(bi, 1)[0];
    route.push(cur);
  }
  return route;
}

function twoOptPass(nodes, start, end, dist, locked) {
  const n = nodes.length;
  let best = null;
  const candidate = n > 280;
  for (let a = 0; a < n - 1; a++) {
    const bLimit = candidate ? Math.min(n - 1, a + 40) : n - 1;
    for (let b = a + 1; b <= bLimit; b++) {
      if (hasLocked(nodes, a, b, locked)) continue;
      const delta = twoOptDelta(nodes, a, b, start, end, dist);
      if (delta < -1e-4 && (!best || delta < best.delta)) best = { a, b, delta };
    }
  }
  if (!best) return false;
  reverseRange(nodes, best.a, best.b);
  return true;
}

function orOptPass(nodes, start, end, dist, locked) {
  const n = nodes.length;
  const maxLen = n > 280 ? 1 : 3;
  let best = null;
  for (let len = 1; len <= maxLen; len++) {
    for (let a = 0; a + len <= n; a++) {
      if (hasLocked(nodes, a, a + len - 1, locked)) continue;
      const remain = n - len;
      for (let k = 0; k <= remain; k++) {
        if (k === a) continue;
        const delta = segmentMoveDelta(nodes, a, len, k, start, end, dist);
        if (delta < -1e-4 && (!best || delta < best.delta)) best = { a, len, k, delta };
      }
    }
  }
  if (!best) return false;
  applySegmentMove(nodes, best.a, best.len, best.k);
  return true;
}

function localSearch(nodes, start, end, dist, locked) {
  const limit = nodes.length > 280 ? 8 : 24;
  for (let pass = 0; pass < limit; pass++) {
    const before = routeCost(nodes, start, end, dist);
    twoOptPass(nodes, start, end, dist, locked);
    orOptPass(nodes, start, end, dist, locked);
    const after = routeCost(nodes, start, end, dist);
    if (before - after < 0.05) break;
  }
  return nodes;
}

function geodesicMeters(nodes, start, end) {
  let c = 0;
  let prev = start;
  for (const node of nodes) {
    c += haversineMeters(prev, node);
    prev = node;
  }
  c += haversineMeters(prev, end);
  return c;
}

/**
 * @param {{points: object[], start: {lat:number,lng:number}, end?: {lat:number,lng:number}}} input
 * points may set knocked (fixed prefix, kept in input order) or locked (relative order preserved).
 */
export function optimizeLocal(input) {
  const start = input.start;
  const end = input.end || input.start;
  if (!start || start.lat == null || start.lng == null) throw new Error('A start location is required.');
  const raw = (input.points || []).filter((p) => p && !p.skipped && p.lat != null && p.lng != null);
  const seen = new Set();
  for (const p of raw) {
    if (seen.has(p.id)) throw new Error(`Duplicate stop ${p.id}`);
    seen.add(p.id);
  }
  const prefix = raw.filter((p) => p.knocked);
  const rest = raw.filter((p) => !p.knocked);
  const ref = meanLatitude([start, end, ...rest]);
  const cos = Math.cos((ref * Math.PI) / 180);
  const dist = (a, b) => equirectMeters(a, b, cos);
  const locked = new Set(rest.filter((p) => p.locked).map((p) => p.id));

  if (!rest.length) {
    return {
      order: prefix.map((p) => p.id),
      geodesicMeters: geodesicMeters([], start, end),
      planarMeters: routeCost([], start, end, dist),
      engine: 'local',
    };
  }

  const seeds = [
    buildInsertion(rest, start, end, dist, true),
    buildInsertion(rest, start, end, dist, false),
  ];
  if (locked.size === 0) seeds.push(nearestNeighbor(rest, start, dist));

  let best = null;
  let bestCost = Infinity;
  for (const seed of seeds) {
    const improved = localSearch(seed.map((p) => p), start, end, dist, locked);
    const cost = routeCost(improved, start, end, dist);
    if (cost < bestCost) {
      bestCost = cost;
      best = improved;
    }
  }

  const order = [...prefix.map((p) => p.id), ...best.map((p) => p.id)];
  return {
    order,
    geodesicMeters: geodesicMeters([...prefix, ...best], start, end),
    planarMeters: routeCost([...prefix, ...best], start, end, dist),
    engine: 'local',
  };
}

/** Classic nearest neighbor, ignoring the fixed end. Baseline for the benchmark. */
export function nearestNeighborOrder(points, start) {
  const ref = meanLatitude([start, ...points]);
  const cos = Math.cos((ref * Math.PI) / 180);
  const dist = (a, b) => equirectMeters(a, b, cos);
  return nearestNeighbor(points, start, dist).map((p) => p.id);
}

export function planarLength(ids, byId, start, end) {
  const nodes = ids.map((id) => byId.get(id));
  const ref = meanLatitude([start, end, ...nodes]);
  const cos = Math.cos((ref * Math.PI) / 180);
  const dist = (a, b) => equirectMeters(a, b, cos);
  return routeCost(nodes, start, end, dist);
}
