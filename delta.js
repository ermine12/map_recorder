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
  /** @type {object|null} Observable reasons for every part omitted from candidates. */
  var _lastAnalysis = null;

  // ---------------------------------------------------------------------------
  // 1. Universal Track Parsers (GPX & GeoJSON)
  // ---------------------------------------------------------------------------

  function computeBBoxAndResult(segments) {
    var coords = [];
    for (var s = 0; s < segments.length; s++) {
      for (var p = 0; p < segments[s].coords.length; p++) coords.push(segments[s].coords[p]);
    }
    if (!coords.length) throw new Error('The recording contains no valid track points.');
    var north = -Infinity, south = Infinity, east = -Infinity, west = Infinity;
    for (var i = 0; i < coords.length; i++) {
      var lng = coords[i][0];
      var lat = coords[i][1];
      if (lat > north) north = lat;
      if (lat < south) south = lat;
      if (lng > east) east = lng;
      if (lng < west) west = lng;
    }

    return {
      coords: coords,
      segments: segments,
      bbox: { north: north, south: south, east: east, west: west }
    };
  }

  /**
   * Parse a GPX XML string and extract track coordinates + bounding box.
   */
  function parseGPX(xmlString) {
    var parser = new DOMParser();
    var doc = parser.parseFromString(xmlString, 'application/xml');

    // Check for parse errors
    var parseError = doc.querySelector('parsererror');
    if (parseError) {
      throw new Error('Invalid GPX file: ' + parseError.textContent);
    }

    var tracks = [];
    var segments = doc.querySelectorAll('trkseg');

    if (segments.length === 0) {
      throw new Error('GPX file contains no track segments (<trkseg>).');
    }

    for (var s = 0; s < segments.length; s++) {
      var trkpts = segments[s].querySelectorAll('trkpt');
      var coords = [], times = [];
      for (var p = 0; p < trkpts.length; p++) {
        var lat = parseFloat(trkpts[p].getAttribute('lat'));
        var lon = parseFloat(trkpts[p].getAttribute('lon'));
        if (isFinite(lat) && isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
          coords.push([lon, lat]); // [lng, lat]
          var timeNode = trkpts[p].querySelector('time');
          var time = timeNode ? Date.parse(timeNode.textContent) : NaN;
          times.push(isFinite(time) ? time : null);
        }
      }
      if (coords.length) tracks.push({ coords: coords, times: times });
    }
    return computeBBoxAndResult(tracks);
  }

  /**
   * Parse a GeoJSON string or object and extract track coordinates + bounding box.
   * Handles 2D [lng, lat] and 3D [lng, lat, elevation] coordinates from Organic Maps.
   */
  function parseGeoJSON(jsonString) {
    var data = typeof jsonString === 'string' ? JSON.parse(jsonString) : jsonString;
    var segments = [];

    function extractFromLine(lineCoords, coordTimes) {
      if (!Array.isArray(lineCoords)) return;
      var coords = [], times = [];
      for (var i = 0; i < lineCoords.length; i++) {
        var pt = lineCoords[i];
        if (Array.isArray(pt) && pt.length >= 2) {
          var lng = parseFloat(pt[0]);
          var lat = parseFloat(pt[1]);
          if (isFinite(lng) && isFinite(lat) && Math.abs(lng) <= 180 && Math.abs(lat) <= 90) {
            coords.push([lng, lat]); // Normalized 2D [lng, lat]
            var time = Array.isArray(coordTimes) && coordTimes[i] ? Date.parse(coordTimes[i]) : NaN;
            times.push(isFinite(time) ? time : null);
          }
        }
      }
      if (coords.length) segments.push({ coords: coords, times: times });
    }

    function extractFeature(feat) {
      if (!feat || !feat.geometry) return;
      var geometry = feat.geometry;
      var times = feat.properties && feat.properties.coordTimes;
      if (geometry.type === 'LineString') {
        extractFromLine(geometry.coordinates, times);
      } else if (geometry.type === 'MultiLineString') {
        for (var m = 0; m < geometry.coordinates.length; m++) {
          extractFromLine(geometry.coordinates[m], Array.isArray(times) ? times[m] : null);
        }
      }
    }

    if (data.type === 'FeatureCollection' && Array.isArray(data.features)) {
      for (var f = 0; f < data.features.length; f++) {
        extractFeature(data.features[f]);
      }
    } else if (data.type === 'Feature' && data.geometry) {
      extractFeature(data);
    } else if (data.type === 'LineString') {
      extractFromLine(data.coordinates, null);
    }

    if (segments.length === 0) {
      throw new Error('GeoJSON file contains no valid LineString track points.');
    }

    return computeBBoxAndResult(segments);
  }

  /**
   * Universal parser: auto-detects GeoJSON vs GPX.
   */
  function parseTrack(fileContent, fileName) {
    var trimmed = (fileContent || '').trim();
    var isJSON = (fileName && (fileName.toLowerCase().endsWith('.geojson') || fileName.toLowerCase().endsWith('.json'))) ||
                 trimmed.startsWith('{') || trimmed.startsWith('[');

    if (isJSON) {
      return parseGeoJSON(trimmed);
    }
    return parseGPX(trimmed);
  }

  // ---------------------------------------------------------------------------
  // 2. fetchOSMRoads
  // ---------------------------------------------------------------------------

  /**
   * Fetch all highway ways from OpenStreetMap within the given bounding box
   * using a fast parallel race across public Overpass mirrors.
   *
   * @param {{ north: number, south: number, east: number, west: number }} bbox
   * @param {function} [onStatus]
   * @returns {Promise<number[][][]>}  Array of road LineStrings, each an array of [lng, lat].
   */
  function fetchOSMRoads(bbox, onStatus) {
    if (typeof onStatus === 'function') {
      onStatus('🌐 Connecting to OpenStreetMap mirrors…');
    }

    // Add ~0.001° padding so edge roads are included
    var pad = 0.001;
    var south = (bbox.south - pad).toFixed(6);
    var west = (bbox.west - pad).toFixed(6);
    var north = (bbox.north + pad).toFixed(6);
    var east = (bbox.east + pad).toFixed(6);

    // Optimized lightweight Overpass query: out skel qt (no heavy metadata/tags)
    var query =
      '[out:json][timeout:15];\n' +
      '(\n' +
      '  way["highway"](' + south + ',' + west + ',' + north + ',' + east + ');\n' +
      ');\n' +
      'out skel qt;\n' +
      '>;\n' +
      'out skel qt;';

    var servers = [
      'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
      'https://overpass-api.de/api/interpreter',
      'https://overpass.kumi.systems/api/interpreter'
    ];

    // Race complete, non-empty responses. An empty result needs corroboration;
    // a timed-out Overpass query can otherwise look like an unmapped area.
    var abortController = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var emptyResponses = 0;

    var requests = servers.map(function (serverUrl) {
      var fetchOptions = {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'data=' + encodeURIComponent(query)
      };
      if (abortController) {
        fetchOptions.signal = abortController.signal;
      }

      return fetch(serverUrl, fetchOptions)
        .then(function (res) {
          if (!res.ok) {
            throw new Error(serverUrl + ' HTTP ' + res.status);
          }
          return res.json();
        })
        .then(function (data) {
          if (!data || !Array.isArray(data.elements) || data.remark ||
              data.elements.some(function (element) { return element && element.type === 'remark'; })) {
            throw new Error(serverUrl + ' returned an incomplete OSM response');
          }
          if (!data.elements.some(function (element) { return element.type === 'way'; })) {
            emptyResponses++;
            throw new Error(serverUrl + ' found no ways');
          }
          var nodeIds = new Set(data.elements.filter(function (element) { return element.type === 'node'; })
            .map(function (element) { return element.id; }));
          if (data.elements.some(function (element) {
            return element.type === 'way' && (!Array.isArray(element.nodes) || element.nodes.length < 2 ||
              element.nodes.some(function (id) { return !nodeIds.has(id); }));
          })) {
            throw new Error(serverUrl + ' omitted road coordinates');
          }
          return data;
        });
    });

    return Promise.any(requests)
      .catch(function () {
        if (emptyResponses >= 2) return { elements: [] };
        throw new Error('OpenStreetMap lookup failed or returned incomplete data.');
      })
      .then(function (data) {
        // Abort the slower pending requests
        if (abortController) {
          abortController.abort();
        }

        // Build a lookup map:  nodeId → [lng, lat]
        var nodeLookup = {};
        var elements = data.elements;
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

          if (roadCoords.length >= 2) {
            roads.push(roadCoords);
          }
        }

        return roads;
      })
      .catch(function (err) {
        throw new Error('Could not connect to OpenStreetMap servers. Please try again.');
      });
  }

  // ---------------------------------------------------------------------------
  // 3. extractShortcuts
  // ---------------------------------------------------------------------------

  function distanceMeters(a, b) {
    var rad = Math.PI / 180, dLat = (b[1] - a[1]) * rad, dLon = (b[0] - a[0]) * rad;
    var h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin(dLon / 2) ** 2;
    return 12742017.6 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
  }

  function interpolate(a, b, fraction) {
    return [a[0] + (b[0] - a[0]) * fraction, a[1] + (b[1] - a[1]) * fraction];
  }

  // Treat long pauses as gaps, not as a straight line connecting two fixes.
  // Quality flags remain attached to the original observations for review.
  function splitTrackSegments(sourceSegments) {
    var output = [], warnings = [], gaps = [];
    for (var s = 0; s < sourceSegments.length; s++) {
      var source = sourceSegments[s], coords = source.coords, times = source.times || [];
      var tangled = new Set();
      for (var start = 0; start + 20 <= coords.length; start++) {
        var window = coords.slice(start, start + 20);
        var length = 0, west = Infinity, east = -Infinity, south = Infinity, north = -Infinity;
        for (var w = 0; w < window.length; w++) {
          var point = window[w];
          west = Math.min(west, point[0]); east = Math.max(east, point[0]);
          south = Math.min(south, point[1]); north = Math.max(north, point[1]);
          if (w) length += distanceMeters(window[w - 1], point);
        }
        var diagonal = distanceMeters([west, south], [east, north]);
        if (length >= 180 && diagonal <= 110 && length / Math.max(diagonal, 1) >= 3.5) {
          for (var q = start; q < start + 20; q++) tangled.add(q);
        }
      }
      var chunkStart = 0, pendingGapReason = null;
      function addChunk(end) {
        if (end - chunkStart < 2) {
          warnings.push('Track ' + (s + 1) + ' has an isolated point at ' + chunkStart + '; no line was drawn across the gap');
          return;
        }
        var reasons = [];
        if (pendingGapReason) reasons.push(pendingGapReason);
        if (Array.from(tangled).some(function (index) { return index >= chunkStart && index < end; })) {
          reasons.push('Repeated movement within a small area; check for GPS drift');
        }
        output.push({ coords: coords.slice(chunkStart, end), times: times.slice(chunkStart, end),
          sourceSegment: s, startIndex: chunkStart, endIndex: end - 1,
          startedAt: times[chunkStart] == null ? null : new Date(times[chunkStart]).toISOString(),
          endedAt: times[end - 1] == null ? null : new Date(times[end - 1]).toISOString(),
          tangledIndices: Array.from(tangled).filter(function (index) { return index >= chunkStart && index < end; }),
          warningReasons: reasons });
      }
      for (var i = 1; i < coords.length; i++) {
        var elapsed = times[i] != null && times[i - 1] != null ? times[i] - times[i - 1] : null;
        var speed = elapsed > 0 ? distanceMeters(coords[i - 1], coords[i]) / (elapsed / 1000) : null;
        var timeGap = elapsed != null && (elapsed > 120000 || elapsed <= 0);
        var badSpeed = speed != null && speed > 10;
        var tangleBoundary = tangled.has(i) !== tangled.has(i - 1);
        if (timeGap || badSpeed || tangleBoundary) {
          addChunk(i);
          if (timeGap || badSpeed || tangleBoundary) {
            gaps.push({
              from: coords[i - 1].slice(0, 2),
              to: coords[i].slice(0, 2),
              sourceSegment: s,
              type: timeGap || badSpeed ? 'unobserved' : 'uncertain',
              reason: timeGap && elapsed > 120000 ? 'Recording paused for more than two minutes' :
                badSpeed ? 'Implausible movement between GPS fixes' :
                  timeGap ? 'Timestamps did not increase' : 'Path split at a tangled section',
              elapsedSeconds: elapsed == null ? null : Math.round(elapsed / 1000),
              distanceMeters: Math.round(distanceMeters(coords[i - 1], coords[i]) * 10) / 10
            });
          }
          warnings.push('Track ' + (s + 1) + ' split at point ' + i +
            (timeGap && elapsed > 120000 ? ' after a ' + Math.round(elapsed / 1000) + ' s pause' :
              badSpeed ? ' after an implausible GPS update' : ' at a tangled section'));
          chunkStart = i;
          pendingGapReason = timeGap && elapsed > 120000 ? 'Recording resumed after a long time gap' :
            badSpeed ? 'Recording resumed after an implausible GPS update' :
              timeGap ? 'Recording timestamps were out of order' : null;
        }
      }
      addChunk(coords.length);
      if (tangled.size) warnings.push('Track ' + (s + 1) + ' contains repeated movement in a small area');
    }
    return { segments: output, warnings: warnings, gaps: gaps };
  }

  function classifyDetailed(sourceSegments, roadCoordArrays, bufferMeters, minLengthMeters) {
    var roads = [];
    for (var r = 0; r < roadCoordArrays.length; r++) {
      var rc = roadCoordArrays[r];
      if (!Array.isArray(rc) || rc.length < 2) continue;
      var west = Infinity, east = -Infinity, south = Infinity, north = -Infinity;
      for (var n = 0; n < rc.length; n++) {
        west = Math.min(west, rc[n][0]); east = Math.max(east, rc[n][0]);
        south = Math.min(south, rc[n][1]); north = Math.max(north, rc[n][1]);
      }
      roads.push({ line: turf.lineString(rc), west: west, east: east, south: south, north: north });
    }
    function onRoad(coord) {
      var latPad = bufferMeters / 111000;
      var lonPad = latPad / Math.max(Math.cos(coord[1] * Math.PI / 180), 0.1);
      for (var j = 0; j < roads.length; j++) {
        var road = roads[j];
        if (coord[1] < road.south - latPad || coord[1] > road.north + latPad ||
            coord[0] < road.west - lonPad || coord[0] > road.east + lonPad) continue;
        if (turf.pointToLineDistance(turf.point(coord), road.line, { units: 'meters' }) <= bufferMeters) return true;
      }
      return false;
    }
    function boundary(a, b, aOnRoad) {
      var left = 0, right = 1;
      for (var k = 0; k < 10; k++) {
        var middle = (left + right) / 2;
        if (onRoad(interpolate(a, b, middle)) === aOnRoad) left = middle;
        else right = middle;
      }
      return interpolate(a, b, (left + right) / 2);
    }
    var result = { candidates: [], osmCovered: [], tooShort: [] };
    for (var s = 0; s < sourceSegments.length; s++) {
      var source = sourceSegments[s], track = source.coords;
      if (track.length < 2) continue;
      var samples = [track[0]], sampleOrigins = [source.startIndex || 0];
      for (var i = 1; i < track.length; i++) {
      var sampleStep = Math.min(2, Math.max(0.5, bufferMeters / 2));
      var count = Math.max(1, Math.ceil(distanceMeters(track[i - 1], track[i]) / sampleStep));
        for (var step = 1; step <= count; step++) {
          samples.push(interpolate(track[i - 1], track[i], step / count));
          sampleOrigins.push((source.startIndex || 0) + i - 1 + step / count);
        }
      }
      var active = null, previousOnRoad = onRoad(samples[0]);
      function finish() {
        if (!active || active.coords.length < 2) { active = null; return; }
        var metres = turf.length(turf.lineString(active.coords), { units: 'meters' });
        if (metres <= 0.01) { active = null; return; }
        var from = Math.floor(active.startIndex), to = Math.ceil(active.endIndex);
        var shared = {
          coords: active.coords,
          sourceSegment: source.sourceSegment,
          startIndex: from,
          endIndex: to,
          startedAt: source.startedAt,
          endedAt: source.endedAt,
          lengthMeters: Math.round(metres * 100) / 100
        };
        if (active.onRoad) {
          result.osmCovered.push(Object.assign({
            reason: 'Near an OpenStreetMap road (within ' + bufferMeters + ' m)'
          }, shared));
        } else if (metres < minLengthMeters) {
          result.tooShort.push(Object.assign({
            reason: 'Unmapped fragment shorter than ' + minLengthMeters + ' m'
          }, shared));
        } else {
          var reasons = (source.warningReasons || []).slice();
          if ((source.tangledIndices || []).some(function (index) { return index >= from && index <= to; }) &&
              !reasons.some(function (reason) { return reason.indexOf('Repeated movement') !== -1; })) {
            reasons.push('Repeated movement within a small area; check for GPS drift');
          }
          result.candidates.push(Object.assign({ warningReasons: reasons }, shared));
        }
        active = null;
      }
      function addSpan(isOnRoad, fromPoint, toPoint, startIndex, endIndex) {
        if (!active || active.onRoad !== isOnRoad) {
          finish();
          active = { onRoad: isOnRoad, coords: [fromPoint], startIndex: startIndex, endIndex: endIndex };
        } else if (distanceMeters(active.coords[active.coords.length - 1], fromPoint) > 0.01) {
          active.coords.push(fromPoint);
        }
        if (distanceMeters(active.coords[active.coords.length - 1], toPoint) > 0.01) active.coords.push(toPoint);
        active.endIndex = endIndex;
      }
      for (var k = 1; k < samples.length; k++) {
        var before = samples[k - 1], after = samples[k], nextOnRoad = onRoad(after);
        if (previousOnRoad === nextOnRoad) {
          addSpan(previousOnRoad, before, after, sampleOrigins[k - 1], sampleOrigins[k]);
        } else {
          var crossing = boundary(before, after, previousOnRoad);
          addSpan(previousOnRoad, before, crossing, sampleOrigins[k - 1], sampleOrigins[k]);
          addSpan(nextOnRoad, crossing, after, sampleOrigins[k - 1], sampleOrigins[k]);
        }
        previousOnRoad = nextOnRoad;
      }
      finish();
    }
    return result;
  }

  function extractDetailed(sourceSegments, roadCoordArrays, bufferMeters, minLengthMeters) {
    return classifyDetailed(sourceSegments, roadCoordArrays, bufferMeters, minLengthMeters).candidates;
  }

  // Retain the historical API for callers that pass a single coordinate list.
  function extractShortcuts(trackCoords, roadCoordArrays, bufferMeters, minLengthMeters) {
    var segments = Array.isArray(trackCoords[0]) ? [{ coords: trackCoords, sourceSegment: 0,
      startIndex: 0, endIndex: trackCoords.length - 1, warningReasons: [] }] : trackCoords;
    return extractDetailed(segments, roadCoordArrays, bufferMeters, minLengthMeters).map(function (item) { return item.coords; });
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
  function hashString(value) {
    var hash = 2166136261;
    for (var i = 0; i < value.length; i++) {
      hash ^= value.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
  }

  function buildGeoJSON(shortcutSegments, bufferMeters, options) {
    options = options || {};
    var now = new Date().toISOString();
    var features = [];

    for (var i = 0; i < shortcutSegments.length; i++) {
      var segment = shortcutSegments[i];
      var coords = Array.isArray(segment) ? segment : segment.coords;
      var warningReasons = Array.isArray(segment.warningReasons) ? segment.warningReasons : [];
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
          length_meters: Math.round(lengthM * 100) / 100,
          source_id: options.sourceId || null,
          source_segment: segment.sourceSegment == null ? null : segment.sourceSegment,
          source_point_start: segment.startIndex == null ? null : segment.startIndex,
          source_point_end: segment.endIndex == null ? null : segment.endIndex,
          source_time_start: segment.startedAt || null,
          source_time_end: segment.endedAt || null,
          candidate_id: (options.sourceId || 'untracked') + ':' + hashString(JSON.stringify(coords)),
          candidate_status: warningReasons.length ? 'needs_review' : 'review',
          warning_reasons: warningReasons
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
    _lastResult = null;
    _lastAnalysis = null;

    // Step 1 — Read file as text
    return new Promise(function (resolve) {
      var reader = new FileReader();
      reader.onerror = function () {
        onProgress('error', 'Failed to read the file.');
        resolve(null);
      };
      reader.onload = function (e) {
        try {
        var contentString = e.target.result;
        var fileName = (file && file.name) || '';

        // Step 2 — Parse GPX or GeoJSON
        var parsed = parseTrack(contentString, fileName);
        var prepared = splitTrackSegments(parsed.segments);
        var sourceId = 'track-' + hashString(contentString) + '-' + contentString.length;
        var typeLabel = fileName.toLowerCase().endsWith('.geojson') || fileName.toLowerCase().endsWith('.json') ? 'GeoJSON' : 'GPX';
        onProgress('parse', typeLabel + ' parsed: ' + parsed.coords.length + ' points in ' + prepared.segments.length + ' continuous parts');

        // Step 3 — Fetch OSM roads (async with fast parallel race)
        onProgress('fetch', '🌐 Connecting to OpenStreetMap mirrors…');

        fetchOSMRoads(parsed.bbox, function (statusMsg) {
          onProgress('fetch', statusMsg);
        })
          .then(function (roadCoordArrays) {
            onProgress('extract', '✂️ Analyzing overlap against ' + roadCoordArrays.length + ' OSM road segments…');

            // Step 4 — Extract shortcuts
            var classification = classifyDetailed(
              prepared.segments,
              roadCoordArrays,
              bufferMeters,
              minLengthMeters
            );
            var candidates = classification.candidates;
            var shortcuts = candidates.map(function (item) { return item.coords; });

            // Step 5 — Display on map
            displayOnMap(map, shortcuts, roadCoordArrays);
            onProgress('display', 'Rendering results on map…');

            // Step 6 — Build GeoJSON and store
            var geojson = buildGeoJSON(candidates, bufferMeters, { sourceId: sourceId });
            _lastResult = geojson;

            // Step 7 — Compute total length and report done
            var totalLength = 0;
            for (var i = 0; i < shortcuts.length; i++) {
              var line = turf.lineString(shortcuts[i]);
              totalLength += turf.length(line, { units: 'meters' });
            }

            function totalOf(items) {
              return Math.round(items.reduce(function (sum, item) { return sum + item.lengthMeters; }, 0) * 100) / 100;
            }
            var recordedMetres = prepared.segments.reduce(function (sum, segment) {
              return sum + turf.length(turf.lineString(segment.coords), { units: 'meters' });
            }, 0);
            var summary = {
              recordedMeters: Math.round(recordedMetres * 100) / 100,
              osmCoveredMeters: totalOf(classification.osmCovered),
              tooShortMeters: totalOf(classification.tooShort),
              candidateMeters: Math.round(totalLength * 100) / 100,
              flaggedCandidateMeters: Math.round(geojson.features.reduce(function (sum, feature) {
                return sum + (feature.properties.candidate_status === 'needs_review' ? feature.properties.length_meters : 0);
              }, 0) * 100) / 100,
              gapCount: prepared.gaps.length,
              candidateCount: candidates.length,
              tooShortCount: classification.tooShort.length,
              osmCoveredCount: classification.osmCovered.length,
              continuousSegmentCount: prepared.segments.length
            };
            _lastAnalysis = {
              originalSegments: prepared.segments.map(function (segment) { return segment.coords; }),
              osmCovered: classification.osmCovered,
              tooShort: classification.tooShort,
              gaps: prepared.gaps,
              candidates: geojson.features,
              summary: summary
            };

            onProgress('done', {
              geojson: geojson,
              analysis: _lastAnalysis,
              summary: summary,
              segmentCount: shortcuts.length,
              candidateCount: shortcuts.length,
              reviewCount: geojson.features.filter(function (feature) { return feature.properties.candidate_status === 'needs_review'; }).length,
              warnings: prepared.warnings,
              totalLengthMeters: Math.round(totalLength * 100) / 100
            });
            resolve(geojson);
          })
          .catch(function (err) {
            onProgress('error', 'OSM fetch failed: ' + err.message);
            resolve(null);
          });
        } catch (err) {
          onProgress('error', err.message);
          resolve(null);
        }
      };
      reader.readAsText(file);
    });
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  return {
    // Core methods
    parseGPX: parseGPX,
    parseGeoJSON: parseGeoJSON,
    parseTrack: parseTrack,
    prepareTrack: splitTrackSegments,
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
    set _lastResult(val) { _lastResult = val; },
    get _lastAnalysis() { return _lastAnalysis; },
    set _lastAnalysis(val) { _lastAnalysis = val; }
  };
})();
