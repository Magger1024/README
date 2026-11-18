/**
 * Google Maps Platform free-tier math from the Blockwalk design doc.
 * Prices are USD per 1,000 units after the free monthly allotment.
 * The app warns before a call would leave the free tier. Quotas in
 * Google Cloud are still the real brake.
 */

export const RO_TIERS = [[100000, 10], [500000, 4], [1000000, 2], [5000000, 0.8], [1e12, 0.7]];
export const GEO_TIERS = [[100000, 5], [500000, 4], [1000000, 3], [5000000, 1.5], [1e12, 0.38]];
export const BI_TIERS = [[100000, 10], [500000, 5], [1000000, 4.5], [5000000, 4], [1e12, 3.5]];
export const DL_TIERS = [[100000, 75], [500000, 37.5], [1000000, 33.75], [5000000, 30], [1e12, 26.25]];

export const LIMITS = {
  routeStopsFree: 5000,
  geocodeFree: 10000,
  insightsFree: 10000,
  layersFree: 1000,
  layersPerDay: 45,
};

export function tiered(units, free, tiers) {
  let cost = 0;
  let prev = free;
  for (const t of tiers) {
    const cap = t[0];
    const price = t[1];
    if (units > prev) cost += ((Math.min(units, cap) - prev) * price) / 1000;
    prev = Math.max(prev, cap);
  }
  return cost;
}

export function monthKey(date) {
  const d = date instanceof Date ? date : new Date(date);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export function dayKey(date) {
  const d = date instanceof Date ? date : new Date(date);
  return `${monthKey(d)}-${String(d.getDate()).padStart(2, '0')}`;
}

export function emptyUsage(now = new Date()) {
  return {
    month: monthKey(now),
    day: dayKey(now),
    routeStops: 0,
    geocodes: 0,
    buildingInsights: 0,
    dataLayers: 0,
    dataLayersToday: 0,
  };
}

export function rollUsage(usage, now = new Date()) {
  const month = monthKey(now);
  const day = dayKey(now);
  const base = usage && usage.month === month ? { ...emptyUsage(now), ...usage, month, day: usage.day } : emptyUsage(now);
  if (base.day !== day) {
    base.day = day;
    base.dataLayersToday = 0;
  }
  base.month = month;
  return base;
}

export function priceUsage(usage) {
  const route = tiered(usage.routeStops || 0, LIMITS.routeStopsFree, RO_TIERS);
  const geocode = tiered(usage.geocodes || 0, LIMITS.geocodeFree, GEO_TIERS);
  const insights = tiered(usage.buildingInsights || 0, LIMITS.insightsFree, BI_TIERS);
  const layers = tiered(usage.dataLayers || 0, LIMITS.layersFree, DL_TIERS);
  return { route, geocode, insights, layers, total: route + geocode + insights + layers };
}

/**
 * @param usage current counters
 * @param add units this call would consume
 */
export function assessUsage(usage, add = {}) {
  const next = {
    ...usage,
    routeStops: (usage.routeStops || 0) + (add.routeStops || 0),
    geocodes: (usage.geocodes || 0) + (add.geocodes || 0),
    buildingInsights: (usage.buildingInsights || 0) + (add.buildingInsights || 0),
    dataLayers: (usage.dataLayers || 0) + (add.dataLayers || 0),
    dataLayersToday: (usage.dataLayersToday || 0) + (add.dataLayers || 0),
  };
  const warnings = [];
  const blocks = [];
  const near = (code, label, value, free) => {
    if (value > free) {
      warnings.push({
        level: 'over',
        code,
        message: `${label} would be ${value.toLocaleString('en-US')} this month, past the free ${free.toLocaleString('en-US')}.`,
      });
    } else if (value >= free * 0.8 && (add.routeStops || add.geocodes || add.buildingInsights || add.dataLayers)) {
      warnings.push({
        level: 'near',
        code,
        message: `${label} would be ${value.toLocaleString('en-US')} of ${free.toLocaleString('en-US')} free this month.`,
      });
    }
  };
  if (add.routeStops) near('route_stops', 'Optimized stops', next.routeStops, LIMITS.routeStopsFree);
  if (add.geocodes) near('geocodes', 'Geocodes', next.geocodes, LIMITS.geocodeFree);
  if (add.buildingInsights) near('insights', 'Sun-hour lookups', next.buildingInsights, LIMITS.insightsFree);
  if (add.dataLayers) near('layers', 'Sun overlay blocks', next.dataLayers, LIMITS.layersFree);
  if ((add.dataLayers || 0) > 0 && next.dataLayersToday > LIMITS.layersPerDay) {
    blocks.push({
      code: 'layers_daily',
      message: `Daily sun overlay cap is ${LIMITS.layersPerDay} blocks. This keeps a normal month inside the free 1,000.`,
    });
  }
  return { next, warnings, blocks, costs: priceUsage(next) };
}

export function applyAdd(usage, add) {
  return assessUsage(usage, add).next;
}

export function standingWarnings(usage) {
  const warnings = [];
  const u = usage || {};
  if ((u.routeStops || 0) > LIMITS.routeStopsFree) {
    warnings.push(`Optimized stops are past the free ${LIMITS.routeStopsFree.toLocaleString('en-US')} this month.`);
  }
  if ((u.geocodes || 0) > LIMITS.geocodeFree) {
    warnings.push(`Geocodes are past the free ${LIMITS.geocodeFree.toLocaleString('en-US')} this month.`);
  }
  if ((u.buildingInsights || 0) > LIMITS.insightsFree) {
    warnings.push(`Sun-hour lookups are past the free ${LIMITS.insightsFree.toLocaleString('en-US')} this month.`);
  }
  if ((u.dataLayers || 0) > LIMITS.layersFree) {
    warnings.push(`Sun overlay blocks are past the free ${LIMITS.layersFree.toLocaleString('en-US')} this month.`);
  }
  if ((u.dataLayersToday || 0) >= LIMITS.layersPerDay) {
    warnings.push(`Sun overlay hit the daily cap of ${LIMITS.layersPerDay}.`);
  }
  return warnings;
}
