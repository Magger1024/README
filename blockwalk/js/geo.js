/** Local meters, distances, and a stable id hash. No network, no DOM. */

const DEG = Math.PI / 180;
const M_PER_DEG = 111320;

export function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

export function haversineMeters(a, b) {
  const lat1 = a.lat * DEG;
  const lat2 = b.lat * DEG;
  const dlat = lat2 - lat1;
  const dlng = (b.lng - a.lng) * DEG;
  const h = Math.sin(dlat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dlng / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Equirectangular meters. `cosLat` is cos(reference latitude). */
export function equirectMeters(a, b, cosLat) {
  const x = (b.lng - a.lng) * M_PER_DEG * cosLat;
  const y = (b.lat - a.lat) * M_PER_DEG;
  return Math.hypot(x, y);
}

export function projectLocal(lat, lng, originLat, originLng) {
  return {
    x: (lng - originLng) * M_PER_DEG * Math.cos(originLat * DEG),
    y: (lat - originLat) * M_PER_DEG,
  };
}

export function unprojectLocal(x, y, originLat, originLng) {
  return {
    lat: originLat + y / M_PER_DEG,
    lng: originLng + x / (M_PER_DEG * Math.cos(originLat * DEG)),
  };
}

export function centroidLatLng(points) {
  let lat = 0;
  let lng = 0;
  for (const p of points) {
    lat += p.lat;
    lng += p.lng;
  }
  const n = points.length || 1;
  return { lat: lat / n, lng: lng / n };
}

export function meanLatitude(points) {
  if (!points.length) return 0;
  let s = 0;
  for (const p of points) s += p.lat;
  return s / points.length;
}

export function stableId(prefix, ids) {
  const s = ids.slice().sort().join('|');
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h) ^ s.charCodeAt(i);
  return prefix + (h >>> 0).toString(36);
}

export function formatDuration(totalSeconds) {
  const m = Math.max(0, Math.round(totalSeconds / 60));
  const h = Math.floor(m / 60);
  const min = m % 60;
  if (h <= 0) return `${min} m`;
  return `${h} h ${min} m`;
}

export function formatMiles(meters) {
  const mi = meters / 1609.344;
  if (mi < 10) return `${mi.toFixed(1)} mi`;
  return `${Math.round(mi)} mi`;
}

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function rand() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
