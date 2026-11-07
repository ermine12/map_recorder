/**
 * delta.js — Delta Extractor Module
 *
 * Standalone browser module that compares a user-uploaded GPX track against
 * existing OpenStreetMap roads (via Overpass API) and extracts the segments
 * of the track that do NOT overlap with known roads — the "new shortcuts."
 *
 * Dependencies (global):
 *   - turf   (Turf.js, loaded from CDN)
 *   - L      (Leaflet)
 *   - showToast()   (app utility)
 *   - state.map     (app Leaflet map reference)
 */

// eslint-disable-next-line no-var
var DeltaExtractor = (function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Internal state
  // ---------------------------------------------------------------------------

  /** @type {L.Layer[]} Layers currently rendered on the map */
  var _layers = [];

  /** @type {object|null} Last computed GeoJSON result */
  var _lastResult = null;

  // ---------------------------------------------------------------------------
  // 1. parseGPX
  // ---------------------------------------------------------------------------

  /**
   * Parse a GPX XML string and extract track coordinates + bounding box.
   *
   * Multi-segment GPX files are supported: all <trkseg> elements across all
   * <trk> elements are concatenated into a single coordinate array.
   *
   * @param {string} xmlString  Raw GPX XML content.
   * @returns {{ coords: number[][], bbox: { north: number, south: number, east: number, west: number } }}
   */
  function parseGPX(xmlString) {
    var parser = new DOMParser();
    var doc = parser.parseFromString(xmlString, 'application/xml');

    // Check for parse errors
    var parseError = doc.querySelector('parsererror');
    if (parseError) {
      throw new Error('Invalid GPX file: ' + parseError.textContent);
    }

    var coords = [];
    var segments = doc.querySelectorAll('trkseg');

    if (segments.length === 0) {
      throw new Error('GPX file contains no track segments (<trkseg>).');
    }

    for (var s = 0; s < segments.length; s++) {
      var trkpts = segments[s].querySelectorAll('trkpt');
      for (var p = 0; p < trkpts.length; p++) {
        var lat = parseFloat(trkpts[p].getAttribute('lat'));
        var lon = parseFloat(trkpts[p].getAttribute('lon'));
        if (!isNaN(lat) && !isNaN(lon)) {
          coords.push([lon, lat]); // [lng, lat] — GeoJSON order
        }
      }
    }

    if (coords.length === 0) {
      throw new Error('GPX file contains no valid track points.');
    }

    // Compute bounding box
    var north = -Infinity, south = Infinity, east = -Infinity, west = Infinity;
    for (var i = 0; i < coords.length; i++) {
      var lng = coords[i][0];
      var lat2 = coords[i][1];
      if (lat2 > north) north = lat2;
      if (lat2 < south) south = lat2;
      if (lng > east) east = lng;
      if (lng < west) west = lng;
    }

    return {
      coords: coords,
      bbox: { north: north, south: south, east: east, west: west }
    };
  }

  // ---------------------------------------------------------------------------
  // 2. fetchOSMRoads
  // ---------------------------------------------------------------------------

  /**
   * Fetch all highway ways from OpenStreetMap within the given bounding box
   * using the Overpass API.
   *
   * @param {{ north: number, south: number, east: number, west: number }} bbox
   * @returns {Promise<number[][][]>}  Array of road LineStrings, each an array of [lng, lat].
   */
  function fetchOSMRoads(bbox) {
    // Add ~0.001° padding so edge roads are included
    var pad = 0.001;
    var south = bbox.south - pad;
    var west = bbox.west - pad;
    var north = bbox.north + pad;
    var east = bbox.east + pad;

    var query =
      '[out:json][timeout:30];\n' +
      '(\n' +
      '  way["highway"](' + south + ',' + west + ',' + north + ',' + east + ');\n' +
      ');\n' +
      'out body;\n' +
      '>;\n' +
      'out skel qt;';

    var servers = [
      'https://overpass-api.de/api/interpreter',
      'https://overpass.kumi.systems/api/interpreter',
      'https://maps.mail.ru/osm/tools/overpass/api/interpreter'
    ];

    function tryServer(index) {
      if (index >= servers.length) {
        return Promise.reject(new Error('All Overpass API servers failed or timed out. Please check your internet connection.'));
      }
      return fetch(servers[index], {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'data=' + encodeURIComponent(query)
      })
        .then(function (response) {
          if (!response.ok) {
            return tryServer(index + 1);
          }
          return response.json();
        })
        .catch(function () {
          return tryServer(index + 1);
        });
    }

    return tryServer(0)
      .then(function (data) {
        // Build a lookup map:  nodeId → [lng, lat]
        var nodeLookup = {};
        var elements = data.elements || [];
        for (var i = 0; i < elements.length; i++) {
          var el = elements[i];
          if (el.type === 'node') {
            nodeLookup[el.id] = [el.lon, el.lat];
          }
        }

        // Resolve each way's node refs to coordinate arrays
        var roads = [];
        for (var j = 0; j < elements.length; j++) {
          var way = elements[j];
          if (way.type !== 'way' || !way.nodes) continue;

          var roadCoords = [];
          for (var k = 0; k < way.nodes.length; k++) {
            var coord = nodeLookup[way.nodes[k]];
            if (coord) {
              roadCoords.push(coord);
            }
          }

          // A valid LineString needs at least 2 points
          if (roadCoords.length >= 2) {
            roads.push(roadCoords);
          }
        }

        return roads;
      });
  }

  // ---------------------------------------------------------------------------
  // 3. extractShortcuts
  // ---------------------------------------------------------------------------

  /**
   * Compare every point in the GPX track against the set of OSM roads and
   * extract consecutive off-road segments that exceed a minimum length.
   *
   * @param {number[][]} trackCoords         Array of [lng, lat] from GPX.
   * @param {number[][][]} roadCoordArrays   Array of road LineStrings from OSM.
   * @param {number} bufferMeters            Distance threshold (meters). Points
   *                                         closer than this to any road are "on-road".
   * @param {number} minLengthMeters         Minimum segment length to keep.
   * @returns {number[][][]}  Array of shortcut LineString coordinate arrays.
   */
  function extractShortcuts(trackCoords, roadCoordArrays, bufferMeters, minLengthMeters) {
    // Pre-compute rough bounding boxes for each road for fast rejection
    var roadBboxes = [];
    var roadLines = [];
    for (var r = 0; r < roadCoordArrays.length; r++) {
      var rc = roadCoordArrays[r];
      var rNorth = -Infinity, rSouth = Infinity, rEast = -Infinity, rWest = Infinity;
      for (var n = 0; n < rc.length; n++) {
        if (rc[n][1] > rNorth) rNorth = rc[n][1];
        if (rc[n][1] < rSouth) rSouth = rc[n][1];
        if (rc[n][0] > rEast) rEast = rc[n][0];
        if (rc[n][0] < rWest) rWest = rc[n][0];
      }
      // Expand bbox by a rough degree equivalent of bufferMeters (~111,000 m per degree)
      var degBuffer = bufferMeters / 111000;
      roadBboxes.push({
        north: rNorth + degBuffer,
        south: rSouth - degBuffer,
        east: rEast + degBuffer,
        west: rWest - degBuffer
      });
      roadLines.push(turf.lineString(rc));
    }

    // Classify each track point as on-road or off-road
    var offRoadFlags = new Array(trackCoords.length);
    for (var i = 0; i < trackCoords.length; i++) {
      var pt = turf.point(trackCoords[i]);
      var lng = trackCoords[i][0];
      var lat = trackCoords[i][1];
      var isOnRoad = false;

      for (var j = 0; j < roadLines.length; j++) {
        // Quick bbox rejection
        var rb = roadBboxes[j];
        if (lat < rb.south || lat > rb.north || lng < rb.west || lng > rb.east) {
          continue;
        }
        // Precise distance check
        var dist = turf.pointToLineDistance(pt, roadLines[j], { units: 'meters' });
        if (dist <= bufferMeters) {
          isOnRoad = true;
          break;
        }
      }

      offRoadFlags[i] = !isOnRoad;
    }

    // Group consecutive off-road points into segments
    var segments = [];
    var currentSegment = null;
    for (var k = 0; k < offRoadFlags.length; k++) {
      if (offRoadFlags[k]) {
        if (!currentSegment) {
          currentSegment = [];
        }
        currentSegment.push(trackCoords[k]);
      } else {
        if (currentSegment && currentSegment.length >= 2) {
          segments.push(currentSegment);
        }
        currentSegment = null;
      }
    }
    // Don't forget the last segment
    if (currentSegment && currentSegment.length >= 2) {
      segments.push(currentSegment);
    }

    // Filter by minimum length
    var result = [];
    for (var m = 0; m < segments.length; m++) {
      var line = turf.lineString(segments[m]);
      var lengthM = turf.length(line, { units: 'meters' });
      if (lengthM >= minLengthMeters) {
        result.push(segments[m]);
      }
    }

    return result;
  }

  // ---------------------------------------------------------------------------
  // 4. buildGeoJSON
  // ---------------------------------------------------------------------------

  /**
   * Build a GeoJSON FeatureCollection from the extracted shortcut segments.
   *
   * @param {number[][][]} shortcutSegments  Array of LineString coordinate arrays.
   * @param {number} bufferMeters            Buffer distance used during extraction.
   * @returns {object}  GeoJSON FeatureCollection.
   */
  function buildGeoJSON(shortcutSegments, bufferMeters) {
    var now = new Date().toISOString();
    var features = [];

    for (var i = 0; i < shortcutSegments.length; i++) {
      var coords = shortcutSegments[i];
      var line = turf.lineString(coords);
      var lengthM = turf.length(line, { units: 'meters' });

      features.push({
        type: 'Feature',
        geometry: {
          type: 'LineString',
          coordinates: coords
        },
        properties: {
          name: 'shortcut-delta-' + (i + 1),
          source: 'GPX + OSM Delta Extractor',
          created_at: now,
          stroke: '#E51B23',
          'stroke-width': 4,
          'stroke-opacity': 0.9,
          buffer_meters: bufferMeters,
          length_meters: Math.round(lengthM * 100) / 100
        }
      });
    }

    return {
      type: 'FeatureCollection',
      features: features
    };
  }

  // ---------------------------------------------------------------------------
  // 5. downloadGeoJSON
  // ---------------------------------------------------------------------------

  /**
   * Trigger a browser download of the GeoJSON object as a .geojson file.
   *
   * @param {object} geojson  A GeoJSON FeatureCollection.
   */
  function downloadGeoJSON(geojson) {
    if (!geojson) return;
    var data = geojson.geojson || geojson;
    var jsonStr = JSON.stringify(data, null, 2);
    var blob = new Blob([jsonStr], { type: 'application/geo+json' });
    var url = URL.createObjectURL(blob);

    // Build filename with ISO-ish timestamp (colons replaced for filesystem safety)
    var now = new Date();
    var ts = now.toISOString().replace(/:/g, '-').replace(/\.\d+Z$/, '');
    var filename = 'delta-shortcuts-' + ts + '.geojson';

    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();

    // Cleanup
    setTimeout(function () {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 100);
  }

  // ---------------------------------------------------------------------------
  // 6. displayOnMap
  // ---------------------------------------------------------------------------

  /**
   * Render OSM roads and shortcut segments on a Leaflet map.
   *
   * @param {L.Map} map                      Leaflet map instance.
   * @param {number[][][]} shortcutSegments  Shortcut LineString coordinate arrays.
   * @param {number[][][]} roadCoordArrays   OSM road LineString coordinate arrays.
   * @returns {L.LayerGroup}  The layer group containing all added layers.
   */
  function displayOnMap(map, shortcutSegments, roadCoordArrays) {
    // Clear any previous delta layers first
    clearMapLayers(map);

    var group = L.layerGroup();

    // OSM roads — thin blue dashed lines
    for (var r = 0; r < roadCoordArrays.length; r++) {
      // Convert [lng, lat] → [lat, lng] for Leaflet
      var roadLatLngs = roadCoordArrays[r].map(function (c) {
        return [c[1], c[0]];
      });
      var roadLine = L.polyline(roadLatLngs, {
        weight: 2,
        color: '#4285F4',
        dashArray: '6 4',
        opacity: 0.5
      });
      group.addLayer(roadLine);
    }

    // Shortcut segments — thick orange lines
    var allBounds = [];
    for (var s = 0; s < shortcutSegments.length; s++) {
      var segLatLngs = shortcutSegments[s].map(function (c) {
        return [c[1], c[0]];
      });
      var segLine = L.polyline(segLatLngs, {
        weight: 5,
        color: '#ff6b00',
        opacity: 0.9
      });
      group.addLayer(segLine);

      // Accumulate bounds for fitting
      for (var b = 0; b < segLatLngs.length; b++) {
        allBounds.push(segLatLngs[b]);
      }
    }

    group.addTo(map);
    _layers.push(group);

    // Fit map to show all shortcuts (if any)
    if (allBounds.length > 0) {
      map.fitBounds(L.latLngBounds(allBounds), { padding: [40, 40] });
    }

    return group;
  }

  // ---------------------------------------------------------------------------
  // 7. clearMapLayers
  // ---------------------------------------------------------------------------

  /**
   * Remove all delta-related layers from the map.
   */
  function clearMapLayers(map) {
    for (var i = 0; i < _layers.length; i++) {
      if (_layers[i]) {
        if (map && typeof map.removeLayer === 'function') {
          map.removeLayer(_layers[i]);
        } else if (typeof _layers[i].remove === 'function') {
          _layers[i].remove();
        }
      }
    }
    _layers = [];
  }

  // ---------------------------------------------------------------------------
  // 8. run  (main orchestrator)
  // ---------------------------------------------------------------------------

  /**
   * Full pipeline: read GPX file → fetch OSM roads → extract shortcuts →
   * display on map → build GeoJSON.
   *
   * @param {File}     file             File object from <input type="file">.
   * @param {number}   bufferMeters     Distance threshold for on/off-road classification.
   * @param {number}   minLengthMeters  Minimum shortcut segment length to keep.
   * @param {L.Map}    map              Leaflet map instance.
   * @param {function} onProgress       Callback: onProgress(step, message).
   */
  function run(file, bufferMeters, minLengthMeters, map, onProgress) {
    // Default callback to no-op if not provided
    if (typeof onProgress !== 'function') {
      onProgress = function () {};
    }

    // Step 1 — Read file as text
    var reader = new FileReader();

    reader.onerror = function () {
      onProgress('error', 'Failed to read the GPX file.');
    };

    reader.onload = function (e) {
      try {
        var xmlString = e.target.result;

        // Step 2 — Parse GPX
        var parsed = parseGPX(xmlString);
        onProgress('parse', 'GPX parsed: ' + parsed.coords.length + ' points');

        // Step 3 — Fetch OSM roads (async)
        fetchOSMRoads(parsed.bbox)
          .then(function (roadCoordArrays) {
            onProgress('fetch', 'Fetched ' + roadCoordArrays.length + ' OSM road segments');

            // Step 4 — Extract shortcuts
            var shortcuts = extractShortcuts(
              parsed.coords,
              roadCoordArrays,
              bufferMeters,
              minLengthMeters
            );
            onProgress('extract', 'Found ' + shortcuts.length + ' new shortcut segments');

            // Step 5 — Display on map
            displayOnMap(map, shortcuts, roadCoordArrays);
            onProgress('display', 'Displayed on map');

            // Step 6 — Build GeoJSON and store
            var geojson = buildGeoJSON(shortcuts, bufferMeters);
            _lastResult = geojson;

            // Step 7 — Compute total length and report done
            var totalLength = 0;
            for (var i = 0; i < shortcuts.length; i++) {
              var line = turf.lineString(shortcuts[i]);
              totalLength += turf.length(line, { units: 'meters' });
            }

            onProgress('done', {
              geojson: geojson,
              segmentCount: shortcuts.length,
              totalLengthMeters: Math.round(totalLength * 100) / 100
            });
          })
          .catch(function (err) {
            onProgress('error', 'OSM fetch failed: ' + err.message);
          });
      } catch (err) {
        onProgress('error', err.message);
      }
    };

    reader.readAsText(file);
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  return {
    // Core methods
    parseGPX: parseGPX,
    fetchOSMRoads: fetchOSMRoads,
    extractShortcuts: extractShortcuts,
    buildGeoJSON: buildGeoJSON,
    downloadGeoJSON: downloadGeoJSON,
    displayOnMap: displayOnMap,
    clearMapLayers: clearMapLayers,
    run: run,

    // Internal state (exposed for external access)
    get _layers() { return _layers; },
    set _layers(val) { _layers = val; },
    get _lastResult() { return _lastResult; },
    set _lastResult(val) { _lastResult = val; }
  };
})();
