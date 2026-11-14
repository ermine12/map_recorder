const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const test = require('node:test');
const vm = require('node:vm');

const projectRoot = path.resolve(__dirname, '..');
const organicSample = process.env.MAP_RECORDER_SAMPLE_TRACK ||
  path.join(os.homedir(), 'Downloads', 'Telegram Desktop', '11 November 2026, 1334.geojson');

function loadDelta(turf = {}, extras = {}) {
  const context = vm.createContext({ turf, console, Date, AbortController, ...extras });
  vm.runInContext(fs.readFileSync(path.join(projectRoot, 'delta.js'), 'utf8'), context);
  return context.DeltaExtractor;
}

function loadMerger() {
  const context = vm.createContext({ console, Date, Math });
  vm.runInContext(fs.readFileSync(path.join(projectRoot, 'merger.js'), 'utf8'), context);
  return context.ShortcutMerger;
}

function line(coordinates, sourceId) {
  return {
    type: 'Feature',
    geometry: { type: 'LineString', coordinates },
    properties: sourceId ? { source_id: sourceId } : {}
  };
}

// A small metric geometry substitute keeps this integration check independent
// of the app's CDN scripts while exercising its actual matching decisions.
function metricTurf() {
  const toXY = ([lon, lat]) => [lon * 111_000 * Math.cos(9 * Math.PI / 180), lat * 111_000];
  const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  function lineCoordinates(line) {
    return line.geometry ? line.geometry.coordinates : line.coordinates;
  }
  return {
    lineString: coordinates => ({ type: 'Feature', geometry: { type: 'LineString', coordinates }, properties: {} }),
    point: coordinates => ({ type: 'Feature', geometry: { type: 'Point', coordinates }, properties: {} }),
    length(line) {
      const coords = lineCoordinates(line).map(toXY);
      let metres = 0;
      for (let i = 1; i < coords.length; i++) metres += distance(coords[i - 1], coords[i]);
      return metres;
    },
    pointToLineDistance(point, line) {
      const p = toXY(point.geometry.coordinates);
      const coords = lineCoordinates(line).map(toXY);
      let minimum = Infinity;
      for (let i = 1; i < coords.length; i++) {
        const a = coords[i - 1], b = coords[i];
        const dx = b[0] - a[0], dy = b[1] - a[1];
        const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) /
          Math.max(dx * dx + dy * dy, 1e-12)));
        minimum = Math.min(minimum, distance(p, [a[0] + t * dx, a[1] + t * dy]));
      }
      return minimum;
    }
  };
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

test('separate GeoJSON features stay separate, with times aligned to valid points', () => {
  const input = {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: [[42, 9, 5], [42.0001, 9, 6]] },
        properties: { coordTimes: ['2026-11-13T10:00:00Z', '2026-11-13T10:00:10Z'] }
      },
      {
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: [[42.01, 9.01], [42.0101, 9.01]] },
        properties: {}
      }
    ]
  };
  const parsed = loadDelta().parseGeoJSON(input);
  assert.equal(parsed.segments.length, 2);
  assert.deepEqual(plain(parsed.segments[0].coords), [[42, 9], [42.0001, 9]]);
  assert.equal(parsed.segments[0].times.length, 2);
  assert.equal(parsed.segments[0].times[1] - parsed.segments[0].times[0], 10_000);
  assert.deepEqual(plain(parsed.segments[1].coords), [[42.01, 9.01], [42.0101, 9.01]]);
});

test('the supplied long recording retains its timing evidence for gap cleaning', t => {
  const original = organicSample;
  if (!fs.existsSync(original)) return t.skip('Original Organic Maps recording is unavailable');
  const parsed = loadDelta().parseTrack(fs.readFileSync(original, 'utf8'), original);
  assert.equal(parsed.segments.length, 1);
  assert.equal(parsed.segments[0].coords.length, 146);
  assert.equal(parsed.segments[0].times.length, 146);
  const largestGap = Math.max(...parsed.segments[0].times.slice(1).map((time, i) =>
    time - parsed.segments[0].times[i]));
  assert.equal(largestGap, 7_146_000);
});

test('the supplied long recording is split at pauses before OSM comparison', t => {
  const original = organicSample;
  if (!fs.existsSync(original)) return t.skip('Original Organic Maps recording is unavailable');
  const delta = loadDelta();
  if (!delta.prepareTrack) return t.skip('Track preparation API is being integrated');
  const parsed = delta.parseTrack(fs.readFileSync(original, 'utf8'), original);
  const prepared = delta.prepareTrack(parsed.segments);
  assert.ok(prepared.segments.length > 1, 'Long source track must not remain a single path');
  assert.ok(prepared.warnings.length > 0, 'The importer must report quality warnings');
  assert.ok(prepared.segments.some(segment => segment.warningReasons.some(reason => reason.includes('Repeated movement'))));
  assert.ok(prepared.segments.some(segment => !segment.warningReasons.some(reason => reason.includes('Repeated movement'))),
    'Clean approach geometry should be separated from the tangled portion');
  for (const segment of prepared.segments) {
    for (let i = 1; i < segment.times.length; i++) {
      if (segment.times[i] != null && segment.times[i - 1] != null) {
        assert.ok(segment.times[i] - segment.times[i - 1] <= 120_000);
      }
    }
  }
});

