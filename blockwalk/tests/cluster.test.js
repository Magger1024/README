import assert from 'node:assert/strict';
import test from 'node:test';
import { clusterStops, serviceSeconds } from '../js/cluster.js';
import { unprojectLocal } from '../js/geo.js';

const O = { lat: 39.2, lng: -76.8 };

function at(id, x, y) {
  return { id, ...unprojectLocal(x, y, O.lat, O.lng) };
}

function serpentine(ids, pos) {
  const seq = ids.map((id) => pos.get(id));
  const mid = Math.ceil(seq.length / 2);
  const first = seq.slice(0, mid);
  const second = seq.slice(mid);
  const mono = (arr, dir) => arr.every((p, i) => i === 0 || (p.x - arr[i - 1].x) * dir >= -0.1);
  const firstDir = first.length > 1 && first[1].x < first[0].x ? -1 : 1;
  const secondDir = firstDir * -1;
  assert.ok(mono(first, firstDir), 'first side walks one direction');
  if (second.length > 1) assert.ok(mono(second, secondDir), 'other side walks back');
  const sideA = new Set(first.map((p) => Math.sign(p.y)));
  if (second.length) {
    const sideB = new Set(second.map((p) => Math.sign(p.y)));
    assert.equal(sideA.size, 1);
    assert.equal(sideB.size, 1);
    assert.notEqual([...sideA][0], [...sideB][0]);
  }
}

test('one street, both sides, is a single park-and-walk block', () => {
  const stops = [];
  const pos = new Map();
  let n = 0;
  for (let i = 0; i < 6; i++) {
    for (const y of [12, -12]) {
      const id = `h${n++}`;
      const stop = at(id, i * 24, y);
      stops.push(stop);
      pos.set(id, { x: i * 24, y });
    }
  }
  // Put the across-the-street neighbor first in id order so a nearest-only
  // grow would start a vertical pair. Support along the street must win.
  stops.sort((a, b) => (a.id < b.id ? -1 : 1));
  const clusters = clusterStops(stops, { walkMeters: 150, streetWidthMeters: 60, maxSpanMeters: 280 });
  assert.equal(clusters.length, 1);
  assert.equal(clusters[0].stopIds.length, 12);
  assert.equal(clusters[0].sideOfRoad, true);
  serpentine(clusters[0].stopIds, pos);
  const park = clusters[0].park;
  const mid = unprojectLocal(24 * 2.5, 0, O.lat, O.lng);
  const dx = (park.lng - mid.lng) * 111320 * Math.cos(O.lat * Math.PI / 180);
  const dy = (park.lat - mid.lat) * 111320;
  assert.ok(Math.hypot(dx, dy) < 20, `park should sit near the middle, was ${Math.hypot(dx, dy).toFixed(1)} m`);
});

test('parallel streets stay separate parks', () => {
  const stops = [];
  for (const y of [0, 110]) {
    for (let i = 0; i < 5; i++) {
      stops.push(at(`${y}-${i}a`, i * 22, y + 12));
      stops.push(at(`${y}-${i}b`, i * 22, y - 12));
    }
  }
  const clusters = clusterStops(stops);
  assert.equal(clusters.length, 2);
  for (const c of clusters) {
    const ys = new Set(c.stopIds.map((id) => id.split('-')[0]));
    assert.equal(ys.size, 1);
  }
});

test('a long street splits once the block is longer than the walk span', () => {
  const stops = [];
  for (let i = 0; i < 30; i++) stops.push(at(`l${i}`, i * 25, 0));
  const clusters = clusterStops(stops, { walkMeters: 150, maxSpanMeters: 280, maxDoors: 40 });
  assert.ok(clusters.length >= 3);
  for (const c of clusters) assert.ok(c.spanMeters <= 280 + 1);
  const ids = clusters.flatMap((c) => c.stopIds).sort();
  assert.deepEqual(ids, stops.map((s) => s.id).sort());
});

test('doors far apart are their own parks', () => {
  const stops = [at('a', 0, 0), at('b', 400, 0), at('c', 0, 400)];
  const clusters = clusterStops(stops, { walkMeters: 150 });
  assert.equal(clusters.length, 3);
  assert.equal(clusters.find((c) => c.stopIds[0] === 'a').sideOfRoad, false);
});

test('service time is doors times minutes plus the walk', () => {
  const stops = [at('a', 0, 0), at('b', 30, 0), at('c', 60, 0)];
  const [cluster] = clusterStops(stops, { walkMeters: 150, maxDoors: 10 });
  const seconds = serviceSeconds(cluster, 3, 1.25);
  assert.ok(Math.abs(seconds - (3 * 3 * 60 + cluster.walkMeters / 1.25)) < 1e-6);
  assert.ok(seconds > 540);
});

test('clustering is deterministic', () => {
  const stops = [];
  for (let y = 0; y < 3; y++) {
    for (let x = 0; x < 4; x++) stops.push(at(`p${y}-${x}`, x * 20, y * 120 + (x % 2 ? 10 : -10)));
  }
  const a = clusterStops(stops).map((c) => c.stopIds.join(','));
  const b = clusterStops(stops.slice().reverse()).map((c) => c.stopIds.join(','));
  assert.deepEqual(a, b);
});
