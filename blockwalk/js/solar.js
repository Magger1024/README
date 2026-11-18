/** Sun-layer policy: street zoom only, 30-day cache, yellow-to-purple flux. */

export const SOLAR_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
export const SOLAR_ATTRIBUTION = 'Source: Includes solar data from Google.';

/** Street zoom: about zoom 16 and closer. Coarser views must not fetch tiles. */
export function isStreetZoom(metersPerPixel) {
  return metersPerPixel <= 2;
}

export function cacheFresh(savedAt, now) {
  if (!savedAt) return false;
  return now - savedAt <= SOLAR_MAX_AGE_MS;
}

/** ~100 m grid so a small pan reuses the block already fetched. */
export function overlayKey(lat, lng) {
  return `${Number(lat).toFixed(3)},${Number(lng).toFixed(3)}`;
}

export function fluxRgb(t) {
  const u = Math.min(1, Math.max(0, t));
  return [
    Math.round(250 + (110 - 250) * u),
    Math.round(210 + (30 - 210) * u),
    Math.round(40 + (170 - 40) * u),
  ];
}

export function fluxToRgba(values, width, height) {
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const rgba = new Uint8ClampedArray(width * height * 4);
  const span = max - min;
  for (let i = 0; i < values.length; i++) {
    const t = span > 0 ? (values[i] - min) / span : 0;
    const c = fluxRgb(t);
    rgba[i * 4] = c[0];
    rgba[i * 4 + 1] = c[1];
    rgba[i * 4 + 2] = c[2];
    rgba[i * 4 + 3] = 150;
  }
  return { rgba, min, max };
}

export function summarizeInsight(data) {
  if (!data) return null;
  const sp = data.solarPotential || {};
  const segs = sp.roofSegmentStats || [];
  let best = null;
  for (const s of segs) {
    const quant = s.stats?.sunshineQuantiles;
    const score = quant && quant.length ? quant[quant.length - 1] : 0;
    if (!best || score > best.score) {
      best = {
        score,
        pitch: s.pitchDegrees ?? null,
        azimuth: s.azimuthDegrees ?? null,
        area: s.stats?.areaMeters2 ?? null,
      };
    }
  }
  const date = data.imageryDate;
  return {
    sunHours: sp.maxSunshineHoursPerYear ?? null,
    maxPanels: sp.maxArrayPanelsCount ?? null,
    quality: data.imageryQuality ?? null,
    date: date ? `${date.year}-${String(date.month).padStart(2, '0')}-${String(date.day).padStart(2, '0')}` : null,
    best,
  };
}

/** Synthetic flux so the toggle can be tried with no Solar key. Not Google data. */
export function demoFlux(bounds, cols = 48, rows = 48) {
  const values = new Float64Array(cols * rows);
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const nx = x / cols;
      const ny = y / rows;
      const roof = Math.sin(nx * 18) * Math.sin(ny * 14);
      values[y * cols + x] = 1100 + roof * 280 + (1 - ny) * 180;
    }
  }
  return {
    values,
    width: cols,
    height: rows,
    north: bounds.north,
    south: bounds.south,
    east: bounds.east,
    west: bounds.west,
    source: 'demo',
  };
}
