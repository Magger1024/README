import assert from 'node:assert/strict';
import test from 'node:test';
import { parsePaste, parseCsv, rowsToStops, toSheetCsvUrl } from '../js/import.js';
import { classifyGeocodeResult, classifyValidation, coordinatesAreStale, refreshStaleStop, COORD_MAX_AGE_MS } from '../js/geocode.js';
import { suggestRevisit, learnedMinutes, dueRevisits } from '../js/time.js';
import { navLinks } from '../js/nav.js';

test('paste accepts one address per line and embedded coordinates', () => {
  const stops = parsePaste('10 Demo Oak Lane, Northfield Demo\n39.2001, -76.8002\n');
  assert.equal(stops.length, 2);
  assert.equal(stops[0].flagReason, 'needs_geocode');
  assert.equal(stops[0].status, 'flag');
  assert.equal(stops[1].status, 'flag');
  assert.ok(Math.abs(stops[1].lat - 39.2001) < 1e-9);
});

test('csv rooftop rows are accepted and interpolated rows are flagged', () => {
  const csv = 'address,lat,lng,location_type,partial\n1 Demo A,39.2,-76.8,ROOFTOP,false\n2 Demo B,39.21,-76.81,RANGE_INTERPOLATED,false\n3 Demo C,39.22,-76.82,ROOFTOP,true\n';
  const rows = parseCsv(csv);
  const stops = rowsToStops(rows);
  assert.equal(stops.length, 3);
  assert.equal(stops[0].status, 'accept');
  assert.equal(stops[0].coordSource, 'import');
  assert.equal(stops[1].status, 'flag');
  assert.match(stops[1].flagReason, /range_interpolated/);
  assert.equal(stops[2].status, 'flag');
  assert.equal(stops[2].flagReason, 'partial_match');
});

test('quoted commas survive csv parsing', () => {
  const rows = parseCsv('address\n"100 Demo Oak Lane, Northfield Demo"\n');
  assert.equal(rows[1][0], '100 Demo Oak Lane, Northfield Demo');
});

test('sheet links become a public csv export', () => {
  const url = toSheetCsvUrl('https://docs.google.com/spreadsheets/d/abc123/edit#gid=7');
  assert.equal(url, 'https://docs.google.com/spreadsheets/d/abc123/export?format=csv&gid=7');
  const pub = toSheetCsvUrl('https://docs.google.com/spreadsheets/d/e/xyz/pubhtml');
  assert.match(pub, /output=csv/);
  assert.throws(() => toSheetCsvUrl('https://example.com/leads'), /Google Sheet|CSV/);
});

test('only rooftop geocodes without a partial match are accepted', () => {
  const ok = classifyGeocodeResult({
    place_id: 'abc',
    partial_match: false,
    geometry: { location_type: 'ROOFTOP', location: { lat: 1, lng: 2 } },
  });
  assert.equal(ok.status, 'accept');
  assert.equal(ok.placeId, 'abc');
  const bad = classifyGeocodeResult({
    geometry: { location_type: 'RANGE_INTERPOLATED', location: { lat: 1, lng: 2 } },
    partial_match: true,
  });
  assert.equal(bad.status, 'flag');
  assert.match(bad.reason, /range_interpolated/);
  assert.match(bad.reason, /partial_match/);
});

test('address validation accepts premise and subpremise only', () => {
  const ok = classifyValidation({
    result: { verdict: { validationGranularity: 'PREMISE' }, geocode: { placeId: 'p', location: { latitude: 3, longitude: 4 } } },
  });
  assert.equal(ok.status, 'accept');
  assert.equal(ok.locationType, 'ROOFTOP');
  const bad = classifyValidation({ result: { verdict: { validationGranularity: 'ROUTE' } } });
  assert.equal(bad.status, 'flag');
});

test('google coordinates expire after 30 days and place id is kept', () => {
  const now = Date.UTC(2026, 10, 18);
  const fresh = { coordSource: 'google', geocodedAt: now - 10 * 86400000, lat: 1, lng: 2, placeId: 'keep' };
  const old = { coordSource: 'google', geocodedAt: now - COORD_MAX_AGE_MS - 1000, lat: 1, lng: 2, placeId: 'keep', status: 'accept' };
  const manual = { coordSource: 'manual', geocodedAt: now - COORD_MAX_AGE_MS - 1000, lat: 1, lng: 2, placeId: 'keep' };
  assert.equal(coordinatesAreStale(fresh, now), false);
  assert.equal(coordinatesAreStale(old, now), true);
  assert.equal(coordinatesAreStale(manual, now), false);
  const stripped = refreshStaleStop(old, now);
  assert.equal(stripped.lat, null);
  assert.equal(stripped.placeId, 'keep');
  assert.equal(stripped.flagReason, 'stale_coordinates');
});

test('come-back suggestions and learned minutes', () => {
  const morning = new Date(2026, 10, 18, 9, 30).getTime();
  const suggested = new Date(suggestRevisit(morning));
  assert.equal(suggested.getHours(), 12);
  const evening = new Date(2026, 10, 18, 16, 0).getTime();
  const next = new Date(suggestRevisit(evening));
  assert.equal(next.getDate(), 19);
  assert.equal(next.getHours(), 10);
  const events = [];
  let t = morning;
  for (let i = 0; i < 25; i++) {
    events.push({ t });
    t += 3 * 60000;
  }
  assert.equal(learnedMinutes(events, t, { minSamples: 20 }), 3);
  const stops = [{ id: 'a', disposition: 'come_back', revisitAt: morning, skipped: false }];
  assert.equal(dueRevisits(stops, morning).length, 1);
  assert.equal(dueRevisits(stops, morning - 1000).length, 0);
});

test('nav links are one coordinate pair', () => {
  const links = navLinks({ lat: 39.2, lng: -76.8 });
  assert.match(links.google, /destination=39\.2%2C-76\.8/);
  assert.match(links.google, /travelmode=driving/);
  assert.match(links.waze, /ll=39\.2,-76\.8/);
  assert.match(links.waze, /navigate=yes/);
  assert.match(links.apple, /daddr=39\.2,-76\.8/);
});
