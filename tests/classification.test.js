const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const metres = ([lon, lat]) => [lon * 109855, lat * 111195];
const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const coordsOf = feature => feature.geometry.coordinates;
const turf = {
  lineString: coordinates => ({ type: 'Feature', geometry: { type: 'LineString', coordinates } }),
  point: coordinates => ({ type: 'Feature', geometry: { type: 'Point', coordinates } }),
  length(line) {
    const coords = coordsOf(line).map(metres);
    return coords.slice(1).reduce((sum, point, i) => sum + distance(point, coords[i]), 0);
  },
  pointToLineDistance(point, line) {
    const p = metres(point.geometry.coordinates);
    const coords = coordsOf(line).map(metres);
    let nearest = Infinity;
    for (let i = 1; i < coords.length; i++) {
      const a = coords[i - 1], b = coords[i];
      const dx = b[0] - a[0], dy = b[1] - a[1];
      const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) /
        Math.max(dx * dx + dy * dy, 1e-12)));
      nearest = Math.min(nearest, distance(p, [a[0] + t * dx, a[1] + t * dy]));
    }
    return nearest;
  }
};

test('extraction reports every removed category and does not draw a pause as a path', async () => {
  const source = {
    type: 'FeatureCollection',
    features: [
      { type: 'Feature', geometry: { type: 'LineString', coordinates: [
        [42, 9], [42.0005, 9], [42.001, 9], [42.002, 9], [42.0021, 9]
      ] }, properties: { coordTimes: [
        '2026-11-13T10:00:00Z', '2026-11-13T10:00:10Z', '2026-11-13T10:00:20Z',
        '2026-11-13T10:04:20Z', '2026-11-13T10:04:30Z'
      ] } },
      { type: 'Feature', geometry: { type: 'LineString', coordinates: [[42.003, 9], [42.00301, 9]] }, properties: {} }
    ]
  };
  const osm = { elements: [
    { type: 'way', id: 1, nodes: [1, 2] },
    { type: 'node', id: 1, lon: 42, lat: 9 },
    { type: 'node', id: 2, lon: 42.0005, lat: 9 }
  ] };
  class FileReader {
    readAsText(file) { this.onload({ target: { result: file.content } }); }
  }
  const layerGroup = () => ({ addLayer() {}, addTo() {} });
  const context = vm.createContext({
    turf, Date, console, AbortController, FileReader,
    fetch: async () => ({ ok: true, json: async () => osm }),
    L: { layerGroup, polyline: () => ({}), latLngBounds: () => ({}) }
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'delta.js'), 'utf8'), context);
  let done;
  const file = { name: 'walk.geojson', content: JSON.stringify(source) };
  await context.DeltaExtractor.run(file, 4.5, 3, { fitBounds() {}, removeLayer() {} },
    (step, value) => { if (step === 'done') done = value; });
  assert.ok(done, 'the extraction should finish');
  const analysis = done.analysis;
  assert.equal(analysis.gaps.length, 1);
  assert.equal(analysis.gaps[0].type, 'unobserved');
  assert.equal(analysis.originalSegments.length, 3);
  assert.ok(analysis.osmCovered.length > 0);
  assert.ok(analysis.osmCovered.every(item => item.reason.includes('OpenStreetMap')));
  assert.ok(analysis.tooShort.length > 0);
  assert.ok(analysis.tooShort.every(item => item.reason.includes('shorter')));
  assert.ok(analysis.candidates.length > 0);
  assert.ok(analysis.summary.osmCoveredMeters > 0);
  assert.ok(analysis.summary.tooShortMeters > 0);
  assert.ok(analysis.summary.candidateMeters > 0);
  assert.equal(context.DeltaExtractor._lastAnalysis, analysis);
});
