/** Google Maps JS + Places Autocomplete. Used only after a browser key is saved on the phone. */

let loader = null;

export function loadGoogleMaps(key) {
  if (window.google?.maps) return Promise.resolve(window.google.maps);
  if (loader) return loader;
  loader = new Promise((resolve, reject) => {
    const cb = `__blockwalkMaps${Date.now()}`;
    window[cb] = () => {
      resolve(window.google.maps);
      delete window[cb];
    };
    const script = document.createElement('script');
    script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&libraries=places&v=weekly&callback=${cb}`;
    script.async = true;
    script.onerror = () => reject(new Error('Maps JavaScript failed to load. Check the key and the HTTP referrer restriction.'));
    document.head.appendChild(script);
  });
  return loader;
}

export function attachAutocomplete(input, maps, onPlace) {
  if (!maps.places?.Autocomplete) return null;
  const ac = new maps.places.Autocomplete(input, {
    fields: ['place_id', 'formatted_address', 'geometry', 'name'],
  });
  ac.addListener('place_changed', () => {
    const place = ac.getPlace();
    const loc = place?.geometry?.location;
    if (!loc) return;
    onPlace({
      address: place.formatted_address || place.name || '',
      lat: loc.lat(),
      lng: loc.lng(),
      placeId: place.place_id || null,
    });
  });
  return ac;
}

export async function mountGoogleMap(element, key) {
  const maps = await loadGoogleMaps(key);
  const map = new maps.Map(element, {
    center: { lat: 39.2, lng: -76.8 },
    zoom: 16,
    mapTypeControl: false,
    streetViewControl: false,
    fullscreenControl: false,
    clickableIcons: false,
    gestureHandling: 'greedy',
  });
  const markers = new Map();
  const handlers = { onSelect: null, onDragEnd: null, onLongPress: null };
  let latestStops = [];
  let meMarker = null;
  let driveLine = null;
  const walkLines = [];
  let overlay = null;
  let areas = [];
  const api = {
    maps,
    map,
    setData(data) {
      latestStops = data.stops || [];
      const seen = new Set();
      for (const stop of latestStops) {
        if (stop.lat == null) continue;
        seen.add(stop.id);
        let marker = markers.get(stop.id);
        if (!marker) {
          const stopId = stop.id;
          marker = new maps.Marker({ map, draggable: stop.status === 'flag' });
          marker.addListener('click', () => handlers.onSelect?.(latestStops.find((s) => s.id === stopId) || stop));
          marker.addListener('dragend', (ev) => {
            const current = latestStops.find((s) => s.id === stopId) || stop;
            handlers.onDragEnd?.(current, { lat: ev.latLng.lat(), lng: ev.latLng.lng() });
          });
          markers.set(stop.id, marker);
        }
        marker.setPosition({ lat: stop.lat, lng: stop.lng });
        marker.setDraggable(stop.status === 'flag');
        marker.setIcon({
          path: maps.SymbolPath.CIRCLE,
          scale: stop.id === data.selectedId ? 8 : 6,
          fillColor: stop.status === 'flag' ? '#e37400' : stop.disposition ? '#9aa0a6' : '#1a73e8',
          fillOpacity: 1,
          strokeColor: '#fff',
          strokeWeight: 2,
        });
      }
      for (const [id, marker] of markers) {
        if (!seen.has(id)) {
          marker.setMap(null);
          markers.delete(id);
        }
      }
      (data.parks || []).forEach((park, i) => {
        const id = `park:${park.id}`;
        let marker = markers.get(id);
        if (!marker) {
          marker = new maps.Marker({ map, label: { text: String(i + 1), color: '#fff', fontWeight: '700' } });
          markers.set(id, marker);
        }
        marker.setPosition({ lat: park.lat, lng: park.lng });
        marker.setLabel({ text: String(i + 1), color: '#fff', fontWeight: '700' });
      });
      for (const [id, marker] of [...markers]) {
        if (id.startsWith('park:') && !(data.parks || []).some((p) => `park:${p.id}` === id)) {
          marker.setMap(null);
          markers.delete(id);
        }
      }
      if (driveLine) driveLine.setMap(null);
      driveLine = new maps.Polyline({
        map,
        path: data.drive || [],
        strokeColor: '#1a73e8',
        strokeWeight: 4,
      });
      walkLines.splice(0).forEach((line) => line.setMap(null));
      for (const walk of data.walks || []) {
        walkLines.push(new maps.Polyline({
          map,
          path: walk,
          strokeColor: '#1a73e8',
          strokeWeight: 2,
          strokeOpacity: 0.7,
        }));
      }
      areas.forEach((p) => p.setMap(null));
      areas = [];
      if (data.showAreas) {
        for (const area of data.areas || []) {
          areas.push(new maps.Polygon({
            map,
            paths: area.points,
            strokeWeight: 0,
            fillColor: '#1a73e8',
            fillOpacity: 0.15,
          }));
        }
      }
      if (data.me) {
        if (!meMarker) meMarker = new maps.Marker({ map, icon: { path: maps.SymbolPath.CIRCLE, scale: 7, fillColor: '#188038', fillOpacity: 1, strokeColor: '#fff', strokeWeight: 2 } });
        meMarker.setPosition(data.me);
      }
      map.setMapTypeId(data.mode === 'satellite' ? 'hybrid' : 'roadmap');
      if (overlay) overlay.setMap(null);
      if (data.flux?.rgba && data.streetZoom) {
        const canvas = document.createElement('canvas');
        canvas.width = data.flux.width;
        canvas.height = data.flux.height;
        canvas.getContext('2d').putImageData(new ImageData(data.flux.rgba, data.flux.width, data.flux.height), 0, 0);
        overlay = new maps.GroundOverlay(canvas.toDataURL(), {
          north: data.flux.north,
          south: data.flux.south,
          east: data.flux.east,
          west: data.flux.west,
        });
        overlay.setMap(map);
      }
    },
    fit(points) {
      if (!points.length) return;
      const bounds = new maps.LatLngBounds();
      points.forEach((p) => bounds.extend(p));
      map.fitBounds(bounds, 80);
    },
    metersPerPixel() {
      const lat = map.getCenter()?.lat() || 0;
      return 156543.03392 * Math.cos(lat * Math.PI / 180) / (2 ** map.getZoom());
    },
    on(name, fn) {
      map.addListener(name, fn);
    },
  };
  map.addListener('rightclick', (ev) => {
    handlers.onLongPress?.({ lat: ev.latLng.lat(), lng: ev.latLng.lng() });
  });
  api.onSelect = (fn) => { handlers.onSelect = fn; };
  api.onDragEnd = (fn) => { handlers.onDragEnd = fn; };
  api.onLongPress = (fn) => { handlers.onLongPress = fn; };
  return api;
}
