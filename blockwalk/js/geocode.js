/** Rooftop acceptance, Address Validation, and the 30-day coordinate rule. */

export const COORD_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export function classifyGeocodeResult(result) {
  if (!result) return { status: 'flag', reason: 'not_found', lat: null, lng: null, placeId: null, locationType: null };
  const locType = result.geometry?.location_type || result.locationType || '';
  const partial = result.partial_match === true || result.partialMatch === true;
  const lat = result.geometry?.location?.lat ?? result.lat ?? null;
  const lng = result.geometry?.location?.lng ?? result.lng ?? null;
  const placeId = result.place_id || result.placeId || null;
  const hasPoint = lat != null && lng != null && Number.isFinite(Number(lat)) && Number.isFinite(Number(lng));
  if (locType === 'ROOFTOP' && !partial && hasPoint) {
    return {
      status: 'accept',
      reason: 'rooftop',
      lat: Number(lat),
      lng: Number(lng),
      placeId,
      locationType: 'ROOFTOP',
    };
  }
  const reasons = [];
  if (!locType) reasons.push('no_location_type');
  else if (locType !== 'ROOFTOP') reasons.push(String(locType).toLowerCase());
  if (partial) reasons.push('partial_match');
  if (!hasPoint) reasons.push('no_coordinates');
  return {
    status: 'flag',
    reason: reasons.join(',') || 'not_rooftop',
    lat: hasPoint ? Number(lat) : null,
    lng: hasPoint ? Number(lng) : null,
    placeId,
    locationType: locType || null,
  };
}

export function classifyValidation(body) {
  const result = body?.result || body || {};
  const granularity = result.verdict?.validationGranularity || result.validationGranularity || '';
  const geo = result.geocode || {};
  const loc = geo.location || {};
  const placeId = geo.placeId || null;
  const lat = loc.latitude ?? null;
  const lng = loc.longitude ?? null;
  const exact = granularity === 'PREMISE' || granularity === 'SUB_PREMISE';
  if (exact && lat != null && lng != null) {
    return {
      status: 'accept',
      reason: granularity.toLowerCase(),
      lat: Number(lat),
      lng: Number(lng),
      placeId,
      locationType: 'ROOFTOP',
    };
  }
  return {
    status: 'flag',
    reason: (granularity || 'not_premise').toLowerCase(),
    lat: lat == null ? null : Number(lat),
    lng: lng == null ? null : Number(lng),
    placeId,
    locationType: granularity || null,
  };
}

/** Google-sourced coordinates expire after 30 days. Place IDs do not. Manual pins stay. */
export function coordinatesAreStale(stop, now) {
  if (!stop || stop.coordSource !== 'google') return false;
  if (!stop.geocodedAt) return true;
  return now - stop.geocodedAt > COORD_MAX_AGE_MS;
}

/**
 * Strip expired Google coordinates so they are not shown past the cache window.
 * The place id is kept so the next online session can refresh the pin.
 */
export function refreshStaleStop(stop, now) {
  if (!coordinatesAreStale(stop, now)) return stop;
  return {
    ...stop,
    lat: null,
    lng: null,
    status: 'flag',
    flagReason: 'stale_coordinates',
  };
}

export function applyGeocode(stop, classified, now, source = 'google') {
  return {
    ...stop,
    lat: classified.lat,
    lng: classified.lng,
    placeId: classified.placeId || stop.placeId || null,
    locationType: classified.locationType,
    partialMatch: classified.reason === 'partial_match' || (classified.reason || '').includes('partial_match'),
    status: classified.status,
    flagReason: classified.status === 'accept' ? '' : classified.reason,
    geocodedAt: source === 'google' || source === 'validation' ? now : stop.geocodedAt,
    coordSource: classified.status === 'accept' && (source === 'google' || source === 'validation') ? 'google' : stop.coordSource,
  };
}

export function applyManualPin(stop, lat, lng, now) {
  return {
    ...stop,
    lat,
    lng,
    status: 'accept',
    flagReason: '',
    locationType: 'USER_PIN',
    partialMatch: false,
    coordSource: 'manual',
    geocodedAt: now,
  };
}
