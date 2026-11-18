import assert from 'node:assert/strict';
import test from 'node:test';
import { deflateSync } from 'node:zlib';
import { decodeGeotiff, encodeFloatGeotiff } from '../js/geotiff.js';
import { fluxRgb, fluxToRgba, isStreetZoom, cacheFresh, SOLAR_MAX_AGE_MS, summarizeInsight, SOLAR_ATTRIBUTION } from '../js/solar.js';

test('round-trips a float32 annual flux grid and its bounds', async () => {
  const values = new Float64Array([10, 20, 30, 40]);
  const raw = encodeFloatGeotiff(values, 2, 2, {
    originLng: -76.8,
    originLat: 39.21,
    scaleX: 0.0001,
    scaleY: 0.0001,
  });
  const decoded = await decodeGeotiff(raw);
  assert.equal(decoded.width, 2);
  assert.equal(decoded.height, 2);
  assert.ok(Math.abs(decoded.values[0] - 10) < 1e-4);
  assert.ok(Math.abs(decoded.values[3] - 40) < 1e-4);
  assert.ok(Math.abs(decoded.north - 39.21) < 1e-9);
  assert.ok(decoded.south < decoded.north);
  assert.ok(decoded.east > decoded.west);
});

test('deflate strips decode', async () => {
  const values = new Float64Array([1, 2, 3, 4, 5, 6]);
  const plain = encodeFloatGeotiff(values, 3, 2, {
    originLng: -76.8,
    originLat: 39.2,
    scaleX: 0.001,
    scaleY: 0.001,
  });
  const sampleStart = plain.byteLength - values.length * 4;
  const compressed = deflateSync(new Uint8Array(plain, sampleStart));
  const encoded = encodeFloatGeotiff(values, 3, 2, {
    originLng: -76.8,
    originLat: 39.2,
    scaleX: 0.001,
    scaleY: 0.001,
  }, compressed);
  const decoded = await decodeGeotiff(encoded);
  assert.equal(decoded.width, 3);
  assert.equal(decoded.height, 2);
  assert.ok(Math.abs(decoded.values[0] - 1) < 1e-4);
  assert.ok(Math.abs(decoded.values[5] - 6) < 1e-4);
});

test('flux ramp runs yellow to purple and street zoom gates fetches', () => {
  const low = fluxRgb(0);
  const high = fluxRgb(1);
  assert.ok(low[0] > low[2]);
  assert.ok(high[2] > high[0]);
  const rgba = fluxToRgba(new Float64Array([0, 1]), 2, 1);
  assert.equal(rgba.rgba.length, 8);
  assert.equal(isStreetZoom(1.5), true);
  assert.equal(isStreetZoom(8), false);
  const now = Date.UTC(2026, 10, 18);
  assert.equal(cacheFresh(now - SOLAR_MAX_AGE_MS + 1000, now), true);
  assert.equal(cacheFresh(now - SOLAR_MAX_AGE_MS - 1000, now), false);
});

test('building insights summary picks sun hours, panels, and the best face', () => {
  const summary = summarizeInsight({
    imageryQuality: 'MEDIUM',
    imageryDate: { year: 2025, month: 6, day: 1 },
    solarPotential: {
      maxSunshineHoursPerYear: 1640,
      maxArrayPanelsCount: 18,
      roofSegmentStats: [
        { pitchDegrees: 20, azimuthDegrees: 180, stats: { areaMeters2: 30, sunshineQuantiles: [800, 1400] } },
        { pitchDegrees: 30, azimuthDegrees: 90, stats: { areaMeters2: 12, sunshineQuantiles: [400, 900] } },
      ],
    },
  });
  assert.equal(summary.sunHours, 1640);
  assert.equal(summary.maxPanels, 18);
  assert.equal(summary.quality, 'MEDIUM');
  assert.equal(summary.date, '2025-06-01');
  assert.equal(summary.best.azimuth, 180);
  assert.equal(SOLAR_ATTRIBUTION, 'Source: Includes solar data from Google.');
});
