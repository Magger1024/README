/**
 * Minimal GeoTIFF reader for Solar API annual-flux rasters.
 * Classic TIFF, one band, strips or tiles, uncompressed or zlib deflate.
 * Predictor 1 (none) and 2 (horizontal). Float32 and uint samples.
 */

const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 12: 8 };

function readAscii(view, offset, count) {
  let s = '';
  for (let i = 0; i < count; i++) {
    const c = view.getUint8(offset + i);
    if (c === 0) break;
    s += String.fromCharCode(c);
  }
  return s;
}

function readValues(view, type, count, offset) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const o = offset + i * TYPE_SIZE[type];
    if (type === 3) out.push(view.getUint16(o, true));
    else if (type === 4) out.push(view.getUint32(o, true));
    else if (type === 12) out.push(view.getFloat64(o, true));
    else if (type === 1 || type === 2) out.push(view.getUint8(o));
    else throw new Error(`Unsupported TIFF type ${type}`);
  }
  return out;
}

function parseIfd(view, offset) {
  const tags = new Map();
  const count = view.getUint16(offset, true);
  let p = offset + 2;
  for (let i = 0; i < count; i++) {
    const tag = view.getUint16(p, true);
    const type = view.getUint16(p + 2, true);
    const n = view.getUint32(p + 4, true);
    const size = (TYPE_SIZE[type] || 1) * n;
    let valueOffset = p + 8;
    if (size > 4) valueOffset = view.getUint32(p + 8, true);
    tags.set(tag, { type, count: n, values: readValues(view, type, n, valueOffset) });
    p += 12;
  }
  return tags;
}

function tag1(tags, code, fallback = null) {
  const t = tags.get(code);
  if (!t || !t.values.length) return fallback;
  return t.values[0];
}

async function inflateZlib(bytes) {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('This browser cannot inflate a compressed GeoTIFF.');
  }
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function applyPredictor(samples, width, sampleFormat, bits, predictor) {
  if (!predictor || predictor === 1) return samples;
  if (predictor !== 2) throw new Error(`GeoTIFF predictor ${predictor} is not supported.`);
  const bytesPer = bits / 8;
  const rowBytes = width * bytesPer;
  const out = samples.slice();
  if (sampleFormat === 3 && bits === 32) {
    const src = new DataView(samples.buffer, samples.byteOffset, samples.byteLength);
    const dst = new DataView(out.buffer, out.byteOffset, out.byteLength);
    const rows = samples.length / rowBytes;
    for (let y = 0; y < rows; y++) {
      for (let x = 1; x < width; x++) {
        const i = (y * width + x) * 4;
        const prev = (y * width + (x - 1)) * 4;
        dst.setFloat32(i, src.getFloat32(i, true) + dst.getFloat32(prev, true), true);
      }
    }
    return out;
  }
  for (let i = 0; i < samples.length; i++) {
    if (i % rowBytes >= bytesPer) out[i] = (out[i] + out[i - bytesPer]) & 0xff;
  }
  return out;
}

function samplesToFloat(bytes, bits, sampleFormat) {
  const count = bytes.length / (bits / 8);
  const out = new Float64Array(count);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < count; i++) {
    if (bits === 32 && sampleFormat === 3) out[i] = view.getFloat32(i * 4, true);
    else if (bits === 64 && sampleFormat === 3) out[i] = view.getFloat64(i * 8, true);
    else if (bits === 16) out[i] = sampleFormat === 2 ? view.getInt16(i * 2, true) : view.getUint16(i * 2, true);
    else out[i] = bytes[i];
  }
  return out;
}

async function decodeChunk(bytes, compression) {
  if (compression === 1 || compression == null) return bytes;
  if (compression === 8) return inflateZlib(bytes);
  throw new Error(`GeoTIFF compression ${compression} is not supported. Expected uncompressed or deflate.`);
}

/**
 * @param {ArrayBuffer} buffer
 * @returns {Promise<{width,height,values:Float64Array,north,south,east,west,tie}>}
 */
