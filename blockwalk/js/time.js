/** Revisit suggestions and minutes-per-door learned from knock gaps. */

export function suggestRevisit(now) {
  const d = new Date(now);
  if (d.getHours() < 15) {
    d.setHours(d.getHours() + 3, 0, 0, 0);
    return d.getTime();
  }
  const next = new Date(d);
  next.setDate(next.getDate() + 1);
  next.setHours(10, 0, 0, 0);
  return next.getTime();
}

/**
 * Median gap between knocks, ignoring drive-length gaps.
 * Returns null until there are enough samples inside the horizon.
 */
export function learnedMinutes(events, now, options = {}) {
  const minSamples = options.minSamples ?? 20;
  const horizonMs = options.horizonMs ?? 7 * 24 * 60 * 60 * 1000;
  const cutoff = now - horizonMs;
  const times = (events || []).map((e) => e.t).filter((t) => t >= cutoff && t <= now).sort((a, b) => a - b);
  const gaps = [];
  for (let i = 1; i < times.length; i++) {
    const dt = (times[i] - times[i - 1]) / 60000;
    if (dt >= 0.4 && dt <= 20) gaps.push(dt);
  }
  if (gaps.length < minSamples) return null;
  gaps.sort((a, b) => a - b);
  return gaps[Math.floor(gaps.length / 2)];
}

export function dueRevisits(stops, now) {
  return (stops || []).filter((s) => s.disposition === 'come_back' && s.revisitAt != null && s.revisitAt <= now && !s.skipped);
}
