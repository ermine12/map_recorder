const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const context = vm.createContext({ Math, Number, Array, Date });
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'merger.js'), 'utf8'), context);
const merger = context.ShortcutMerger;
const degrees = metres => metres / 111195.08;
const point = (x, y = 0) => [degrees(x), degrees(y)];
const feature = (coords, source_id) => ({
  type: 'Feature',
  geometry: { type: 'LineString', coordinates: coords.map(([x, y]) => point(x, y)) },
  properties: source_id ? { source_id } : {}
});
const lineLength = coords => coords.slice(1).reduce((sum, p, i) => {
  const prev = coords[i];
  return sum + Math.hypot((p[0] - prev[0]) * 111195.08, (p[1] - prev[1]) * 111195.08);
}, 0);

const oldPath = feature([[0, 0], [50, 0], [100, 0]], 'walk-old');
const extension = feature([[0, 0], [200, 0]], 'walk-new');
const extended = merger.mergeIntoCollection([oldPath], extension, 2);
assert.equal(extended.action, 'added');
assert.equal(extended.addedCount, 1);
assert.equal(extended.updatedFeatures.length, 2);
assert.deepEqual(extended.updatedFeatures[0].geometry.coordinates, oldPath.geometry.coordinates);
assert(lineLength(extended.updatedFeatures[1].geometry.coordinates) > 95);
assert(lineLength(extended.updatedFeatures[1].geometry.coordinates) < 101);

const denseSubset = feature([[25, 0], [35, 0], [45, 0], [55, 0], [65, 0]], 'walk-subset');
const subsetResult = merger.mergeIntoCollection([oldPath], denseSubset, 2);
assert.equal(subsetResult.addedCount, 0);
assert.deepEqual(subsetResult.updatedFeatures[0].geometry.coordinates, oldPath.geometry.coordinates);

const crossing = feature([[50, -50], [50, 50]], 'walk-crossing');
const crossingNovel = merger.getNovelSegments(crossing, [oldPath], 5);
assert.equal(crossingNovel.length, 1);
assert(lineLength(crossingNovel[0].geometry.coordinates) > 99);

const first = merger.batchMerge([], [oldPath], 5);
const again = merger.batchMerge(first.updatedFeatures, [oldPath], 5);
assert.equal(again.addedCount, 0);
assert.equal(again.reinforcedCount, 0);
assert.equal(again.unchangedCount, 1);
assert.equal(again.updatedFeatures[0].properties.times_walked, 1);

const secondWalk = feature([[0, 0], [100, 0]], 'walk-second');
const reinforced = merger.batchMerge(first.updatedFeatures, [secondWalk], 5);
assert.equal(reinforced.reinforcedCount, 1);
assert.equal(reinforced.updatedFeatures[0].properties.times_walked, 2);
assert.deepEqual(Array.from(reinforced.updatedFeatures[0].properties.source_ids), ['walk-old', 'walk-second']);

const restored = merger.batchMerge([], reinforced.updatedFeatures, 5);
assert.equal(restored.updatedFeatures[0].properties.path_id, reinforced.updatedFeatures[0].properties.path_id);
assert.equal(restored.updatedFeatures[0].properties.times_walked, 2);

console.log('merger tests passed');
