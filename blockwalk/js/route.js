/**
 * Day route assembly: park points, local or Google order, stats, blockers.
 * A flagged pin blocks Optimize. Skipped stops are left out. Knocked stops
 * stay done and are not sent again.
 */

import { formatDuration, formatMiles, haversineMeters } from './geo.js';
import { clusterStops, serviceSeconds } from './cluster.js';
import { optimizeLocal } from './optimize.js';
import { nextParkPoint } from './nav.js';

export const ROAD_FACTOR = 1.4;
export const DRIVE_MPS = 7.8;

export function blockers(stops) {
  return (stops || []).filter((s) => s.status === 'flag' && !s.skipped && !s.knocked && !s.disposition);
}

export function optimizableStops(stops) {
  return (stops || []).filter((s) => s.status === 'accept' && !s.skipped && !s.disposition && !s.knocked && s.lat != null && s.lng != null);
}

export function buildParkPoints(stops, options = {}) {
  const minutes = options.minutesPerDoor ?? 3;
  const clusters = clusterStops(stops, {
    walkMeters: options.walkMeters ?? 150,
    streetWidthMeters: options.streetWidthMeters,
    maxSpanMeters: options.maxSpanMeters,
    maxDoors: options.maxDoors,
  });
  const byId = new Map(stops.map((s) => [s.id, s]));
  return clusters.map((cluster) => {
    const members = cluster.stopIds.map((id) => byId.get(id)).filter(Boolean);
    const locked = members.some((s) => s.locked);
    return {
      ...cluster,
      stops: members,
      locked,
      serviceSeconds: serviceSeconds(cluster, minutes),
    };
  });
}

export function orderParksFromIds(parks, ids) {
  const byId = new Map(parks.map((p) => [p.id, p]));
  return ids.map((id) => byId.get(id)).filter(Boolean);
}

/** Preserve the current relative order of locked park points. */
export function lockParksFromCurrent(parks, previousOrder) {
  if (!previousOrder || !previousOrder.length) return parks;
  const index = new Map(previousOrder.map((id, i) => [id, i]));
  const locked = parks.filter((p) => p.locked).sort((a, b) => (index.get(a.id) ?? 1e9) - (index.get(b.id) ?? 1e9));
  const rank = new Map(locked.map((p, i) => [p.id, i]));
  return parks
    .slice()
    .sort((a, b) => (rank.get(a.id) ?? 1e9) - (rank.get(b.id) ?? 1e9))
    .map((p) => p);
}

export function localRoute(parks, start, end) {
  const points = parks.map((p) => ({
    id: p.id,
    lat: p.park.lat,
    lng: p.park.lng,
    locked: !!p.locked,
  }));
  const solved = optimizeLocal({ points, start, end });
  const ordered = orderParksFromIds(parks, solved.order);
  return {
    engine: 'local',
    parkIds: solved.order,
    parks: ordered,
    geodesicMeters: solved.geodesicMeters,
    travelMeters: solved.geodesicMeters * ROAD_FACTOR,
    travelSeconds: (solved.geodesicMeters * ROAD_FACTOR) / DRIVE_MPS,
  };
}

export function routeStats(route, stops) {
  const travelMeters = route?.travelMeters || 0;
  const travelSeconds = route?.travelSeconds || 0;
  const serviceSecondsSum = (route?.parks || []).reduce((s, p) => s + (p.serviceSeconds || 0), 0);
  const totalSeconds = travelSeconds + serviceSecondsSum;
  const list = stops || [];
  const knocked = list.filter((s) => s.disposition);
  return {
    doors: list.filter((s) => !s.skipped).length,
    parks: route?.parks?.length || 0,
    knocked: knocked.length,
    notHome: knocked.filter((s) => s.disposition === 'not_home').length,
    sits: knocked.filter((s) => s.disposition === 'sit').length,
    comeBack: knocked.filter((s) => s.disposition === 'come_back').length,
    no: knocked.filter((s) => s.disposition === 'not_interested').length,
    milesLabel: formatMiles(travelMeters),
    hoursLabel: formatDuration(totalSeconds),
    travelMeters,
    totalSeconds,
    serviceSeconds: serviceSecondsSum,
  };
}

export function statsLine(stats, departureLabel, estimated) {
  const miles = estimated && stats.parks ? `est. ${stats.milesLabel}` : stats.milesLabel;
  const doors = `${stats.doors} door${stats.doors === 1 ? '' : 's'}`;
  const parks = `${stats.parks} park point${stats.parks === 1 ? '' : 's'}`;
  const line1 = stats.parks ? `${doors} · ${parks}` : `${doors} · not routed`;
  const line2 = stats.parks ? `${miles} · ${stats.hoursLabel} · leave ${departureLabel}` : 'Set a start and tap Optimize';
  const bits = [];
  if (stats.knocked) bits.push(`${stats.knocked} knocked`);
  if (stats.notHome) bits.push(`${stats.notHome} not home`);
  if (stats.sits) bits.push(`${stats.sits} sit${stats.sits === 1 ? '' : 's'}`);
  if (stats.comeBack) bits.push(`${stats.comeBack} come back`);
  if (stats.no) bits.push(`${stats.no} no`);
  return { line1, line2, line3: bits.join(' · ') };
}

export function flattenedStops(parks) {
  const ids = [];
  for (const park of parks || []) ids.push(...park.stopIds);
  return ids;
}

export function moveVisit(stopIds, stopId, where) {
  const ids = stopIds.slice();
  const from = ids.indexOf(stopId);
  if (from < 0) return ids;
  ids.splice(from, 1);
  if (where === 'last') ids.push(stopId);
  else if (where === 'first' || where === 'next') ids.unshift(stopId);
  else ids.splice(Math.min(ids.length, from), 0, stopId);
  return ids;
}

export function nextTarget(route, stops) {
  if (!route?.parks?.length) return null;
  const byId = new Map(stops.map((s) => [s.id, s]));
  return nextParkPoint(route.parks, byId);
}

export function legMeters(a, b) {
  return haversineMeters(a, b);
}