test('the supplied tangled delta is flagged even without original timestamps', t => {
  const exportedDelta = path.join(os.homedir(), 'Downloads', 'delta-shortcuts-2026-11-13T19-24-28.geojson');
  if (!fs.existsSync(exportedDelta)) return t.skip('The earlier delta export is unavailable');
  const delta = loadDelta();
  const prepared = delta.prepareTrack(delta.parseGeoJSON(fs.readFileSync(exportedDelta, 'utf8')).segments);
  assert.ok(prepared.segments.some(segment => segment.sourceSegment === 3 &&
    segment.warningReasons.some(reason => reason.includes('Repeated movement'))));
});

test('OSM corridor splits a sparsely sampled crossing instead of keeping it whole', () => {
  const delta = loadDelta(metricTurf());
  const crossingWalk = [[42, 9], [42.001, 9]];
  const mappedRoad = [[[42.0005, 8.999], [42.0005, 9.001]]];
  const outside = delta.extractShortcuts(crossingWalk, mappedRoad, 4.5, 3);
  assert.equal(outside.length, 2);
  assert.ok(outside[0].at(-1)[0] < 42.0005);
  assert.ok(outside[1][0][0] > 42.0005);
});

test('a longer repeat walk retains the new extension and original approved line', () => {
  const merger = loadMerger();
  const approved = line([[42, 9], [42.0009, 9]], 'walk-a');
  const extension = line([[42, 9], [42.0018, 9]], 'walk-b');
  const result = merger.mergeIntoCollection([approved], extension, 5);
  assert.equal(result.addedCount, 1);
  assert.deepEqual(plain(result.updatedFeatures[0].geometry), approved.geometry);
  assert.ok(result.updatedFeatures[1].geometry.coordinates[0][0] > 42.0008);
  assert.ok(result.updatedFeatures[1].geometry.coordinates.at(-1)[0] > 42.0017);
  const repeatedImport = merger.batchMerge(result.updatedFeatures, [extension], 5);
  assert.equal(repeatedImport.addedCount, 0);
  assert.equal(repeatedImport.reinforcedCount, 0);
  assert.equal(repeatedImport.updatedFeatures.length, 2);
});

test('a densely sampled subset cannot replace or shorten an approved route', () => {
  const merger = loadMerger();
  const approved = line([[42, 9], [42.0009, 9]], 'walk-a');
  const denseSubset = line([[42.0002, 9], [42.0003, 9], [42.0004, 9],
    [42.0005, 9], [42.0006, 9]], 'walk-b');
  const result = merger.mergeIntoCollection([approved], denseSubset, 5);
  assert.equal(result.addedCount, 0);
  assert.deepEqual(plain(result.updatedFeatures[0].geometry), approved.geometry);
});

test('an actual perpendicular crossing stays available as a distinct path', () => {
  const merger = loadMerger();
  const approved = line([[42, 9], [42.0009, 9]], 'walk-a');
  const crossing = line([[42.00045, 8.99955], [42.00045, 9.00045]], 'walk-b');
  const result = merger.mergeIntoCollection([approved], crossing, 5);
  assert.equal(result.addedCount, 1);
  assert.deepEqual(plain(result.updatedFeatures[0].geometry), approved.geometry);
});

test('an Overpass error remark cannot make a whole walk look unmapped', async () => {
  const delta = loadDelta({}, {
    fetch: async () => ({ ok: true, json: async () => ({ elements: [], remark: 'runtime error: timeout' }) })
  });
  await assert.rejects(delta.fetchOSMRoads({ north: 9.1, south: 9, east: 42.1, west: 42 }),
    /OpenStreetMap|incomplete|connect/);
});

test('a road response missing its node coordinates is rejected', async () => {
  const delta = loadDelta({}, {
    fetch: async () => ({ ok: true, json: async () => ({ elements: [{ type: 'way', id: 1, nodes: [10, 11] }] }) })
  });
  await assert.rejects(delta.fetchOSMRoads({ north: 9.1, south: 9, east: 42.1, west: 42 }),
    /OpenStreetMap|incomplete|connect/);
});

test('master storage failure reaches the caller instead of reporting a saved path', () => {
  const context = vm.createContext({
    console: { warn() {}, error() {} },
    localStorage: { getItem: () => null, setItem: () => { throw new Error('quota'); } },
    ShortcutMerger: {
      mergeIntoCollection: (_features, feature) => ({
        updatedFeatures: [feature], action: 'added', matchedFeatureName: 'candidate', timesWalked: 1
      })
    }
  });
  vm.runInContext(fs.readFileSync(path.join(projectRoot, 'master.js'), 'utf8'), context);
  assert.throws(() => context.MasterLayerManager.addShortcut(line([[42, 9], [42.001, 9]], 'sample')),
    /storage/i);
});
