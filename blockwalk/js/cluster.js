/**
 * Park-and-walk clustering.
 * Doors on the same street, within a short walk, become one parking spot.
 * Walk order is one side of the street, then back along the other.
 */

import { centroidLatLng, projectLocal, stableId, unprojectLocal } from './geo.js';

const DEFAULTS = {
  walkMeters: 150,
  streetWidthMeters: 60,
  maxSpanMeters: 280,
  maxDoors: 16,
};

function principalAxis(members) {
  let mx = 0;
  let my = 0;
  for (const p of members) {
    mx += p.x;
    my += p.y;
  }
  mx /= members.length;
  my /= members.length;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (const p of members) {
    const dx = p.x - mx;
    const dy = p.y - my;
    sxx += dx * dx;
    syy += dy * dy;
    sxy += dx * dy;
  }
  const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  return {
    mx,
    my,
    ux: Math.cos(theta),
    uy: Math.sin(theta),
    vx: -Math.sin(theta),
    vy: Math.cos(theta),
  };
}

function lineSupport(seed, candidate, pts, halfWidth, maxSpan) {
  const dx = candidate.x - seed.x;
  const dy = candidate.y - seed.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const vx = -uy;
  const vy = ux;
  let n = 0;
  for (const p of pts) {
    const along = (p.x - seed.x) * ux + (p.y - seed.y) * uy;
    const perp = Math.abs((p.x - seed.x) * vx + (p.y - seed.y) * vy);
    if (perp <= halfWidth && along >= -8 && along <= maxSpan) n += 1;
  }
  return n;
}

function walkOrder(members) {
  if (members.length <= 2) return members.slice();
  const axis = principalAxis(members);
  const scored = members.map((p) => {
    const dx = p.x - axis.mx;
    const dy = p.y - axis.my;
    return {
      p,
      along: dx * axis.ux + dy * axis.uy,
      side: dx * axis.vx + dy * axis.vy,
    };
  });
  const width = Math.max(...scored.map((s) => s.side)) - Math.min(...scored.map((s) => s.side));
  if (width < 8) {
    scored.sort((a, b) => a.along - b.along);
    return scored.map((s) => s.p);
  }
  const neg = scored.filter((s) => s.side < 0).sort((a, b) => a.along - b.along);
  const pos = scored.filter((s) => s.side >= 0).sort((a, b) => b.along - a.along);
  return [...neg, ...pos].map((s) => s.p);
}

function bearingDeg(ux, uy) {
  const deg = (Math.atan2(ux, uy) * 180) / Math.PI;
  const b = (deg + 360) % 360;
  return b >= 359.5 ? 0 : Math.round(b);
}

function finishCluster(members, origin) {
  const ordered = walkOrder(members);
  const axis = members.length >= 2 ? principalAxis(members) : null;
  let px = 0;
  let py = 0;
  for (const m of members) {
    px += m.x;
    py += m.y;
  }
  px /= members.length;
  py /= members.length;
  if (axis && members.length >= 2) {
    px += axis.vx * 8;
    py += axis.vy * 8;
  }
  const park = unprojectLocal(px, py, origin.lat, origin.lng);
  let walkMeters = 0;
  for (let i = 1; i < ordered.length; i++) {
    walkMeters += Math.hypot(ordered[i].x - ordered[i - 1].x, ordered[i].y - ordered[i - 1].y);
  }
  let span = 0;
  if (axis) {
    const along = members.map((m) => (m.x - axis.mx) * axis.ux + (m.y - axis.my) * axis.uy);
    span = Math.max(...along) - Math.min(...along);
  }
  const ids = ordered.map((m) => m.id);
  return {
    id: stableId('park-', ids),
    stopIds: ids,
    park: { lat: park.lat, lng: park.lng },
    sideOfRoad: members.length >= 2,
    heading: axis ? bearingDeg(axis.ux, axis.uy) : null,
    walkMeters,
    spanMeters: span,
    doorCount: members.length,
  };
}

