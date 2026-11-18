import assert from 'node:assert/strict';
import test from 'node:test';
import { buildOptimizeRequest, readOptimizeResponse, solverTimeoutSeconds, parseDuration } from '../js/optimize-request.js';

const spec = {
  departureTime: '2026-11-18T15:00:00.000Z',
  start: { lat: 39.2, lng: -76.8 },
  end: { lat: 39.21, lng: -76.79 },
  avoidUTurns: false,
  parkPoints: [
    { id: 'p1', lat: 39.201, lng: -76.801, serviceSeconds: 600, sideOfRoad: true, heading: 90, locked: true },
    { id: 'p2', lat: 39.202, lng: -76.802, serviceSeconds: 180, sideOfRoad: true, heading: 90, locked: false },
    { id: 'p3', lat: 39.203, lng: -76.803, serviceSeconds: 240, locked: true },
  ],
};

test('the optimize body is one vehicle, best search, traffic, fixed ends', () => {
  const body = buildOptimizeRequest(spec);
  assert.equal(body.searchMode, 'CONSUME_ALL_AVAILABLE_TIME');
  assert.equal(body.considerRoadTraffic, true);
  assert.equal(body.model.vehicles.length, 1);
  assert.equal(body.model.vehicles[0].travelMode, 'DRIVING');
  assert.equal(body.model.vehicles[0].startLocation.latitude, 39.2);
  assert.equal(body.model.vehicles[0].endLocation.longitude, -76.79);
  assert.equal(body.model.globalStartTime, '2026-11-18T15:00:00.000Z');
  assert.equal(body.model.shipments.length, 3);
  assert.equal(body.model.shipments[0].deliveries[0].duration, '600s');
  assert.equal(body.model.shipments[0].deliveries[0].arrivalWaypoint.sideOfRoad, true);
  assert.equal(body.model.shipments[0].deliveries[0].arrivalWaypoint.location.heading, 90);
  assert.equal(body.model.shipments[0].deliveries[0].avoidUTurns, undefined);
  assert.equal(body.model.shipments[0].label, 'p1');
  assert.deepEqual(body.model.precedenceRules, [
    { firstIndex: 0, secondIndex: 2, firstIsDelivery: true, secondIsDelivery: true },
  ]);
  assert.equal(body.timeout, `${solverTimeoutSeconds(3)}s`);
});

test('avoidUTurns is sent only when asked, and a big day uses the 45s budget', () => {
  const withU = buildOptimizeRequest({ ...spec, avoidUTurns: true });
  assert.equal(withU.model.shipments[1].deliveries[0].avoidUTurns, true);
  assert.equal(solverTimeoutSeconds(30), 8);
  assert.equal(solverTimeoutSeconds(200), 45);
  assert.equal(solverTimeoutSeconds(1001), 120);
});

test('response labels become the park order and durations parse', () => {
  assert.equal(parseDuration('125.5s'), 125.5);
  const read = readOptimizeResponse({
    routes: [{
      visits: [{ shipmentLabel: 'p2' }, { shipmentIndex: 0 }],
      transitions: [{ travelDistanceMeters: 1200, travelDuration: '180s', waitDuration: '0s' }],
      vehicleStartTime: '2026-11-18T15:00:00Z',
      vehicleEndTime: '2026-11-18T16:00:00Z',
    }],
    skippedShipments: [],
  }, spec.parkPoints);
  assert.deepEqual(read.order, ['p2', 'p1']);
  assert.equal(read.travelMeters, 1200);
  assert.equal(read.travelSeconds, 180);
});

test('more than one vehicle is not representable by the builder', () => {
  const body = buildOptimizeRequest(spec);
  assert.equal(body.model.vehicles.length, 1);
  assert.equal(JSON.stringify(body).includes('FLEET'), false);
});
