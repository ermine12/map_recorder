/**
 * Shortcut Path Recorder — app.js
 * Phase 1: Map initialization & live GPS centering
 * Phase 2: GPS tracking engine, Haversine distance, anti-jitter filtering
 * Phase 3: UI controls, live status bar, state management, elapsed time
 * Phase 4: GeoJSON export with proper schema, download trigger
 * Phase 5: Error hardening, GPS permission UX, wake lock, toast notifications
 */

// ============================================
// Configuration
// ============================================
const CONFIG = {
  fallbackCenter: [9.421, 42.041],
  defaultZoom: 16,
  tileUrl: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
  tileAttribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  // --- 4-Tier GPS Filter Thresholds ---
  maxAccuracyMeters: 20,        // Tier 1: reject blurry satellite locks
  minDistanceMeters: 2.5,       // Tier 2: anti-jitter standing-still filter
  maxJumpMeters: 35,            // Tier 3: anti-teleportation single-update cap
  maxSpeedMps: 8,               // Tier 4: human speed ceiling (~29 km/h)
  pathColor: '#E51B23',
  pathWeight: 4,
  geoOptions: {
    enableHighAccuracy: true,
    timeout: 15000,
    maximumAge: 0,
  },
  accuracyThresholds: {
    good: 15,
    fair: 30,
  },
  toastDuration: 3500,
};

// ============================================
// State
// ============================================
const state = {
  map: null,
  userMarker: null,
  accuracyCircle: null,
  initialPositionSet: false,
  watchId: null,
  isRecording: false,
  coordinates: [],
  totalDistance: 0,
  pathLine: null,
  lastRecordedCoord: null,       // { lat, lng, time } — includes timestamp for speed calc
  rejectedPoints: 0,             // Count of points rejected by the 4-tier filter
  autoFollow: true,
  recordingStartTime: null,
  timerInterval: null,
  wakeLock: null,
  startMarker: null,
  endMarker: null,
};

// ============================================
// DOM References
// ============================================
const dom = {
  recState: document.getElementById('rec-state'),
  recTime: document.getElementById('rec-time'),
  recDistance: document.getElementById('rec-distance'),
  recPoints: document.getElementById('rec-points'),
  btnStart: document.getElementById('btn-start'),
  btnStop: document.getElementById('btn-stop'),
  btnDownload: document.getElementById('btn-download'),
  btnSaveRecorderMaster: document.getElementById('btn-save-recorder-master'),
  btnFollow: document.getElementById('btn-follow'),
  gpsAccuracy: document.getElementById('gps-accuracy'),
  gpsAccuracyText: document.getElementById('gps-accuracy-text'),
  permOverlay: document.getElementById('gps-permission-overlay'),
  btnGrantGps: document.getElementById('btn-grant-gps'),
  btnSkipGps: document.getElementById('btn-skip-gps'),
  toastContainer: document.getElementById('toast-container'),
};

// ============================================
// Toast Notification System
// ============================================
function showToast(message, type = 'info') {
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  dom.toastContainer.appendChild(toast);

  setTimeout(() => {
    toast.classList.add('fade-out');
    toast.addEventListener('animationend', () => toast.remove());
  }, CONFIG.toastDuration);
}

