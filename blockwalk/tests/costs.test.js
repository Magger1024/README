import assert from 'node:assert/strict';
import test from 'node:test';
import { tiered, RO_TIERS, GEO_TIERS, assessUsage, emptyUsage, rollUsage, priceUsage, LIMITS } from '../js/costs.js';

test('free tier is zero and the first paid stop is ten dollars per thousand', () => {
  assert.equal(tiered(0, 5000, RO_TIERS), 0);
  assert.equal(tiered(5000, 5000, RO_TIERS), 0);
  assert.ok(Math.abs(tiered(5001, 5000, RO_TIERS) - 0.01) < 1e-9);
  assert.ok(Math.abs(tiered(13200, 5000, RO_TIERS) - 82) < 1e-9);
});

test('geocoding price uses its own ladder', () => {
  assert.equal(tiered(10000, 10000, GEO_TIERS), 0);
  assert.ok(Math.abs(tiered(11000, 10000, GEO_TIERS) - 5) < 1e-9);
});

test('a call that crosses 5,000 optimized stops warns and does not block', () => {
  const usage = { ...emptyUsage(new Date('2026-11-02T12:00:00Z')), routeStops: 4800 };
  const result = assessUsage(usage, { routeStops: 300 });
  assert.equal(result.blocks.length, 0);
  assert.ok(result.warnings.some((w) => w.code === 'route_stops' && w.level === 'over'));
  assert.ok(result.costs.route > 0);
});

test('usage inside the free allotment has no warning and no cost', () => {
  const usage = emptyUsage(new Date('2026-11-02T12:00:00Z'));
  const result = assessUsage(usage, { routeStops: 40, geocodes: 40, buildingInsights: 1 });
  assert.equal(result.warnings.length, 0);
  assert.equal(result.blocks.length, 0);
  assert.equal(result.costs.total, 0);
});

test('the 46th sun overlay block in a day is blocked', () => {
  const usage = { ...emptyUsage(new Date('2026-11-18T15:00:00Z')), dataLayersToday: LIMITS.layersPerDay };
  const result = assessUsage(usage, { dataLayers: 1 });
  assert.ok(result.blocks.some((b) => b.code === 'layers_daily'));
});

test('a new month zeros counters and a new day zeros only the overlay cap', () => {
  const usage = {
    month: '2026-10',
    day: '2026-10-31',
    routeStops: 4000,
    geocodes: 20,
    buildingInsights: 3,
    dataLayers: 10,
    dataLayersToday: 10,
  };
  const rolled = rollUsage(usage, new Date('2026-11-01T12:00:00'));
  assert.equal(rolled.routeStops, 0);
  assert.equal(rolled.dataLayersToday, 0);
  const sameMonth = rollUsage({ ...usage, month: '2026-11', day: '2026-11-01', routeStops: 12, dataLayersToday: 4 }, new Date('2026-11-02T12:00:00'));
  assert.equal(sameMonth.routeStops, 12);
  assert.equal(sameMonth.dataLayersToday, 0);
});

test('priceUsage matches tiered on each product', () => {
  const costs = priceUsage({ routeStops: 13200, geocodes: 0, buildingInsights: 0, dataLayers: 0 });
  assert.ok(Math.abs(costs.total - 82) < 1e-9);
});
