/**
 * Fictional demo neighborhood. Street names and coordinates are invented.
 * They are not surveyed rooftops and must not be treated as real leads.
 */

import { unprojectLocal } from './geo.js';

export const DEMO_ORIGIN = { lat: 39.2, lng: -76.8 };

const STREETS = [
  { name: 'Demo Oak Lane', y: 0 },
  { name: 'Demo Maple Lane', y: 110 },
  { name: 'Demo Cedar Lane', y: 220 },
  { name: 'Demo Birch Lane', y: 520 },
  { name: 'Demo Pine Lane', y: 630 },
];

export function demoStops() {
  const stops = [];
  let n = 1;
  for (const street of STREETS) {
    for (let i = 0; i < 3; i++) {
      for (const side of [12, -12]) {
      const ll = unprojectLocal(30 + i * 28, street.y + side, DEMO_ORIGIN.lat, DEMO_ORIGIN.lng);
      stops.push({
        id: `demo-${n}`,
        address: `${100 + n} ${street.name}, Northfield Demo`,
        lat: ll.lat,
        lng: ll.lng,
        placeId: `demo-place-${n}`,
        locationType: 'ROOFTOP',
        partialMatch: false,
        status: 'accept',
        flagReason: '',
        coordSource: 'sample',
        geocodedAt: null,
        disposition: null,
        disposedAt: null,
        revisitAt: null,
        skipped: false,
        locked: false,
        knocked: false,
        dayIndex: 0,
      });
      n += 1;
      }
    }
  }
  return stops;
}

export function demoStart() {
  return unprojectLocal(-30, 110, DEMO_ORIGIN.lat, DEMO_ORIGIN.lng);
}

export const DEMO_LABEL = 'Northfield Demo';
