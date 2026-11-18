/** Turn-by-turn handoff. One parking spot, not the whole route. */

export function navLinks(dest) {
  const lat = Number(dest.lat);
  const lng = Number(dest.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) throw new Error('Park point has no coordinates.');
  const pair = `${lat},${lng}`;
  return {
    google: `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(pair)}&travelmode=driving`,
    waze: `https://waze.com/ul?ll=${lat},${lng}&navigate=yes`,
    apple: `https://maps.apple.com/?daddr=${lat},${lng}&dirflg=d`,
  };
}

export function nextParkPoint(parks, stopsById) {
  for (const park of parks || []) {
    const pending = (park.stopIds || []).some((id) => {
      const s = stopsById.get(id);
      return s && !s.skipped && !s.disposition;
    });
    if (pending) return park;
  }
  return null;
}
