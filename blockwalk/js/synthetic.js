/** Synthetic street grids for tests and the benchmark. Not real addresses. */

import { unprojectLocal } from './geo.js';

const ORIGIN = { lat: 39.2, lng: -76.8 };

export function syntheticStops(count, seed = 1) {
  const n = Math.max(0, count | 0);
  const stops = [];
  const pitch = 140;
  const along = 22;
  let i = 0;
  let street = 0;
  while (i < n) {
    const y = street * pitch;
    const houses = 10;
    for (let h = 0; h < houses && i < n; h++) {
      for (const side of [12, -12]) {
        if (i >= n) break;
        const ll = unprojectLocal(h * along, y + side, ORIGIN.lat, ORIGIN.lng);
        stops.push({
          id: `s${i}`,
          lat: ll.lat,
          lng: ll.lng,
          address: `${100 + i} Synthetic ${street % 2 ? 'North' : 'South'} Demo`,
        });
        i += 1;
      }
    }
    street += 1;
    if (street > 100000) break;
  }
  return stops;
}

export { ORIGIN as SYNTHETIC_ORIGIN };
