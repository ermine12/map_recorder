/**
 * merger.js — Intelligent Shortcut Deduplication & Merging Engine
 *
 * Uses Turf.js to detect whether a newly recorded or extracted shortcut
 * duplicates or extends an existing shortcut in the user's master library.
 */

// eslint-disable-next-line no-var
var ShortcutMerger = (function () {
  'use strict';

  // Default parameters
  var DEFAULT_TOLERANCE_METERS = 5.0; // Corridor width for matching (~GPS drift)
  var MATCH_THRESHOLD_RATIO = 0.70;   // >= 70% points within corridor = duplicate

  /**
   * Calculate the percentage of vertices in lineA that fall within
   * toleranceMeters of lineB.
   *
   * @param {object} lineA  Turf/GeoJSON LineString feature or geometry
   * @param {object} lineB  Turf/GeoJSON LineString feature or geometry
   * @param {number} toleranceMeters
   * @returns {number} Ratio between 0.0 and 1.0
   */
  function calculateCorridorOverlap(lineA, lineB, toleranceMeters) {
    var coordsA = lineA.geometry ? lineA.geometry.coordinates : lineA.coordinates;
    var lineBFeature = lineB.type === 'Feature' ? lineB : turf.lineString(lineB.coordinates || lineB);

    if (!coordsA || coordsA.length === 0) return 0;

    var matchingPoints = 0;
    for (var i = 0; i < coordsA.length; i++) {
      var pt = turf.point(coordsA[i]);
      var dist = turf.pointToLineDistance(pt, lineBFeature, { units: 'meters' });
      if (dist <= toleranceMeters) {
        matchingPoints++;
      }
    }

    return matchingPoints / coordsA.length;
  }

  /**
   * Compare a candidate shortcut against an existing master shortcut.
   *
   * @param {object} candidateFeature  GeoJSON LineString Feature
   * @param {object} existingFeature   GeoJSON LineString Feature
   * @param {number} toleranceMeters
   * @returns {{ matchType: 'duplicate'|'extension'|'distinct', overlapRatio: number }}
   */
  function compareShortcuts(candidateFeature, existingFeature, toleranceMeters) {
    toleranceMeters = toleranceMeters || DEFAULT_TOLERANCE_METERS;

    // Bidirectional overlap check
    var overlapNewOnExisting = calculateCorridorOverlap(candidateFeature, existingFeature, toleranceMeters);
    var overlapExistingOnNew = calculateCorridorOverlap(existingFeature, candidateFeature, toleranceMeters);

    var maxOverlap = Math.max(overlapNewOnExisting, overlapExistingOnNew);

    if (maxOverlap >= MATCH_THRESHOLD_RATIO) {
      return { matchType: 'duplicate', overlapRatio: maxOverlap };
    } else if (maxOverlap >= 0.35) {
      return { matchType: 'extension', overlapRatio: maxOverlap };
    }

    return { matchType: 'distinct', overlapRatio: maxOverlap };
  }

  /**
   * Merge an incoming candidate shortcut into an array of existing master shortcuts.
   *
   * If a duplicate is found:
   *   - Increments `times_walked`
   *   - Updates `last_walked_at`
   *   - Keeps the trace with more detail / points (or updates to latest)
   *
   * If distinct:
   *   - Appends as a new feature with `times_walked: 1`
   *
   * @param {object[]} masterFeatures   Array of GeoJSON LineString Features
   * @param {object} newFeature         Candidate GeoJSON LineString Feature
   * @param {number} toleranceMeters    Proximity tolerance in meters
   * @returns {{
   *   updatedFeatures: object[],
   *   action: 'reinforced' | 'added',
   *   matchedFeatureName: string | null,
   *   timesWalked: number
   * }}
   */
  function mergeIntoCollection(masterFeatures, newFeature, toleranceMeters) {
    toleranceMeters = toleranceMeters || DEFAULT_TOLERANCE_METERS;
    var features = masterFeatures.slice(); // Shallow copy

    var bestMatchIndex = -1;
    var highestOverlap = 0;

    for (var i = 0; i < features.length; i++) {
      var comparison = compareShortcuts(newFeature, features[i], toleranceMeters);
      if (comparison.matchType === 'duplicate' && comparison.overlapRatio > highestOverlap) {
        highestOverlap = comparison.overlapRatio;
        bestMatchIndex = i;
      }
    }

    // Found existing shortcut that matches this walk
    if (bestMatchIndex !== -1) {
      var matched = features[bestMatchIndex];
      var oldProps = matched.properties || {};
      var newProps = newFeature.properties || {};

      var timesWalked = (oldProps.times_walked || 1) + 1;
      var now = new Date().toISOString();

      // Prefer the path with more recorded coordinate points for geometric smoothness
      var candidateCoords = newFeature.geometry.coordinates;
      var existingCoords = matched.geometry.coordinates;
      var chosenCoords = candidateCoords.length >= existingCoords.length ? candidateCoords : existingCoords;

      var lengthM = turf.length(turf.lineString(chosenCoords), { units: 'meters' });

      features[bestMatchIndex] = {
        type: 'Feature',
        geometry: {
          type: 'LineString',
          coordinates: chosenCoords
        },
        properties: Object.assign({}, oldProps, {
          name: oldProps.name || newProps.name || ('shortcut-' + (bestMatchIndex + 1)),
          times_walked: timesWalked,
          last_walked_at: now,
          created_at: oldProps.created_at || newProps.created_at || now,
          length_meters: Math.round(lengthM * 10) / 10,
          stroke: oldProps.stroke || '#22c55e', // Verified master paths styled distinctly
          'stroke-width': 4,
          'stroke-opacity': 0.95
        })
      };

      return {
        updatedFeatures: features,
        action: 'reinforced',
        matchedFeatureName: features[bestMatchIndex].properties.name,
        timesWalked: timesWalked
      };
    }

    // Completely new shortcut
    var nowStr = new Date().toISOString();
    var cleanProps = Object.assign({}, newFeature.properties, {
      name: (newFeature.properties && newFeature.properties.name) || ('shortcut-' + (features.length + 1)),
      times_walked: 1,
      created_at: nowStr,
      last_walked_at: nowStr,
      length_meters: Math.round(turf.length(newFeature, { units: 'meters' }) * 10) / 10,
      stroke: '#ff6b00',
      'stroke-width': 4,
      'stroke-opacity': 0.9
    });

    var freshFeature = {
      type: 'Feature',
      geometry: newFeature.geometry,
      properties: cleanProps
    };

    features.push(freshFeature);

    return {
      updatedFeatures: features,
      action: 'added',
      matchedFeatureName: cleanProps.name,
      timesWalked: 1
    };
  }

  /**
   * Batch merge multiple features (e.g. from an imported GeoJSON file or multi-segment delta)
   * into the master collection, eliminating duplicates along the way.
   *
   * @param {object[]} masterFeatures
   * @param {object[]} incomingFeatures
   * @param {number} toleranceMeters
   * @returns {{ updatedFeatures: object[], addedCount: number, reinforcedCount: number }}
   */
  function batchMerge(masterFeatures, incomingFeatures, toleranceMeters) {
    var current = masterFeatures.slice();
    var added = 0;
    var reinforced = 0;

    for (var i = 0; i < incomingFeatures.length; i++) {
      var feat = incomingFeatures[i];
      if (!feat || !feat.geometry || feat.geometry.type !== 'LineString') continue;

      var res = mergeIntoCollection(current, feat, toleranceMeters);
      current = res.updatedFeatures;
      if (res.action === 'added') {
        added++;
      } else {
        reinforced++;
      }
    }

    return {
      updatedFeatures: current,
      addedCount: added,
      reinforcedCount: reinforced
    };
  }

  return {
    compareShortcuts: compareShortcuts,
    mergeIntoCollection: mergeIntoCollection,
    batchMerge: batchMerge,
    DEFAULT_TOLERANCE_METERS: DEFAULT_TOLERANCE_METERS
  };
})();
