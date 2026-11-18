import assert from 'node:assert/strict';
import test from 'node:test';
import { splitIntoDays, rollForward } from '../js/split.js';
import { unprojectLocal } from '../js/geo.js';

const O = { lat: 39.2, lng: -76.8 };

function blob(prefix, count, x0, y0) {
  const stops = [];
  for (let i = 0; i < count; i++) {
    const ll = unprojectLocal(x0 + (i % 5) * 18, y0 + Math.floor(i / 5) * 18, O.lat, O.lng);
    stops.push({ id: `${prefix}${i}`, lat: ll.lat, lng: ll.lng });
  }
  return stops;
}

test('a list that fits in one day is not split', () => {
  const stops = blob('a', 10, 0, 0);
  const days = splitIntoDays(stops, 150);
  assert.equal(days.length, 1);
  assert.equal(days[0].stopIds.length, 10);
});

test('two distant blobs become two day areas', () => {
  const west = blob('w', 20, 0, 0);
  const east = blob('e', 20, 8000, 200);
  const days = splitIntoDays([...west, ...east], 20);
  assert.equal(days.length, 2);
  for (const day of days) assert.ok(day.stopIds.length <= 20);
  const flat = days.flatMap((d) => d.stopIds).sort();
  assert.equal(flat.length, 40);
  assert.equal(new Set(flat).size, 40);
  for (const day of days) {
    const w = day.stopIds.filter((id) => id.startsWith('w')).length;
    const e = day.stopIds.length - w;
    assert.ok(Math.max(w, e) >= 18, `day mixed too evenly: ${w} west / ${e} east`);
  }
});

test('no day exceeds the door cap and ids are conserved', () => {
  const stops = blob('s', 100, 0, 0);
  const days = splitIntoDays(stops, 30);
  assert.equal(days.length, 4);
  for (const day of days) assert.ok(day.stopIds.length <= 30 && day.stopIds.length > 0);
  const ids = days.flatMap((d) => d.stopIds).sort();
  assert.deepEqual(ids, stops.map((s) => s.id).sort());
});

test('unknocked doors roll forward and finished ones drop out', () => {
  const stops = [...blob('w', 10, 0, 0), ...blob('e', 10, 5000, 0)];
  const days = splitIntoDays(stops, 10);
  const byId = new Map(stops.map((s) => [s.id, s]));
  const done = days[0].stopIds.slice(0, 4);
  const next = rollForward(days, done, 10, byId);
  const ids = next.flatMap((d) => d.stopIds);
  for (const id of done) assert.equal(ids.includes(id), false);
  assert.equal(ids.length, 16);
  for (const day of next) assert.ok(day.stopIds.length <= 10);
});

test('empty input', () => {
  assert.deepEqual(splitIntoDays([], 150), []);
});