// ============================================
// Haversine Distance (meters)
// ============================================
function haversineDistance(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (deg) => (deg * Math.PI) / 180;

  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLng / 2) * Math.sin(dLng / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

// ============================================
// Formatting Helpers
// ============================================
function formatDistance(meters) {
  if (meters >= 1000) {
    return `${(meters / 1000).toFixed(2)} km`;
  }
  return `${Math.round(meters)} m`;
}

function formatElapsedTime(startTime) {
  if (!startTime) return '00:00';
  const elapsed = Math.floor((Date.now() - startTime) / 1000);
  const mins = Math.floor(elapsed / 60).toString().padStart(2, '0');
  const secs = (elapsed % 60).toString().padStart(2, '0');
  return `${mins}:${secs}`;
}

// ============================================
// GPS Accuracy Badge
// ============================================
function updateAccuracyBadge(accuracy) {
  if (accuracy == null) return;

  const rounded = Math.round(accuracy);
  dom.gpsAccuracyText.textContent = `±${rounded}m`;

  dom.gpsAccuracy.classList.remove('good', 'fair', 'poor');

  if (accuracy <= CONFIG.accuracyThresholds.good) {
    dom.gpsAccuracy.classList.add('good');
  } else if (accuracy <= CONFIG.accuracyThresholds.fair) {
    dom.gpsAccuracy.classList.add('fair');
  } else {
    dom.gpsAccuracy.classList.add('poor');
  }
}

// ============================================
// Screen Wake Lock (keep screen on while recording)
// ============================================
async function requestWakeLock() {
  if (!('wakeLock' in navigator)) return;

  try {
    state.wakeLock = await navigator.wakeLock.request('screen');
    state.wakeLock.addEventListener('release', () => {
      state.wakeLock = null;
    });
  } catch (err) {
    // Wake lock can fail if tab is not visible — non-critical
    console.warn('Wake Lock failed:', err.message);
  }
}

async function releaseWakeLock() {
  if (state.wakeLock) {
    try {
      await state.wakeLock.release();
    } catch (err) {
      // Already released
    }
    state.wakeLock = null;
  }
}

// Re-acquire wake lock when tab becomes visible again
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.isRecording) {
    requestWakeLock();
  }
});

// ============================================
// Path Endpoint Markers
// ============================================
function createEndpointIcon(color, label) {
  return L.divIcon({
    className: 'path-endpoint',
    html: `<svg width="24" height="24" viewBox="0 0 24 24">
      <circle cx="12" cy="12" r="10" fill="${color}" stroke="#fff" stroke-width="3"/>
      <text x="12" y="16" text-anchor="middle" fill="#fff" font-size="11" font-weight="bold">${label}</text>
    </svg>`,
    iconSize: [24, 24],
    iconAnchor: [12, 12],
  });
}

function updatePathMarkers() {
  // Remove existing markers
  if (state.startMarker) {
    state.map.removeLayer(state.startMarker);
    state.startMarker = null;
  }
  if (state.endMarker) {
    state.map.removeLayer(state.endMarker);
    state.endMarker = null;
  }

  if (state.coordinates.length === 0) return;

  // Start marker (green)
  const first = state.coordinates[0]; // [lng, lat]
  state.startMarker = L.marker([first[1], first[0]], {
    icon: createEndpointIcon('#22c55e', 'A'),
    interactive: false,
  }).addTo(state.map);

  // End marker (red) — only if more than 1 point
  if (state.coordinates.length > 1) {
    const last = state.coordinates[state.coordinates.length - 1];
    state.endMarker = L.marker([last[1], last[0]], {
      icon: createEndpointIcon('#E51B23', 'B'),
      interactive: false,
    }).addTo(state.map);
  }
}

// ============================================
// Map Initialization
// ============================================
function initMap() {
  state.map = L.map('map', {
    center: CONFIG.fallbackCenter,
    zoom: CONFIG.defaultZoom,
    zoomControl: false,
    attributionControl: true,
  });

  L.control.zoom({ position: 'topleft' }).addTo(state.map);

  L.tileLayer(CONFIG.tileUrl, {
    attribution: CONFIG.tileAttribution,
    maxZoom: 19,
  }).addTo(state.map);

  state.pathLine = L.polyline([], {
    color: CONFIG.pathColor,
    weight: CONFIG.pathWeight,
    opacity: 0.9,
    lineJoin: 'round',
    lineCap: 'round',
  }).addTo(state.map);

  // Disable auto-follow when user manually drags the map
  state.map.on('dragstart', () => {
    if (state.autoFollow) {
      state.autoFollow = false;
      dom.btnFollow.classList.remove('active');
    }
  });

  bindControls();
  dom.btnFollow.classList.add('active');

  // Load and render persistent Master Shortcuts Layer
  if (typeof MasterLayerManager !== 'undefined') {
    MasterLayerManager.renderOnMap(state.map);
  }

  // Check GPS availability and show permission overlay or proceed
  checkGpsAvailability();
}

