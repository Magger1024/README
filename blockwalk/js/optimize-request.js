/**
 * Google Route Optimization request builder.
 * One vehicle only — several vehicles would bill as Fleet Routing.
 * searchMode CONSUME_ALL_AVAILABLE_TIME, traffic on, fixed start and end.
 * Visit duration is the park's service time (doors × minutes, plus the walk).
 * sideOfRoad is on by default. avoidUTurns is off unless the caller asks.
 */

export function solverTimeoutSeconds(parkCount) {
  if (parkCount <= 30) return 8;
  if (parkCount <= 100) return 20;
  if (parkCount <= 1000) return 45;
  return 120;
}

export function useLongRunning(parkCount, timeoutSeconds) {
  return parkCount > 1000 || timeoutSeconds > 45;
}

function headingInt(value) {
  if (value == null || !Number.isFinite(Number(value))) return null;
  const n = Math.round(Number(value)) % 360;
  return n < 0 ? n + 360 : n;
}

export function buildOptimizeRequest(spec) {
  const parks = spec?.parkPoints || [];
  if (!parks.length) throw new Error('Add at least one park point.');
  if (parks.length > 5000) throw new Error('Too many park points for one solve. Split the day first.');
  if (!spec.start || spec.start.lat == null || !spec.end || spec.end.lat == null) {
    throw new Error('Start and end are required.');
  }
  const departureMs = Date.parse(spec.departureTime);
  if (!Number.isFinite(departureMs)) throw new Error('Departure time must be an ISO timestamp.');
  const timeoutSeconds = spec.timeoutSeconds || solverTimeoutSeconds(parks.length);
  const clampedTimeout = Math.min(120, Math.max(1, Math.round(timeoutSeconds)));
  const departure = new Date(departureMs).toISOString();
  const globalEndTime = new Date(departureMs + 18 * 3600 * 1000).toISOString();
  const leaveEnd = new Date(departureMs + 5 * 60 * 1000).toISOString();

  const lockedIndexes = [];
  parks.forEach((p, i) => {
    if (p.locked) lockedIndexes.push(i);
  });
  const precedenceRules = [];
  for (let i = 1; i < lockedIndexes.length; i++) {
    precedenceRules.push({
      firstIndex: lockedIndexes[i - 1],
      secondIndex: lockedIndexes[i],
      firstIsDelivery: true,
      secondIsDelivery: true,
    });
  }

  const shipments = parks.map((p) => {
    const heading = headingInt(p.heading);
    const visit = {
      arrivalWaypoint: {
        location: {
          latLng: { latitude: p.lat, longitude: p.lng },
          ...(heading == null ? {} : { heading }),
        },
        sideOfRoad: p.sideOfRoad !== false,
      },
      duration: `${Math.max(0, Math.round(p.serviceSeconds || 0))}s`,
    };
    if (spec.avoidUTurns === true) visit.avoidUTurns = true;
    return { label: String(p.id), deliveries: [visit] };
  });

  return {
    timeout: `${clampedTimeout}s`,
    searchMode: 'CONSUME_ALL_AVAILABLE_TIME',
    considerRoadTraffic: spec.considerRoadTraffic !== false,
    populatePolylines: false,
    populateTransitionPolylines: false,
    label: 'blockwalk',
    model: {
      globalStartTime: departure,
      globalEndTime,
      shipments,
      vehicles: [
        {
          label: 'rep',
          displayName: 'rep',
          travelMode: 'DRIVING',
          startLocation: { latitude: spec.start.lat, longitude: spec.start.lng },
          endLocation: { latitude: spec.end.lat, longitude: spec.end.lng },
          startTimeWindows: [{ startTime: departure, endTime: leaveEnd }],
          costPerTraveledHour: 40,
          costPerKilometer: 1,
        },
      ],
      ...(precedenceRules.length ? { precedenceRules } : {}),
    },
  };
}

export function parseDuration(value) {
  if (value == null) return 0;
  if (typeof value === 'number') return value;
  const m = String(value).match(/(-?\d+(?:\.\d+)?)s/);
  return m ? Number(m[1]) : 0;
}

export function readOptimizeResponse(body, parkPoints) {
  const routes = body?.routes || [];
  const skipped = body?.skippedShipments || [];
  if (!routes.length) {
    const labels = skipped.map((s) => s.label || s.index).join(', ');
    throw new Error(labels ? `No route. Skipped: ${labels}` : 'Google returned no route.');
  }
  const route = routes[0];
  const visits = route.visits || [];
  const order = visits.map((v) => {
    if (v.shipmentLabel) return v.shipmentLabel;
    if (v.shipmentIndex != null && parkPoints && parkPoints[v.shipmentIndex]) return parkPoints[v.shipmentIndex].id;
    return null;
  });
  const transitions = (route.transitions || []).map((t) => ({
    travelDistanceMeters: t.travelDistanceMeters || 0,
    travelDurationSeconds: parseDuration(t.travelDuration),
    waitDurationSeconds: parseDuration(t.waitDuration),
  }));
  const travelMeters = transitions.reduce((s, t) => s + t.travelDistanceMeters, 0);
  const travelSeconds = transitions.reduce((s, t) => s + t.travelDurationSeconds, 0);
  return {
    order: order.filter(Boolean),
    transitions,
    travelMeters,
    travelSeconds,
    vehicleStartTime: route.vehicleStartTime || null,
    vehicleEndTime: route.vehicleEndTime || null,
    skipped: skipped.map((s) => s.label || String(s.index)),
  };
}
