/**
 * master.js — Master Shortcuts Layer Manager
 *
 * Persists deduplicated shortcuts in browser localStorage (zero-cost, no DB).
 * Renders master shortcuts onto the Leaflet map and supports clean import/export.
 */

// eslint-disable-next-line no-var
var MasterLayerManager = (function () {
  'use strict';

  var STORAGE_KEY = 'shortcut_recorder_master_shortcuts_v1';
  var _layerGroup = null;
  var _map = null;
  var _isVisible = true;

  /**
   * Load master FeatureCollection from localStorage.
   * @returns {{ type: 'FeatureCollection', features: object[] }}
   */
  function loadMasterCollection() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        var parsed = JSON.parse(raw);
        if (parsed && parsed.type === 'FeatureCollection' && Array.isArray(parsed.features)) {
          return parsed;
        }
      }
    } catch (e) {
      console.warn('[MasterLayer] Failed to load from localStorage:', e);
    }

    return {
      type: 'FeatureCollection',
      features: []
    };
  }

  /**
   * Save master FeatureCollection to localStorage.
   * @param {object} collection
   */
  function saveMasterCollection(collection) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(collection));
    } catch (e) {
      console.error('[MasterLayer] Failed to save to localStorage:', e);
      throw new Error('Browser storage is full or unavailable. Export a backup and try again.');
    }
  }

  /**
   * Add a single shortcut feature to the master collection with intelligent deduplication.
   *
   * @param {object} feature  GeoJSON LineString Feature
   * @param {number} toleranceMeters
   * @returns {{ action: string, name: string, timesWalked: number, totalShortcuts: number }}
   */
  function addShortcut(feature, toleranceMeters) {
    var collection = loadMasterCollection();
    var result = ShortcutMerger.mergeIntoCollection(collection.features, feature, toleranceMeters);

    collection.features = result.updatedFeatures;
    saveMasterCollection(collection);

    if (_map && _isVisible) {
      renderOnMap(_map);
    }

    return {
      action: result.action,
      name: result.matchedFeatureName,
      timesWalked: result.timesWalked,
      totalShortcuts: collection.features.length
    };
  }

  /**
   * Import an external GeoJSON file or FeatureCollection into the master collection,
   * automatically deduplicating all overlapping features against existing records.
   *
   * @param {object} incomingGeoJSON
   * @param {number} toleranceMeters
   * @returns {{ addedCount: number, reinforcedCount: number, totalShortcuts: number }}
   */
  function importGeoJSON(incomingGeoJSON, toleranceMeters) {
    var collection = loadMasterCollection();
    var incomingFeatures = [];

    if (incomingGeoJSON.type === 'FeatureCollection' && Array.isArray(incomingGeoJSON.features)) {
      incomingFeatures = incomingGeoJSON.features;
    } else if (incomingGeoJSON.type === 'Feature') {
      incomingFeatures = [incomingGeoJSON];
    } else if (incomingGeoJSON.type === 'LineString') {
      incomingFeatures = [{
        type: 'Feature',
        geometry: incomingGeoJSON,
        properties: {}
      }];
    }

    var result = ShortcutMerger.batchMerge(collection.features, incomingFeatures, toleranceMeters);
    collection.features = result.updatedFeatures;
    saveMasterCollection(collection);

    if (_map && _isVisible) {
      renderOnMap(_map);
    }

    return {
      addedCount: result.addedCount,
      reinforcedCount: result.reinforcedCount,
      unchangedCount: result.unchangedCount,
      totalShortcuts: collection.features.length
    };
  }

  /**
   * Compute aggregated statistics for the master library.
   * @returns {{ totalShortcuts: number, totalDistanceMeters: number, totalWalks: number }}
   */
  function getStats() {
    var collection = loadMasterCollection();
    var totalDist = 0;
    var sources = new Set();

    for (var i = 0; i < collection.features.length; i++) {
      var feat = collection.features[i];
      if (feat && feat.geometry && feat.geometry.coordinates) {
        try {
          var len = turf.length(feat, { units: 'meters' });
          totalDist += len;
        } catch (e) {}
      }
      var props = feat.properties || {};
      (Array.isArray(props.source_ids) ? props.source_ids : []).forEach(function (id) { sources.add(id); });
    }

    return {
      totalShortcuts: collection.features.length,
      totalDistanceMeters: Math.round(totalDist),
      totalWalks: sources.size || null
    };
  }

  /**
   * Render all master shortcuts as a styled Leaflet layer group.
   * Shortcuts with multiple walks appear with stronger, glowing green styling.
   *
   * @param {L.Map} map
   */
  function renderOnMap(map) {
    _map = map;
    if (_layerGroup) {
      _layerGroup.clearLayers();
    } else {
      _layerGroup = L.layerGroup();
      _layerGroup.addTo(map);
    }

    if (!_isVisible) return;

    var collection = loadMasterCollection();
    for (var i = 0; i < collection.features.length; i++) {
      var feat = collection.features[i];
      if (!feat.geometry || !feat.geometry.coordinates) continue;

      var coords = feat.geometry.coordinates.map(function (c) {
        return [c[1], c[0]]; // [lat, lng]
      });

      var props = feat.properties || {};
      var walks = props.times_walked || 1;

      // Color coding: 1 walk = orange, 2+ walks = verified emerald green
      var color = walks > 1 ? '#10b981' : '#f59e0b';
      var weight = walks > 2 ? 6 : (walks > 1 ? 5 : 4);

      var polyline = L.polyline(coords, {
        color: color,
        weight: weight,
        opacity: 0.85,
        lineCap: 'round',
        lineJoin: 'round'
      });

      var popup = document.createElement('div');
      var title = document.createElement('strong');
      title.textContent = props.name || 'Shortcut';
      popup.appendChild(title);
      var info = document.createElement('div');
      info.textContent = 'Length: ' + (props.length_meters || Math.round(turf.length(feat, { units: 'meters' }))) + ' m';
      popup.appendChild(info);
      var observed = document.createElement('div');
      observed.textContent = 'Source observations: ' + walks;
      popup.appendChild(observed);
      polyline.bindPopup(popup);
      _layerGroup.addLayer(polyline);
    }
  }

  /**
   * Toggle visibility of master layer on Leaflet map.
   * @param {boolean} visible
   */
  function setVisibility(visible) {
    _isVisible = visible;
    if (_layerGroup && _map) {
      if (visible) {
        renderOnMap(_map);
      } else {
        _layerGroup.clearLayers();
      }
    }
  }

  /**
   * Trigger download of the master GeoJSON file.
   */
  function exportMasterGeoJSON() {
    var collection = loadMasterCollection();
    if (collection.features.length === 0) {
      return false;
    }

    var jsonStr = JSON.stringify(collection, null, 2);
    var blob = new Blob([jsonStr], { type: 'application/geo+json' });
    var url = URL.createObjectURL(blob);

    var now = new Date();
    var ts = now.toISOString().slice(0, 10);
    var filename = 'master-shortcuts-' + ts + '.geojson';

    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();

    setTimeout(function () {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 100);

    return true;
  }

  /**
   * Clear all master shortcuts.
   */
  function clearAll() {
    localStorage.removeItem(STORAGE_KEY);
    if (_layerGroup) {
      _layerGroup.clearLayers();
    }
  }

  return {
    loadMasterCollection: loadMasterCollection,
    addShortcut: addShortcut,
    importGeoJSON: importGeoJSON,
    getStats: getStats,
    renderOnMap: renderOnMap,
    setVisibility: setVisibility,
    exportMasterGeoJSON: exportMasterGeoJSON,
    clearAll: clearAll
  };
})();