// ============================================
// GPS Permission Flow
// ============================================
function checkGpsAvailability() {
  if (!('geolocation' in navigator)) {
    showToast('GPS not available on this device. Map will use default location.', 'warning');
    dom.gpsAccuracyText.textContent = 'No GPS';
    dom.gpsAccuracy.classList.add('poor');
    return;
  }

  // Check if permissions API is available to query state
  if ('permissions' in navigator) {
    navigator.permissions.query({ name: 'geolocation' }).then((result) => {
      if (result.state === 'granted') {
        // Already have permission — proceed directly
        requestInitialPosition();
      } else if (result.state === 'prompt') {
        // Show our custom overlay before the browser prompt
        showPermissionOverlay();
      } else {
        // Denied — show overlay with instructions
        showPermissionOverlay();
      }
    }).catch(() => {
      // Permissions API not fully supported — try directly
      requestInitialPosition();
    });
  } else {
    // No permissions API — request directly
    requestInitialPosition();
  }
}

function showPermissionOverlay() {
  dom.permOverlay.classList.remove('hidden');
}

function dismissPermissionOverlay() {
  dom.permOverlay.classList.add('fade-out');
  setTimeout(() => {
    dom.permOverlay.classList.add('hidden');
    dom.permOverlay.classList.remove('fade-out');
  }, 300);
}

function onGrantGps() {
  dismissPermissionOverlay();
  requestInitialPosition();
}

function onSkipGps() {
  dismissPermissionOverlay();
  showToast('Using default map location. GPS recording will not work.', 'warning');
  dom.gpsAccuracyText.textContent = 'Skipped';
  dom.gpsAccuracy.classList.add('poor');
}

// ============================================
// GPS — Initial Centering
// ============================================
function requestInitialPosition() {
  navigator.geolocation.getCurrentPosition(
    (position) => {
      const { latitude, longitude, accuracy } = position.coords;
      centerMapOnUser(latitude, longitude, accuracy);
      updateAccuracyBadge(accuracy);
      state.initialPositionSet = true;
      showToast('GPS position acquired.', 'success');
    },
    (error) => {
      console.warn('Initial GPS position failed:', error.message);
      handleGpsError(error, false);
    },
    CONFIG.geoOptions
  );
}

// ============================================
// GPS — Centralized Error Handler
// ============================================
function handleGpsError(error, isDuringRecording) {
  dom.gpsAccuracy.classList.remove('good', 'fair');
  dom.gpsAccuracy.classList.add('poor');

  switch (error.code) {
    case 1: // PERMISSION_DENIED
      dom.gpsAccuracyText.textContent = 'Denied';
      showToast('Location permission denied. Enable GPS in your browser settings.', 'error');
      if (isDuringRecording) stopRecording();
      break;
    case 2: // POSITION_UNAVAILABLE
      dom.gpsAccuracyText.textContent = 'No signal';
      showToast('GPS signal unavailable. Check that location services are enabled.', 'warning');
      break;
    case 3: // TIMEOUT
      dom.gpsAccuracyText.textContent = 'Timeout';
      showToast('GPS signal timed out. Will keep trying…', 'warning');
      // watchPosition will auto-retry
      break;
  }
}

// ============================================
// GPS — Update User Marker
// ============================================
function centerMapOnUser(lat, lng, accuracy) {
  const latlng = L.latLng(lat, lng);
  state.map.setView(latlng, state.map.getZoom());
  upsertUserMarker(latlng, accuracy);
}

