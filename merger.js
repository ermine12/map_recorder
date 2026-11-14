/**
 * Keep surveyed geometry that is not already in the approved shortcut layer.
 * Input is GeoJSON in [longitude, latitude] order. Distances are in metres.
 * Existing approved geometry is never replaced by a new GPS trace.
 */
// eslint-disable-next-line no-var
var ShortcutMerger = (function () {
  'use strict';

  var DEFAULT_TOLERANCE_METERS = 5;
  var SAMPLE_METERS = 2;
  var MIN_NEW_METERS = 3;
  var METERS_PER_DEGREE = 111195.08;
  var MIN_DIRECTION_COSINE = Math.cos(Math.PI / 4);

  function coordinatesOf(feature) {
    var geometry = feature && (feature.geometry || feature);
    return geometry && geometry.type === 'LineString' && Array.isArray(geometry.coordinates)
      ? geometry.coordinates : [];
  }

  function validPoint(point) {
    return Array.isArray(point) && point.length >= 2 &&
      Number.isFinite(point[0]) && Number.isFinite(point[1]) &&
      Math.abs(point[0]) <= 180 && Math.abs(point[1]) <= 90;
  }

  function metreScale(latitude) {
    return [METERS_PER_DEGREE * Math.cos(latitude * Math.PI / 180), METERS_PER_DEGREE];
  }

  function distance(a, b) {
    var scale = metreScale((a[1] + b[1]) / 2);
    return Math.hypot((a[0] - b[0]) * scale[0], (a[1] - b[1]) * scale[1]);
  }

  function lineLength(coords) {
    var total = 0;
    for (var i = 1; i < coords.length; i++) total += distance(coords[i - 1], coords[i]);
    return total;
  }

  function interpolate(a, b, fraction) {
    return [a[0] + (b[0] - a[0]) * fraction, a[1] + (b[1] - a[1]) * fraction];
  }

  function hashString(value) {
    var hash = 2166136261;
    for (var i = 0; i < value.length; i++) {
      hash ^= value.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
  }

  function geometryKey(coords) {
    var forward = coords.map(function (p) { return p[0].toFixed(7) + ',' + p[1].toFixed(7); }).join(';');
    var reverse = coords.slice().reverse().map(function (p) { return p[0].toFixed(7) + ',' + p[1].toFixed(7); }).join(';');
    return hashString(forward < reverse ? forward : reverse);
  }

  function sourceId(feature) {
    var props = feature.properties || {};
    var source = props.source_id || props.recording_id || props.track_id;
    return source ? String(source) : 'geometry:' + geometryKey(coordinatesOf(feature));
  }

  function existingSegments(features) {
    var segments = [];
    for (var i = 0; i < features.length; i++) {
      var coords = coordinatesOf(features[i]);
      for (var j = 1; j < coords.length; j++) {
        if (validPoint(coords[j - 1]) && validPoint(coords[j]) && distance(coords[j - 1], coords[j]) > 0.05) {
          segments.push({ a: coords[j - 1], b: coords[j], featureIndex: i });
        }
      }
    }
    return segments;
  }

  // Project only the nearby edges into a local metre coordinate system.
  // Parallel lines can overlap; ordinary perpendicular crossings cannot.
  function matchingFeature(point, headingA, headingB, existing, tolerance) {
    var scale = metreScale(point[1]);
    var dx = (headingB[0] - headingA[0]) * scale[0];
    var dy = (headingB[1] - headingA[1]) * scale[1];
    var headingLength = Math.hypot(dx, dy);
    var best = -1;
    var bestDistance = tolerance + 1;
    for (var i = 0; i < existing.length; i++) {
      var edge = existing[i];
      var ax = (edge.a[0] - point[0]) * scale[0];
      var ay = (edge.a[1] - point[1]) * scale[1];
      var bx = (edge.b[0] - point[0]) * scale[0];
      var by = (edge.b[1] - point[1]) * scale[1];
      if (Math.min(ax, bx) > tolerance || Math.max(ax, bx) < -tolerance ||
          Math.min(ay, by) > tolerance || Math.max(ay, by) < -tolerance) continue;
      var ex = bx - ax;
      var ey = by - ay;
      var edgeLengthSquared = ex * ex + ey * ey;
      if (edgeLengthSquared < 0.0025 || headingLength < 0.05) continue;
      if (Math.abs(dx * ex + dy * ey) / (headingLength * Math.sqrt(edgeLengthSquared)) < MIN_DIRECTION_COSINE) continue;
      var fraction = Math.max(0, Math.min(1, -(ax * ex + ay * ey) / edgeLengthSquared));
      var separation = Math.hypot(ax + fraction * ex, ay + fraction * ey);
      if (separation <= tolerance && separation < bestDistance) {
        best = edge.featureIndex;
        bestDistance = separation;
      }
    }
    return best;
  }

  function splitOutside(candidate, master, tolerance) {
    var coords = coordinatesOf(candidate);
    var existing = existingSegments(master);
    var pieces = [];
    var matchedMetres = new Array(master.length).fill(0);
    var active = null;

    function pushPoint(point) {
      if (!active) active = [];
      if (!active.length || distance(active[active.length - 1], point) > 0.05) active.push(point);
    }
    function finish() {
      if (active && active.length >= 2 && lineLength(active) >= MIN_NEW_METERS) pieces.push(active);
      active = null;
    }

    if (coords.length < 2 || !coords.every(validPoint)) return { pieces: [], matchedMetres: matchedMetres };
    if (!existing.length) {
      return {
        pieces: lineLength(coords) >= MIN_NEW_METERS ? [coords.map(function (point) { return [point[0], point[1]]; })] : [],
        matchedMetres: matchedMetres
      };
    }
    for (var i = 1; i < coords.length; i++) {
      var a = coords[i - 1];
      var b = coords[i];
      var legLength = distance(a, b);
      if (legLength < 0.05) continue;
      var steps = Math.max(1, Math.ceil(legLength / SAMPLE_METERS));
      for (var j = 1; j <= steps; j++) {
        var from = interpolate(a, b, (j - 1) / steps);
        var to = interpolate(a, b, j / steps);
        var matchFrom = matchingFeature(from, a, b, existing, tolerance);
        var matchTo = matchingFeature(to, a, b, existing, tolerance);
        if (matchFrom >= 0 && matchTo >= 0) {
          matchedMetres[matchFrom] += distance(from, to);
          finish();
        } else if (matchFrom < 0 && matchTo < 0) {
          pushPoint(from);
          pushPoint(to);
        } else {
          var low = 0;
          var high = 1;
          for (var k = 0; k < 8; k++) {
            var middle = (low + high) / 2;
            var isMatched = matchingFeature(interpolate(from, to, middle), a, b, existing, tolerance) >= 0;
            if (isMatched === (matchFrom >= 0)) low = middle;
            else high = middle;
          }
          var boundary = interpolate(from, to, (low + high) / 2);
          if (matchFrom < 0) {
            pushPoint(from);
            pushPoint(boundary);
            finish();
          } else {
            pushPoint(boundary);
            pushPoint(to);
          }
          if (matchFrom >= 0) matchedMetres[matchFrom] += distance(from, boundary);
          else if (matchTo >= 0) matchedMetres[matchTo] += distance(boundary, to);
        }
      }
    }
    finish();
    return { pieces: pieces, matchedMetres: matchedMetres };
  }

  function createNovelFeatures(candidate, pieces) {
    var now = new Date().toISOString();
    var sourceProps = candidate.properties || {};
    var source = sourceId(candidate);
    var original = coordinatesOf(candidate);
    return pieces.map(function (coords, index) {
      // A wholly new approved path being restored from an export keeps its
      // identity and its recorded source history.
      if (pieces.length === 1 && sourceProps.path_id && Array.isArray(sourceProps.source_ids) &&
          Math.abs(lineLength(coords) - lineLength(original)) < 0.1 &&
          distance(coords[0], original[0]) < 0.1 &&
          distance(coords[coords.length - 1], original[original.length - 1]) < 0.1) {
        return {
          type: 'Feature',
          geometry: { type: 'LineString', coordinates: original.map(function (point) { return [point[0], point[1]]; }) },
          properties: Object.assign({}, sourceProps)
        };
      }
      var id = 'path-' + hashString(source + ':' + index + ':' + geometryKey(coords));
      var props = Object.assign({}, sourceProps, {
        path_id: id,
        name: sourceProps.name || id,
        created_at: sourceProps.created_at || now,
        last_walked_at: now,
        source_ids: [source],
        times_walked: 1,
        length_meters: Math.round(lineLength(coords) * 10) / 10,
        stroke: '#ff6b00',
        'stroke-width': 4,
        'stroke-opacity': 0.9
      });
      // Clipped geometry no longer has a one-to-one relationship with raw observations.
      delete props.coordTimes;
      return { type: 'Feature', geometry: { type: 'LineString', coordinates: coords }, properties: props };
    });
  }

  function getNovelSegments(candidateFeature, masterFeatures, toleranceMeters) {
    var tolerance = Number.isFinite(toleranceMeters) && toleranceMeters > 0 ? toleranceMeters : DEFAULT_TOLERANCE_METERS;
    return createNovelFeatures(candidateFeature, splitOutside(candidateFeature, masterFeatures || [], tolerance).pieces);
  }

  function compareShortcuts(candidateFeature, existingFeature, toleranceMeters) {
    var coords = coordinatesOf(candidateFeature);
    var total = lineLength(coords);
    if (!total) return { matchType: 'distinct', overlapRatio: 0 };
    var novel = getNovelSegments(candidateFeature, [existingFeature], toleranceMeters);
    var novelLength = novel.reduce(function (sum, feature) { return sum + lineLength(feature.geometry.coordinates); }, 0);
    var overlapRatio = Math.max(0, Math.min(1, 1 - novelLength / total));
    return {
      matchType: novelLength < MIN_NEW_METERS ? 'duplicate' : overlapRatio > 0.02 ? 'extension' : 'distinct',
      overlapRatio: overlapRatio
    };
  }

  function mergeIntoCollection(masterFeatures, newFeature, toleranceMeters) {
    var features = (masterFeatures || []).slice();
    var tolerance = Number.isFinite(toleranceMeters) && toleranceMeters > 0 ? toleranceMeters : DEFAULT_TOLERANCE_METERS;
    var result = splitOutside(newFeature, features, tolerance);
    var novel = createNovelFeatures(newFeature, result.pieces);
    var source = sourceId(newFeature);
    var matchedName = null;
    var timesWalked = 0;
    var reinforcedCount = 0;
    var now = new Date().toISOString();

    for (var i = 0; i < features.length; i++) {
      if (result.matchedMetres[i] < MIN_NEW_METERS) continue;
      var old = features[i];
      var props = old.properties || {};
      var sources = Array.isArray(props.source_ids) ? props.source_ids.slice() : [];
      var explicitSource = (newFeature.properties || {}).source_id;
      var exactReimport = !explicitSource && geometryKey(coordinatesOf(old)) === geometryKey(coordinatesOf(newFeature));
      if (sources.includes(source) || (props.source_id && props.source_id === source) || exactReimport) continue;
      sources.push(source);
      var walks = Math.max(1, Number(props.times_walked) || 1) + 1;
      features[i] = {
        type: 'Feature',
        geometry: old.geometry,
        properties: Object.assign({}, props, {
          path_id: props.path_id || 'path-' + geometryKey(coordinatesOf(old)),
          source_ids: sources,
          times_walked: walks,
          last_walked_at: now
        })
      };
      reinforcedCount++;
      if (!matchedName) matchedName = props.name || props.path_id || null;
      timesWalked = walks;
    }

    Array.prototype.push.apply(features, novel);
    if (novel.length) {
      matchedName = novel[0].properties.name;
      timesWalked = 1;
    }
    return {
      updatedFeatures: features,
      action: novel.length ? 'added' : reinforcedCount ? 'reinforced' : 'unchanged',
      addedCount: novel.length,
      reinforcedCount: reinforcedCount,
      unchangedCount: !novel.length && !reinforcedCount ? 1 : 0,
      matchedFeatureName: matchedName,
      timesWalked: timesWalked
    };
  }

  function batchMerge(masterFeatures, incomingFeatures, toleranceMeters) {
    var current = (masterFeatures || []).slice();
    var added = 0;
    var reinforced = 0;
    var unchanged = 0;
    for (var i = 0; i < incomingFeatures.length; i++) {
      var feature = incomingFeatures[i];
      if (!feature || !feature.geometry || feature.geometry.type !== 'LineString') continue;
      var result = mergeIntoCollection(current, feature, toleranceMeters);
      current = result.updatedFeatures;
      added += result.addedCount;
      reinforced += result.reinforcedCount;
      unchanged += result.unchangedCount;
    }
    return { updatedFeatures: current, addedCount: added, reinforcedCount: reinforced, unchangedCount: unchanged };
  }

  return {
    compareShortcuts: compareShortcuts,
    getNovelSegments: getNovelSegments,
    mergeIntoCollection: mergeIntoCollection,
    batchMerge: batchMerge,
    DEFAULT_TOLERANCE_METERS: DEFAULT_TOLERANCE_METERS
  };
})();