/**
 * @param {{id:string,lat:number,lng:number}[]} stops
 * @returns {Array} clusters in walk order, parks near the middle of each block
 */
export function clusterStops(stops, options = {}) {
  const walkMeters = options.walkMeters ?? DEFAULTS.walkMeters;
  const halfWidth = (options.streetWidthMeters ?? DEFAULTS.streetWidthMeters) / 2;
  const maxSpanMeters = options.maxSpanMeters ?? DEFAULTS.maxSpanMeters;
  const maxDoors = options.maxDoors ?? DEFAULTS.maxDoors;
  if (!stops || !stops.length) return [];
  const origin = centroidLatLng(stops);
  const pts = stops.map((s) => ({
    id: s.id,
    ...projectLocal(s.lat, s.lng, origin.lat, origin.lng),
  }));
  pts.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const used = new Set();
  const clusters = [];

  for (const seed of pts) {
    if (used.has(seed.id)) continue;
    const members = [seed];
    used.add(seed.id);

    if (pts.length > 1) {
      let best = null;
      let bestSupport = -1;
      let bestD = Infinity;
      for (const p of pts) {
        if (used.has(p.id)) continue;
        const d = Math.hypot(p.x - seed.x, p.y - seed.y);
        if (d < 0.5 || d > walkMeters) continue;
        const support = lineSupport(seed, p, pts, halfWidth, maxSpanMeters);
        // Nearest door wins. Line support only breaks a near-tie, so a diagonal
        // across several parallel streets cannot outvote the next house.
        const clearlyNearer = best && d < bestD * 0.85;
        const nearTie = !best || d <= bestD * 1.15;
        if (!best || clearlyNearer || (nearTie && (support > bestSupport || (support === bestSupport && d < bestD)))) {
          best = p;
          bestSupport = support;
          bestD = d;
        }
      }
      if (best) {
        members.push(best);
        used.add(best.id);
      }
    }

    while (members.length < maxDoors) {
      const axis = principalAxis(members);
      let best = null;
      let bestD = Infinity;
      for (const p of pts) {
        if (used.has(p.id)) continue;
        let dmin = Infinity;
        for (const m of members) {
          const d = Math.hypot(p.x - m.x, p.y - m.y);
          if (d < dmin) dmin = d;
        }
        if (dmin > walkMeters || dmin >= bestD) continue;
        const perp = Math.abs((p.x - axis.mx) * axis.vx + (p.y - axis.my) * axis.vy);
        if (perp > halfWidth) continue;
        let minA = Infinity;
        let maxA = -Infinity;
        const alongOf = (q) => (q.x - axis.mx) * axis.ux + (q.y - axis.my) * axis.uy;
        const a0 = alongOf(p);
        minA = a0;
        maxA = a0;
        for (const m of members) {
          const a = alongOf(m);
          if (a < minA) minA = a;
          if (a > maxA) maxA = a;
        }
        if (maxA - minA > maxSpanMeters) continue;
        best = p;
        bestD = dmin;
      }
      if (!best) break;
      members.push(best);
      used.add(best.id);
    }
    clusters.push(finishCluster(members, origin));
  }

  clusters.sort((a, b) => a.park.lng - b.park.lng || a.park.lat - b.park.lat || (a.id < b.id ? -1 : 1));
  return clusters;
}

export function walkSeconds(cluster, metersPerSecond = 1.25) {
  return (cluster.walkMeters || 0) / metersPerSecond;
}

/** Service time parked at the curb: knocking time plus the walk between those doors. */
export function serviceSeconds(cluster, minutesPerDoor, metersPerSecond = 1.25) {
  const doors = cluster.doorCount ?? cluster.stopIds.length;
  const knock = Math.max(0, minutesPerDoor) * 60 * doors;
  return knock + walkSeconds(cluster, metersPerSecond);
}