function upsertUserMarker(latlng, accuracy) {
  if (!state.userMarker) {
    state.userMarker = L.circleMarker(latlng, {
      radius: 8,
      fillColor: '#4285F4',
      fillOpacity: 1,
      color: '#ffffff',
      weight: 3,
    }).addTo(state.map);

    state.accuracyCircle = L.circle(latlng, {
      radius: accuracy || 10,
      fillColor: '#4285F4',
      fillOpacity: 0.08,
      color: '#4285F4',
      weight: 1,
      opacity: 0.3,
    }).addTo(state.map);
  } else {
    state.userMarker.setLatLng(latlng);
    state.accuracyCircle.setLatLng(latlng);
    if (accuracy) state.accuracyCircle.setRadius(accuracy);
  }
}

function updateUserMarker(lat, lng, accuracy) {
  const latlng = L.latLng(lat, lng);

  if (!state.userMarker) {
    centerMapOnUser(lat, lng, accuracy);
  } else {
    upsertUserMarker(latlng, accuracy);
    if (state.autoFollow) {
      state.map.panTo(latlng, { animate: true, duration: 0.5 });
    }
  }
}

// ============================================
// GPS — Tracking (watchPosition)
// ============================================
function startTracking() {
  if (!('geolocation' in navigator)) {
    showToast('Geolocation is not supported by your browser.', 'error');
    return;
  }

  state.watchId = navigator.geolocation.watchPosition(
    onPositionUpdate,
    (error) => handleGpsError(error, true),
    CONFIG.geoOptions
  );
}

function stopTracking() {
  if (state.watchId !== null) {
    navigator.geolocation.clearWatch(state.watchId);
    state.watchId = null;
  }
}

function onPositionUpdate(position) {
  const { latitude, longitude } = position.coords;
  const accuracy = position.coords.accuracy || 999;
  // Edge Case B: fallback to Date.now() if browser omits timestamp
  const currentTime = (position.timestamp && isFinite(position.timestamp))
    ? position.timestamp
    : Date.now();

  // Always update the blue dot and accuracy badge (even for rejected points)
  updateUserMarker(latitude, longitude, accuracy);
  updateAccuracyBadge(accuracy);

  // Only run the recording filter pipeline while actively recording
  if (!state.isRecording) return;

  // =============================================
  // TIER 1: Hardware Accuracy Threshold
  // Reject blurry satellite locks (accuracy > 20m)
  // =============================================
  if (accuracy > CONFIG.maxAccuracyMeters) {
    state.rejectedPoints++;
    console.warn(
      `[GPS Filter T1] Rejected: accuracy ${accuracy.toFixed(1)}m > ${CONFIG.maxAccuracyMeters}m`
    );
    return; // No map/polyline update — Edge Case C
  }

  // =============================================
  // Edge Case A: First Point Initialization
  // No previous point exists — bypass distance/speed checks.
  // Only the accuracy check (Tier 1) gates the first point.
  // =============================================
  if (state.coordinates.length === 0) {
    state.coordinates.push([longitude, latitude]);
    state.lastRecordedCoord = { lat: latitude, lng: longitude, time: currentTime };

    state.pathLine.addLatLng(L.latLng(latitude, longitude));
    updatePathMarkers();
    updateStatusBar();
    return;
  }

  // =============================================
  // Calculate metrics from the last valid point
  // =============================================
  const dist = haversineDistance(
    state.lastRecordedCoord.lat,
    state.lastRecordedCoord.lng,
    latitude,
    longitude
  );

  // =============================================
  // TIER 2: Minimum Movement Threshold (Anti-Jitter)
  // Discard micro-drift while standing still (< 2.5m)
  // =============================================
  if (dist < CONFIG.minDistanceMeters) {
    return; // Silent discard — no log spam for normal standing
  }

  // =============================================
  // TIER 3: Absolute Max Jump Cap (Anti-Teleportation)
  // No pedestrian can move 35m in a single GPS tick
  // =============================================
  if (dist > CONFIG.maxJumpMeters) {
    state.rejectedPoints++;
    console.warn(
      `[GPS Filter T3] Rejected: jump ${dist.toFixed(1)}m > ${CONFIG.maxJumpMeters}m cap`
    );
    return; // No map/polyline update — Edge Case C
  }

  // =============================================
  // TIER 4: Human Speed Limit (Physics Validation)
  // speed = distance / time; reject if > 8 m/s (~29 km/h)
  // =============================================
  const timeElapsedSec = (currentTime - state.lastRecordedCoord.time) / 1000;

  if (timeElapsedSec > 0) {
    const speedMps = dist / timeElapsedSec;

    if (speedMps > CONFIG.maxSpeedMps) {
      state.rejectedPoints++;
      console.warn(
        `[GPS Filter T4] Rejected: speed ${speedMps.toFixed(1)} m/s > ${CONFIG.maxSpeedMps} m/s ceiling (${dist.toFixed(1)}m in ${timeElapsedSec.toFixed(1)}s)`
      );
      return; // No map/polyline update — Edge Case C
    }
  }
  // If timeElapsedSec is 0 or negative (clock skew), skip speed check
  // but still allow the point if it passed Tiers 1-3.

  // =============================================
  // ALL 4 TIERS PASSED — Commit the point
  // =============================================
  state.totalDistance += dist;
  state.coordinates.push([longitude, latitude]);
  state.lastRecordedCoord = { lat: latitude, lng: longitude, time: currentTime };

  // Update live polyline and markers
  state.pathLine.addLatLng(L.latLng(latitude, longitude));
  updatePathMarkers();
  updateStatusBar();
}

