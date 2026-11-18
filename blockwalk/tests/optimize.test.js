import assert from 'node:assert/strict';
import test from 'node:test';
import { optimizeLocal, nearestNeighborOrder, planarLength, segmentMoveDelta, twoOptDelta } from '../js/optimize.js';
import { unprojectLocal, equirectMeters } from '../js/geo.js';
import { syntheticStops } from '../js/synthetic.js';

const O = { lat: 39.2, lng: -76.8 };
const at = (id, x, y, extra = {}) => ({ id, ...unprojectLocal(x, y, O.lat, O.lng), ...extra });

function lengthOf(ids, points, start, end) {
  const byId = new Map(points.map((p) => [p.id, p]));
  return planarLength(ids, byId, start, end);
}

test('open route on a line is sorted from start toward the end', () => {
  const points = [0, 100, 200, 300].map((x, i) => at(String.fromCharCode(65 + i), x, 0));
  const start = unprojectLocal(-40, 0, O.lat, O.lng);
  const end = unprojectLocal(360, 0, O.lat, O.lng);
  const solved = optimizeLocal({ points, start, end });
  assert.deepEqual(solved.order, ['A', 'B', 'C', 'D']);
  assert.equal(solved.order[0] !== 'D', true);
});

test('square loop does not cross and beats a crossing order', () => {
  const points = [at('A', 0, 0), at('B', 0, 200), at('C', 200, 200), at('D', 200, 0)];
  const start = unprojectLocal(-30, -30, O.lat, O.lng);
  const solved = optimizeLocal({ points, start, end: start });
  const crossing = lengthOf(['A', 'C', 'B', 'D'], points, start, start);
  const got = lengthOf(solved.order, points, start, start);
  assert.ok(got < crossing - 1);
  assert.equal(new Set(solved.order).size, 4);
});

test('local solver is never worse than nearest neighbor', () => {
  const points = syntheticStops(40, 2).map((s) => ({ id: s.id, lat: s.lat, lng: s.lng }));
  const start = unprojectLocal(-80, -40, O.lat, O.lng);
  const end = unprojectLocal(80, 400, O.lat, O.lng);
  const solved = optimizeLocal({ points, start, end });
  const nn = nearestNeighborOrder(points, start);
  const got = lengthOf(solved.order, points, start, end);
  const base = lengthOf(nn, points, start, end);
  assert.ok(got <= base + 1e-6, `solver ${got} should be <= NN ${base}`);
});

test('knocked stops stay a locked prefix and skipped stops are omitted', () => {
  const points = [
    at('P1', 0, 0, { knocked: true }),
    at('P2', 40, 0, { knocked: true }),
    at('F1', 200, 40),
    at('F2', 80, 20),
    at('S', 10, 10, { skipped: true }),
  ];
  const start = unprojectLocal(-20, 0, O.lat, O.lng);
  const end = unprojectLocal(260, 0, O.lat, O.lng);
  const solved = optimizeLocal({ points, start, end });
  assert.deepEqual(solved.order.slice(0, 2), ['P1', 'P2']);
  assert.equal(solved.order.includes('S'), false);
  assert.equal(solved.order.length, 4);
});

test('locked stops keep their relative order', () => {
  const points = [
    at('L1', 0, 0, { locked: true }),
    at('F', 100, 80),
    at('L2', 220, 0, { locked: true }),
  ];
  const start = unprojectLocal(-40, 0, O.lat, O.lng);
  const end = unprojectLocal(300, 0, O.lat, O.lng);
  const solved = optimizeLocal({ points, start, end });
  assert.ok(solved.order.indexOf('L1') < solved.order.indexOf('L2'));
  assert.equal(solved.order.length, 3);
});

test('start and end are fixed even when they are not stops', () => {
  const points = [at('A', 0, 0), at('B', 50, 40)];
  const start = unprojectLocal(-100, -50, O.lat, O.lng);
  const end = unprojectLocal(180, -20, O.lat, O.lng);
  const solved = optimizeLocal({ points, start, end });
  assert.deepEqual(solved.order, ['A', 'B']);
  assert.ok(solved.geodesicMeters > 0);
});

test('segment-move and 2-opt deltas match a full recompute', () => {
  const raw = [at('a', 0, 0), at('b', 40, 10), at('c', 70, -20), at('d', 20, 50), at('e', 90, 30)];
  const start = unprojectLocal(-30, -10, O.lat, O.lng);
  const end = unprojectLocal(120, 10, O.lat, O.lng);
  const cos = Math.cos(O.lat * Math.PI / 180);
  const dist = (a, b) => equirectMeters(a, b, cos);
  const cost = (nodes) => {
    let c = dist(start, nodes[0] || end);
    for (let i = 1; i < nodes.length; i++) c += dist(nodes[i - 1], nodes[i]);
    if (nodes.length) c += dist(nodes[nodes.length - 1], end);
    else c = dist(start, end);
    return c;
  };
  for (let a = 0; a < raw.length; a++) {
    for (let len = 1; len <= 3 && a + len <= raw.length; len++) {
      const remain = raw.length - len;
      for (let k = 0; k <= remain; k++) {
        const before = cost(raw);
        const delta = segmentMoveDelta(raw, a, len, k, start, end, dist);
        const moved = raw.slice();
        const seg = moved.splice(a, len);
        moved.splice(k, 0, ...seg);
        const after = cost(moved);
        assert.ok(Math.abs(after - before - delta) < 1e-6, `or-opt delta off by ${after - before - delta}`);
      }
    }
  }
  for (let a = 0; a < raw.length - 1; a++) {
    for (let b = a + 1; b < raw.length; b++) {
      const before = cost(raw);
      const delta = twoOptDelta(raw, a, b, start, end, dist);
      const rev = raw.slice();
      let i = a;
      let j = b;
      while (i < j) {
        const tmp = rev[i];
        rev[i] = rev[j];
        rev[j] = tmp;
        i += 1;
        j -= 1;
      }
      assert.ok(Math.abs(cost(rev) - before - delta) < 1e-6);
    }
  }
});
