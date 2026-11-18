/**
 * Synthetic park-and-walk benchmark. No real addresses.
 * Reports geodesic route length and runtime for 50, 200, 500, and 1,000 stops.
 * Exits 1 if the local solver is worse than nearest neighbor on any size.
 */

import { syntheticStops } from '../js/synthetic.js';
import { clusterStops } from '../js/cluster.js';
import { optimizeLocal, nearestNeighborOrder, planarLength } from '../js/optimize.js';
import { unprojectLocal, haversineMeters } from '../js/geo.js';

const ORIGIN = { lat: 39.2, lng: -76.8 };
const SIZES = [50, 200, 500, 1000];

function km(meters) {
  return (meters / 1000).toFixed(2);
}

function geodesic(ids, byId, start, end) {
  let m = 0;
  let prev = start;
  for (const id of ids) {
    const p = byId.get(id);
    m += haversineMeters(prev, p);
    prev = p;
  }
  m += haversineMeters(prev, end);
  return m;
}

function runSize(n) {
  const stops = syntheticStops(n, 7);
  const start = unprojectLocal(-60, -40, ORIGIN.lat, ORIGIN.lng);
  const end = { ...start };

  const c0 = performance.now();
  const clusters = clusterStops(stops);
  const clusterMs = performance.now() - c0;
  const parks = clusters.map((c) => ({ id: c.id, lat: c.park.lat, lng: c.park.lng }));

  const o0 = performance.now();
  const parkSolve = optimizeLocal({ points: parks, start, end });
  const parkMs = performance.now() - o0;

  const s0 = performance.now();
  const stopSolve = optimizeLocal({
    points: stops.map((s) => ({ id: s.id, lat: s.lat, lng: s.lng })),
    start,
    end,
  });
  const stopMs = performance.now() - s0;

  const byPark = new Map(parks.map((p) => [p.id, p]));
  const byStop = new Map(stops.map((s) => [s.id, s]));
  const nn = nearestNeighborOrder(stops.map((s) => ({ id: s.id, lat: s.lat, lng: s.lng })), start);
  const solvedPlanar = planarLength(stopSolve.order, byStop, start, end);
  const nnPlanar = planarLength(nn, byStop, start, end);
  return {
    n,
    clusters: clusters.length,
    clusterMs,
    parkKm: Number(km(geodesic(parkSolve.order, byPark, start, end))),
    parkMs,
    stopKm: Number(km(geodesic(stopSolve.order, byStop, start, end))),
    stopMs,
    nnKm: Number(km(geodesic(nn, byStop, start, end))),
    improved: solvedPlanar <= nnPlanar + 1e-4,
    gainPct: nnPlanar > 0 ? (100 * (nnPlanar - solvedPlanar)) / nnPlanar : 0,
  };
}

const rows = SIZES.map(runSize);
const header = 'stops  parks  cluster_ms  park_route_km  park_ms  stop_route_km  stop_ms  nn_km  vs_nn';
console.log(header);
for (const r of rows) {
  console.log(
    [
      String(r.n).padStart(5),
      String(r.clusters).padStart(5),
      r.clusterMs.toFixed(0).padStart(10),
      r.parkKm.toFixed(2).padStart(13),
      r.parkMs.toFixed(0).padStart(7),
      r.stopKm.toFixed(2).padStart(13),
      r.stopMs.toFixed(0).padStart(7),
      r.nnKm.toFixed(2).padStart(7),
      `${r.gainPct.toFixed(1)}%`.padStart(7),
    ].join('  '),
  );
}
const worse = rows.filter((r) => !r.improved);
if (worse.length) {
  console.error('Solver was worse than nearest neighbor:', worse.map((r) => r.n).join(', '));
  process.exit(1);
}