// ============================================
// Recording Controls
// ============================================
function startRecording() {
  // Check GPS first
  if (!('geolocation' in navigator)) {
    showToast('Cannot record without GPS support.', 'error');
    return;
  }

  // Confirm overwrite if existing data
  if (state.coordinates.length > 0) {
    const confirmed = confirm(
      `You have ${state.coordinates.length} recorded points. Starting a new recording will clear them.\n\nContinue?`
    );
    if (!confirmed) return;
  }

  // Clear previous track
  state.coordinates = [];
  state.totalDistance = 0;
  state.lastRecordedCoord = null;
  state.rejectedPoints = 0;
  state.pathLine.setLatLngs([]);
  updatePathMarkers(); // Remove old markers

  // Start recording
  state.isRecording = true;
  state.recordingStartTime = Date.now();
  startTracking();
  requestWakeLock();

  // Re-enable auto-follow
  state.autoFollow = true;
  dom.btnFollow.classList.add('active');

  // Start elapsed time ticker
  state.timerInterval = setInterval(() => {
    dom.recTime.textContent = formatElapsedTime(state.recordingStartTime);
  }, 1000);

  // Update UI
  dom.btnStart.disabled = true;
  dom.btnStop.disabled = false;
  dom.btnDownload.disabled = true;
  if (dom.btnSaveRecorderMaster) dom.btnSaveRecorderMaster.disabled = true;

  dom.recState.textContent = '● REC';
  dom.recState.className = 'status-value recording';

  updateStatusBar();
  showToast('Recording started. Walk your path!', 'info');
}

function stopRecording() {
  stopTracking();
  releaseWakeLock();

  if (state.timerInterval) {
    clearInterval(state.timerInterval);
    state.timerInterval = null;
  }

  state.isRecording = false;

  // Final marker update
  updatePathMarkers();

  dom.btnStart.disabled = false;
  dom.btnStop.disabled = true;
  dom.btnDownload.disabled = state.coordinates.length < 2;
  if (dom.btnSaveRecorderMaster) {
    dom.btnSaveRecorderMaster.disabled = state.coordinates.length < 2;
  }

  dom.recState.textContent = 'Stopped';
  dom.recState.className = 'status-value stopped';

  if (state.coordinates.length < 2) {
    showToast('Not enough points recorded. Try walking further.', 'warning');
  } else {
    showToast(
      `Recording stopped. ${state.coordinates.length} points, ${formatDistance(state.totalDistance)}. (${state.rejectedPoints} glitches filtered)`,
      'success'
    );
  }
}