export async function decodeGeotiff(buffer) {
  const view = new DataView(buffer);
  const endian = view.getUint16(0, true);
  if (endian !== 0x4949) throw new Error('Only little-endian GeoTIFF files are supported.');
  const magic = view.getUint16(2, true);
  if (magic !== 42) throw new Error('Only classic GeoTIFF files are supported.');
  const tags = parseIfd(view, view.getUint32(4, true));
  const width = tag1(tags, 256);
  const height = tag1(tags, 257);
  const bits = tag1(tags, 258, 8);
  const compression = tag1(tags, 259, 1);
  const sampleFormat = tag1(tags, 339, 1);
  const predictor = tag1(tags, 317, 1);
  const rowsPerStrip = tag1(tags, 278, height);
  const stripOffsets = tags.get(273)?.values || [];
  const stripCounts = tags.get(279)?.values || [];
  const tileWidth = tag1(tags, 322, 0);
  const tileHeight = tag1(tags, 323, 0);
  const tileOffsets = tags.get(324)?.values || [];
  const tileCounts = tags.get(325)?.values || [];

  const raw = new Uint8Array(width * height * (bits / 8));
  if (tileWidth && tileOffsets.length) {
    const tilesAcross = Math.ceil(width / tileWidth);
    for (let t = 0; t < tileOffsets.length; t++) {
      const chunk = new Uint8Array(buffer, tileOffsets[t], tileCounts[t]);
      const decoded = await decodeChunk(chunk, compression);
      const tileCol = t % tilesAcross;
      const tileRow = Math.floor(t / tilesAcross);
      const bytesPer = bits / 8;
      for (let row = 0; row < tileHeight; row++) {
        const y = tileRow * tileHeight + row;
        if (y >= height) break;
        const x0 = tileCol * tileWidth;
        const copyW = Math.min(tileWidth, width - x0);
        const src = row * tileWidth * bytesPer;
        const dst = (y * width + x0) * bytesPer;
        raw.set(decoded.subarray(src, src + copyW * bytesPer), dst);
      }
    }
  } else if (stripOffsets.length) {
    let y = 0;
    const bytesPer = bits / 8;
    for (let s = 0; s < stripOffsets.length; s++) {
      const chunk = new Uint8Array(buffer, stripOffsets[s], stripCounts[s]);
      const decoded = await decodeChunk(chunk, compression);
      const rows = Math.min(rowsPerStrip, height - y);
      const expected = rows * width * bytesPer;
      raw.set(decoded.subarray(0, expected), y * width * bytesPer);
      y += rows;
    }
  } else {
    throw new Error('GeoTIFF has no strips or tiles.');
  }

  const predicted = applyPredictor(raw, width, sampleFormat, bits, predictor);
  const values = samplesToFloat(predicted, bits, sampleFormat);
  const scale = tags.get(33550)?.values || [0, 0, 0];
  const tie = tags.get(33922)?.values || [0, 0, 0, 0, 0, 0];
  const originLng = tie[3] || 0;
  const originLat = tie[4] || 0;
  const scaleX = scale[0] || 0;
  const scaleY = scale[1] || 0;
  const west = originLng;
  const north = originLat;
  const east = originLng + scaleX * width;
  const south = originLat - scaleY * height;
  return {
    width,
    height,
    values,
    north: Math.max(north, south),
    south: Math.min(north, south),
    east: Math.max(east, west),
    west: Math.min(east, west),
    tie: { originLng, originLat, scaleX, scaleY },
  };
}

/** Build a tiny uncompressed float32 GeoTIFF. Used by tests and not by the app. */
export function encodeFloatGeotiff(values, width, height, geo, compressedSamples = null) {
  const samples = new Uint8Array(width * height * 4);
  const dv = new DataView(samples.buffer);
  for (let i = 0; i < values.length; i++) dv.setFloat32(i * 4, values[i], true);
  return encodeTiff({
    width,
    height,
    bits: 32,
    sampleFormat: 3,
    compression: compressedSamples ? 8 : 1,
    samples: compressedSamples || samples,
    geo,
  });
}

function encodeTiff({ width, height, bits, sampleFormat, compression, samples, geo }) {
  const doubles = new Float64Array([
    geo.scaleX, geo.scaleY, 0,
    0, 0, 0, geo.originLng, geo.originLat, 0,
  ]);
  const doubleBytes = new Uint8Array(doubles.buffer.slice(0));
  // little endian file
  const ifdCount = 12;
  const header = 8;
  const ifdBytes = 2 + ifdCount * 12 + 4;
  const doubleOffset = header + ifdBytes;
  const stripOffset = doubleOffset + doubleBytes.length;
  const total = stripOffset + samples.length;
  const buf = new ArrayBuffer(total);
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);
  view.setUint16(0, 0x4949, true);
  view.setUint16(2, 42, true);
  view.setUint32(4, header, true);
  view.setUint16(header, ifdCount, true);

  const tags = [
    [256, 4, 1, width],
    [257, 4, 1, height],
    [258, 3, 1, bits],
    [259, 3, 1, compression],
    [262, 3, 1, 1],
    [273, 4, 1, stripOffset],
    [277, 3, 1, 1],
    [278, 4, 1, height],
    [279, 4, 1, samples.length],
    [339, 3, 1, sampleFormat],
    [33550, 12, 3, doubleOffset],
    [33922, 12, 6, doubleOffset + 24],
  ];
  let p = header + 2;
  for (const [tag, type, count, value] of tags) {
    view.setUint16(p, tag, true);
    view.setUint16(p + 2, type, true);
    view.setUint32(p + 4, count, true);
    view.setUint32(p + 8, value, true);
    p += 12;
  }
  view.setUint32(p, 0, true);
  bytes.set(doubleBytes, doubleOffset);
  bytes.set(samples, stripOffset);
  return buf;
}