// ============================================
// Status Bar
// ============================================
function updateStatusBar() {
  dom.recDistance.textContent = formatDistance(state.totalDistance);
  dom.recPoints.textContent = state.coordinates.length;
}

// ============================================
// Auto-Follow Toggle
// ============================================
function toggleAutoFollow() {
  state.autoFollow = !state.autoFollow;

  if (state.autoFollow) {
    dom.btnFollow.classList.add('active');
    if (state.userMarker) {
      state.map.panTo(state.userMarker.getLatLng(), { animate: true });
    }
    showToast('Auto-follow enabled.', 'info');
  } else {
    dom.btnFollow.classList.remove('active');
    showToast('Auto-follow disabled. Drag map freely.', 'info');
  }
}

// ============================================
// GeoJSON Export
// ============================================
function buildGeoJSON() {
  const now = new Date();
  const timestamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const name = `shortcut-path-${timestamp}`;

  return {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: {
          name: name,
          stroke: CONFIG.pathColor,
          'stroke-width': CONFIG.pathWeight,
          'stroke-opacity': 0.9,
          distance_meters: Math.round(state.totalDistance),
          points_recorded: state.coordinates.length,
          points_rejected: state.rejectedPoints,
          recorded_at: now.toISOString(),
        },
        geometry: {
          type: 'LineString',
          coordinates: state.coordinates,
        },
      },
    ],
  };
}

function downloadGeoJSON() {
  if (state.coordinates.length < 2) {
    showToast('Not enough points to export. Record at least 2 GPS positions.', 'warning');
    return;
  }

  try {
    const geojson = buildGeoJSON();
    const jsonString = JSON.stringify(geojson, null, 2);
    const blob = new Blob([jsonString], { type: 'application/geo+json' });
    const url = URL.createObjectURL(blob);

    const fileName = geojson.features[0].properties.name + '.geojson';
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();

    document.body.removeChild(link);
    URL.revokeObjectURL(url);

    showToast(`Downloaded ${fileName}`, 'success');
  } catch (err) {
    console.error('Download failed:', err);
    showToast('Download failed. Please try again.', 'error');
  }
}

// ============================================
// Button Bindings
// ============================================
function bindControls() {
  // Recorder tab buttons
  dom.btnStart.addEventListener('click', startRecording);
  dom.btnStop.addEventListener('click', stopRecording);
  dom.btnFollow.addEventListener('click', toggleAutoFollow);
  dom.btnDownload.addEventListener('click', downloadGeoJSON);
  dom.btnGrantGps.addEventListener('click', onGrantGps);
  dom.btnSkipGps.addEventListener('click', onSkipGps);

  // Tab switching
  document.querySelectorAll('#tab-bar .tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      // Deactivate all tabs and panels
      document.querySelectorAll('#tab-bar .tab').forEach((t) => t.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));

      // Activate the clicked tab and its panel
      tab.classList.add('active');
      const panelId = `tab-${tab.dataset.tab}`;
      document.getElementById(panelId).classList.add('active');

      // Refresh master stats if switching to master tab
      if (tab.dataset.tab === 'master') {
        updateMasterStatsUI();
      }
    });
  });

  // Delta Extractor UI wiring
  bindDeltaControls();

  // Master Layer UI wiring
  bindMasterControls();
}

// ============================================
// Delta Extractor UI Wiring
// ============================================
function bindDeltaControls() {
  const gpxInput = document.getElementById('gpx-file-input');
  const gpxFileName = document.getElementById('gpx-file-name');
  const btnExtract = document.getElementById('btn-extract');
  const btnDeltaDownload = document.getElementById('btn-delta-download');
  const btnSaveDeltaMaster = document.getElementById('btn-save-delta-master');
  const btnDeltaClear = document.getElementById('btn-delta-clear');
  const deltaStatus = document.getElementById('delta-status');
  const deltaStatusText = document.getElementById('delta-status-text');
  const bufferInput = document.getElementById('delta-buffer');
  const minLengthInput = document.getElementById('delta-min-length');

  let selectedFile = null;

  // File selection
  gpxInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;

    selectedFile = file;
    gpxFileName.textContent = file.name;
    gpxFileName.classList.add('loaded');
    btnExtract.disabled = false;

    setDeltaStatus('ready', `Ready to process: ${file.name}`);
    showToast(`Track loaded: ${file.name}`, 'info');
  });

  // Extract button
  btnExtract.addEventListener('click', async () => {
    if (!selectedFile) return;
    if (typeof DeltaExtractor === 'undefined') {
      showToast('Delta Extractor module not loaded.', 'error');
      return;
    }

    btnExtract.disabled = true;
    btnDeltaDownload.disabled = true;
    if (btnSaveDeltaMaster) btnSaveDeltaMaster.disabled = true;
    btnDeltaClear.disabled = true;

    const bufferMeters = parseFloat(bufferInput.value) || 4.5;
    const minLengthMeters = parseFloat(minLengthInput.value) || 3.0;

    setDeltaStatus('processing', 'Starting extraction…');

    await DeltaExtractor.run(
      selectedFile,
      bufferMeters,
      minLengthMeters,
      state.map,
      (step, message) => {
        if (step === 'error') {
          setDeltaStatus('error', message);
          btnExtract.disabled = false;
          showToast(message, 'error');
        } else if (step === 'done') {
          const result = message;
          setDeltaStatus(
            'done',
            `✅ Found ${result.segmentCount} shortcut(s) — ${Math.round(result.totalLengthMeters)}m total`
          );
          btnDeltaDownload.disabled = false;
          if (btnSaveDeltaMaster) btnSaveDeltaMaster.disabled = result.segmentCount === 0;
          btnDeltaClear.disabled = false;
          btnExtract.disabled = false;
          showToast(
            `Extracted ${result.segmentCount} shortcut(s), ${Math.round(result.totalLengthMeters)}m`,
            'success'
          );
        } else {
          setDeltaStatus('processing', message);
        }
      }
    );
  });

  // Save delta result to Master Layer with intelligent deduplication
  if (btnSaveDeltaMaster) {
    btnSaveDeltaMaster.addEventListener('click', () => {
      if (typeof DeltaExtractor !== 'undefined' && DeltaExtractor._lastResult && typeof MasterLayerManager !== 'undefined') {
        const importRes = MasterLayerManager.importGeoJSON(DeltaExtractor._lastResult, 5.0);
        showToast(
          `Master updated: +${importRes.addedCount} new, 🔄 ${importRes.reinforcedCount} reinforced.`,
          'success'
        );
        btnSaveDeltaMaster.disabled = true;
        updateMasterStatsUI();
      }
    });
  }

  // Download result
  btnDeltaDownload.addEventListener('click', () => {
    if (typeof DeltaExtractor !== 'undefined' && DeltaExtractor._lastResult) {
      DeltaExtractor.downloadGeoJSON(DeltaExtractor._lastResult);
      showToast('GeoJSON downloaded.', 'success');
    }
  });

  // Clear
  btnDeltaClear.addEventListener('click', () => {
    if (typeof DeltaExtractor !== 'undefined') {
      DeltaExtractor.clearMapLayers(state.map);
    }
    selectedFile = null;
    gpxInput.value = '';
    gpxFileName.textContent = 'No file selected';
    gpxFileName.classList.remove('loaded');
    btnExtract.disabled = true;
    btnDeltaDownload.disabled = true;
    if (btnSaveDeltaMaster) btnSaveDeltaMaster.disabled = true;
    btnDeltaClear.disabled = true;
    setDeltaStatus('', 'Upload a GPX or GeoJSON file to begin.');
    showToast('Delta layers cleared.', 'info');
  });

  function setDeltaStatus(type, text) {
    deltaStatus.className = `delta-status ${type}`;
    deltaStatusText.textContent = text;
  }
}

// ============================================
// Master Layer UI Wiring
// ============================================
function updateMasterStatsUI() {
  if (typeof MasterLayerManager === 'undefined') return;
  const stats = MasterLayerManager.getStats();

  const elCount = document.getElementById('master-count');
  const elDist = document.getElementById('master-distance');
  const elWalks = document.getElementById('master-walks');

  if (elCount) elCount.textContent = stats.totalShortcuts;
  if (elDist) elDist.textContent = formatDistance(stats.totalDistanceMeters);
  if (elWalks) elWalks.textContent = stats.totalWalks;
}

function bindMasterControls() {
  const btnSaveRecorderMaster = document.getElementById('btn-save-recorder-master');
  const masterImportInput = document.getElementById('master-import-input');
  const btnExportMaster = document.getElementById('btn-export-master');
  const btnClearMaster = document.getElementById('btn-clear-master');
  const toggleMasterLayer = document.getElementById('toggle-master-layer');

  // Initial stats render
  updateMasterStatsUI();

  // Save live recorded path to Master Layer (deduplicated)
  if (btnSaveRecorderMaster) {
    btnSaveRecorderMaster.addEventListener('click', () => {
      if (state.coordinates.length < 2) {
        showToast('Not enough points to save.', 'warning');
        return;
      }
      if (typeof MasterLayerManager === 'undefined') return;

      const singleFeature = {
        type: 'Feature',
        geometry: {
          type: 'LineString',
          coordinates: state.coordinates
        },
        properties: {
          name: `shortcut-${new Date().toISOString().slice(0, 10)}`,
          distance_meters: Math.round(state.totalDistance),
          points_recorded: state.coordinates.length
        }
      };

      const res = MasterLayerManager.addShortcut(singleFeature, 5.0);
      if (res.action === 'reinforced') {
        showToast(`🔄 Reinforced existing ${res.name} (walked ${res.timesWalked}x)!`, 'success');
      } else {
        showToast(`✨ Saved as new ${res.name} in Master Layer!`, 'success');
      }

      btnSaveRecorderMaster.disabled = true;
      updateMasterStatsUI();
    });
  }

  // Import Past GeoJSON (with automatic deduplication)
  if (masterImportInput) {
    masterImportInput.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (!file) return;

      const reader = new FileReader();
      reader.onload = (event) => {
        try {
          const json = JSON.parse(event.target.result);
          const res = MasterLayerManager.importGeoJSON(json, 5.0);
          showToast(
            `Imported: +${res.addedCount} new shortcuts, 🔄 ${res.reinforcedCount} reinforced duplicates.`,
            'success'
          );
          updateMasterStatsUI();
        } catch (err) {
          showToast('Invalid GeoJSON file.', 'error');
        }
      };
      reader.readAsText(file);
      masterImportInput.value = '';
    });
  }

  // Export Master GeoJSON
  if (btnExportMaster) {
    btnExportMaster.addEventListener('click', () => {
      if (typeof MasterLayerManager === 'undefined') return;
      const ok = MasterLayerManager.exportMasterGeoJSON();
      if (ok) {
        showToast('Master GeoJSON exported successfully!', 'success');
      } else {
        showToast('No shortcuts in Master Layer to export.', 'warning');
      }
    });
  }

  // Clear Master Layer
  if (btnClearMaster) {
    btnClearMaster.addEventListener('click', () => {
      if (confirm('Are you sure you want to delete all saved shortcuts in your Master Layer?')) {
        if (typeof MasterLayerManager !== 'undefined') {
          MasterLayerManager.clearAll();
          updateMasterStatsUI();
          showToast('Master Layer cleared.', 'info');
        }
      }
    });
  }

  // Toggle map visibility
  if (toggleMasterLayer) {
    toggleMasterLayer.addEventListener('change', (e) => {
      if (typeof MasterLayerManager !== 'undefined') {
        MasterLayerManager.setVisibility(e.target.checked);
      }
    });
  }
}

// ============================================
// Bootstrap
// ============================================
document.addEventListener('DOMContentLoaded', initMap);
