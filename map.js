// ─── Tile Layers ──────────────────────────────────────────────────────────────

const TILE_LAYERS = {
  standard: {
    label: 'Standard',
    url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    options: { maxZoom: 19 }
  },
  dark: {
    label: 'Dark',
    url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
    options: { subdomains: 'abcd', maxZoom: 20 }
  },
  topo: {
    label: 'Topo',
    url: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',
    attribution: '&copy; <a href="https://opentopomap.org">OpenTopoMap</a>',
    options: { maxZoom: 17 }
  },
  satellite: {
    label: 'Satellite',
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    attribution: 'Tiles &copy; Esri',
    options: { maxZoom: 19 }
  },
  outdoors: {
    label: 'Outdoors',
    url: 'https://{s}.tile.openstreetmap.fr/osmfr/{z}/{x}/{y}.png',
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors, Tiles courtesy of <a href="https://openstreetmap.fr">OpenStreetMap France</a>',
    options: { maxZoom: 20 }
  },
  light: {
    label: 'Light',
    url: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
    options: { subdomains: 'abcd', maxZoom: 20 }
  }
};

let currentTileLayer = null;
let currentTileKey   = localStorage.getItem('parkrun-tile') || 'standard';

function setTileLayer(key) {
  const def = TILE_LAYERS[key];
  if (!def) return;
  if (currentTileLayer) map.removeLayer(currentTileLayer);
  currentTileLayer = L.tileLayer(def.url, { attribution: def.attribution, ...def.options }).addTo(map);
  currentTileKey   = key;
  localStorage.setItem('parkrun-tile', key);
  document.querySelectorAll('.tile-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tile === key);
  });
}

// ─── Map init ─────────────────────────────────────────────────────────────────

const map = L.map('map', { zoomControl: true }).setView([54.5, -2.5], 6);
setTileLayer(currentTileKey);

// ─── Marker icons ─────────────────────────────────────────────────────────────
// Two sizes: small for zoomed-out (< zoom 9), large for zoomed-in (>= zoom 9)

function makeIcon(color, size) {
  const s = size || 10;
  const r = s / 2;
  return L.divIcon({
    className: '',
    html: `<svg width="${s}" height="${s}" viewBox="0 0 ${s} ${s}" xmlns="http://www.w3.org/2000/svg">
      <circle cx="${r}" cy="${r}" r="${r - 1}" fill="${color}" stroke="white" stroke-width="1.2"/>
    </svg>`,
    iconSize:     [s, s],
    iconAnchor:   [r, r],
    popupAnchor:  [0, -r - 2]
  });
}

// Colour constants
const C_VISITED_MATCHED   = '#2ecc71';  // green  — visited + matches filter
const C_VISITED_UNMATCHED = '#27ae60';  // dark green — visited + dimmed
const C_UNVISITED         = '#e74c3c';  // red    — not visited (no filter)
const C_MATCHED           = '#3498db';  // blue   — matches filter, not visited
const C_DIM               = '#aaaaaa';  // grey   — outside filter
const C_VISITED_NO_FILTER = '#2ecc71';  // green  — visited, no filter active

// Pre-build icon sets for both sizes
const ICONS = {};
[10, 16].forEach(sz => {
  ICONS[sz] = {
    visitedMatched:   makeIcon(C_VISITED_MATCHED,   sz),
    visitedUnmatched: makeIcon(C_VISITED_UNMATCHED, sz),
    unvisited:        makeIcon(C_UNVISITED,          sz),
    matched:          makeIcon(C_MATCHED,            sz),
    dim:              makeIcon(C_DIM,                sz),
    visitedNoFilter:  makeIcon(C_VISITED_NO_FILTER,  sz),
  };
});

function currentIconSize() {
  return map.getZoom() >= 9 ? 16 : 10;
}

function iconFor(passes, visited, anyFilter) {
  const sz = currentIconSize();
  const set = ICONS[sz];
  if (!anyFilter) return visited ? set.visitedNoFilter : set.unvisited;
  if (passes)     return visited ? set.visitedMatched  : set.matched;
  return visited  ? set.visitedUnmatched : set.dim;
}

// ─── State ────────────────────────────────────────────────────────────────────

let allEvents  = [];
let visitedSet = new Set();
let athleteId  = null;
let athleteData = null;   // null if old-format JSON, rich object if new format
let geoLoaded  = false;

let activeFilters = {
  nameSearch:    '',
  startsWith:    '',
  country:       '',
  seriesId:      '',
  radius:        null,
  visitedOnly:   false,
  unvisitedOnly: false,
  hideUnmatched: false,
  clustering:    false,
  challenges:    []
};

const markerMap = {};

// ─── Clustering (optional) ────────────────────────────────────────────────────

let clusterGroup  = null;
let lastIconSize  = currentIconSize();
let _userZooming  = false;   // true while the user is interacting with the map directly

map.on('zoomstart', () => { _userZooming = true;  });
map.on('zoomend',   () => {
  const newSize = currentIconSize();
  if (newSize !== lastIconSize) {
    lastIconSize = newSize;
    applyFilters();
  }
  // Reset after a tick so applyFilters triggered by zoomend doesn't fitBounds
  setTimeout(() => { _userZooming = false; }, 0);
});

function rebuildClusterGroup() {
  if (!clusterGroup) return;
  const anyFilter = hasActiveFilter();
  clusterGroup.clearLayers();
  allEvents.forEach(feature => {
    const marker = markerMap[feature.id];
    if (!marker) return;
    const passes = eventMatchesFilters(feature);
    // Only add to cluster if it should be visible
    if (!anyFilter || passes || !activeFilters.hideUnmatched) {
      clusterGroup.addLayer(marker);
    }
  });
}

function enableClustering() {
  if (clusterGroup) return;
  // Remove individual markers from map
  Object.values(markerMap).forEach(m => { if (map.hasLayer(m)) map.removeLayer(m); });
  clusterGroup = L.markerClusterGroup({ chunkedLoading: true });
  map.addLayer(clusterGroup);
  rebuildClusterGroup();
}

function disableClustering() {
  if (!clusterGroup) return;
  map.removeLayer(clusterGroup);
  clusterGroup = null;
  // applyFilters will re-add markers correctly
  applyFilters();
}

// ─── Filter logic ─────────────────────────────────────────────────────────────

function eventMatchesFilters(feature) {
  const props = feature.properties;
  const name  = props.EventShortName || '';

  if (activeFilters.nameSearch) {
    if (!name.toLowerCase().includes(activeFilters.nameSearch.toLowerCase())) return false;
  }

  if (activeFilters.startsWith) {
    if (!name.toLowerCase().startsWith(activeFilters.startsWith.toLowerCase())) return false;
  }

  if (activeFilters.country) {
    if ((props.countrycode + '') !== activeFilters.country) return false;
  }

  if (activeFilters.seriesId) {
    if ((props.seriesid + '') !== activeFilters.seriesId) return false;
  }

  const visited = visitedSet.has(props.eventname);
  if (activeFilters.visitedOnly   && !visited) return false;
  if (activeFilters.unvisitedOnly &&  visited) return false;

  if (activeFilters.radius) {
    const [lng, lat] = feature.geometry.coordinates;
    if (haversineKm(lat, lng, activeFilters.radius.lat, activeFilters.radius.lng) > activeFilters.radius.km) return false;
  }

  if (activeFilters.challenges && activeFilters.challenges.length > 0) {
    const anyMatch = activeFilters.challenges.some(pattern => {
      try { return new RegExp(pattern, 'i').test(name); }
      catch { return false; }
    });
    if (!anyMatch) return false;
  }

  return true;
}

function hasActiveFilter() {
  return !!(
    activeFilters.nameSearch ||
    activeFilters.startsWith ||
    activeFilters.country    ||
    activeFilters.seriesId   ||
    activeFilters.radius     ||
    activeFilters.visitedOnly   ||
    activeFilters.unvisitedOnly ||
    (activeFilters.challenges && activeFilters.challenges.length > 0)
  );
}

function applyFilters() {
  const anyFilter = hasActiveFilter();

  if (clusterGroup) {
    // In cluster mode — update icons then rebuild cluster membership
    allEvents.forEach(feature => {
      const marker  = markerMap[feature.id];
      if (!marker) return;
      const passes  = eventMatchesFilters(feature);
      const visited = visitedSet.has(feature.properties.eventname);
      marker.setIcon(iconFor(passes, visited, anyFilter));
    });
    rebuildClusterGroup();
  } else {
    allEvents.forEach(feature => {
      const marker  = markerMap[feature.id];
      if (!marker) return;
      const passes  = eventMatchesFilters(feature);
      const visited = visitedSet.has(feature.properties.eventname);
      marker.setIcon(iconFor(passes, visited, anyFilter));

      if (!anyFilter || passes) {
        if (!map.hasLayer(marker)) marker.addTo(map);
      } else if (anyFilter && activeFilters.hideUnmatched) {
        if (map.hasLayer(marker)) map.removeLayer(marker);
      } else {
        if (!map.hasLayer(marker)) marker.addTo(map);
      }

      marker.setZIndexOffset((passes && anyFilter) ? 1000 : 0);
    });
  }

  updateFilterStatus();
  updateClearBtn();
  writeHash();

  // Fit bounds to matched events when hiding unmatched —
  // but not when the user is already zooming (e.g. clicking a cluster node)
  if (activeFilters.hideUnmatched && anyFilter && !_userZooming) {
    const matched = allEvents.filter(f => eventMatchesFilters(f));
    if (matched.length > 0) {
      const bounds = L.latLngBounds(matched.map(f => {
        const [lng, lat] = f.geometry.coordinates;
        return [lat, lng];
      }));
      map.fitBounds(bounds, { padding: [40, 40], maxZoom: 14 });
    }
  }
}

// ─── Public filter entry points ───────────────────────────────────────────────

function applyChallenge(pattern) {
  activeFilters.challenges = [pattern];
  activeFilters.nameSearch = '';
  activeFilters.startsWith = '';
  const nameEl = document.getElementById('fb-name');
  if (nameEl) nameEl.value = '';
  document.querySelectorAll('.fb-letter-btn, .alpha-btn').forEach(b => b.classList.remove('active'));
  applyFilters();
}

function clearAllFilters() {
  activeFilters = {
    nameSearch: '', startsWith: '', country: '', seriesId: '',
    radius: null, visitedOnly: false, unvisitedOnly: false,
    hideUnmatched: false, clustering: activeFilters.clustering, challenges: []
  };
  document.getElementById('fb-hide-unmatched')?.classList.remove('active');
  const hideRow = document.querySelector('.fb-hide-row');
  if (hideRow) hideRow.style.display = 'none';
  const nameEl    = document.getElementById('fb-name');
  const countryEl = document.getElementById('fb-country');
  if (nameEl)    nameEl.value    = '';
  if (countryEl) countryEl.value = '';
  document.querySelectorAll('.fb-series-btn, .fb-letter-btn, .alpha-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('fb-visited')?.classList.remove('active');
  document.getElementById('fb-unvisited')?.classList.remove('active');
  // Clear origin and closest
  clearOrigin();
  applyFilters();
}

// ─── URL hash — two-way sync ──────────────────────────────────────────────────
// Format: #q=search&country=97&series=1&letter=A&challenge=regex&visited=1&radius=lat,lng,km
// Simple key=value pairs, human-readable, easily bookmarkable.

let _suppressHashChange = false;

function writeHash() {
  const params = new URLSearchParams();

  if (activeFilters.nameSearch) params.set('q',        activeFilters.nameSearch);
  if (activeFilters.startsWith) params.set('letter',   activeFilters.startsWith);
  if (activeFilters.country)    params.set('country',  activeFilters.country);
  if (activeFilters.seriesId)   params.set('series',   activeFilters.seriesId);
  if (activeFilters.visitedOnly)   params.set('visited', '1');
  if (activeFilters.unvisitedOnly) params.set('visited', '0');
  // hideUnmatched is not persisted — it's a display mode, not a filter
  if (activeFilters.challenges && activeFilters.challenges.length > 0) {
    activeFilters.challenges.forEach(c => params.append('challenge', c));
  }
  if (activeFilters.radius) {
    params.set('radius', `${activeFilters.radius.lat},${activeFilters.radius.lng},${activeFilters.radius.km}`);
  }

  const hash = params.toString() ? '#' + params.toString() : '';
  _suppressHashChange = true;
  history.replaceState(null, '', window.location.pathname + hash);
  _suppressHashChange = false;
}

function readHash() {
  const hash = window.location.hash.slice(1);
  if (!hash) return;

  // Support both new format (key=value) and old format (matches-xxx, startsWith-xxx etc.)
  if (hash.includes('=')) {
    // New format
    const params = new URLSearchParams(hash);
    activeFilters.nameSearch = params.get('q')       || '';
    activeFilters.startsWith = params.get('letter')  || '';
    activeFilters.country    = params.get('country') || '';
    activeFilters.seriesId   = params.get('series')  || '';
    activeFilters.hideUnmatched = false;  // never restore from hash — display-only state
    const visited = params.get('visited');
    activeFilters.visitedOnly   = visited === '1';
    activeFilters.unvisitedOnly = visited === '0';
    activeFilters.challenges    = params.getAll('challenge');
    const radius = params.get('radius');
    if (radius) {
      const [lat, lng, km] = radius.split(',').map(Number);
      if (!isNaN(lat) && !isNaN(lng) && !isNaN(km) && km > 0) {
        activeFilters.radius = { lat, lng, km };
        // Restore origin pin and circle
        setOrigin(lat, lng);
        const kmSlider = document.getElementById('radius-km');
        if (kmSlider) kmSlider.value = km;
        const lbl = document.getElementById('radius-label');
        if (lbl) lbl.textContent = `${km} km`;
        updateRadiusCircle(lat, lng, km);
      }
    }
  } else {
    // Legacy format — old sidebar hash links still work
    const parts = hash.split('#');
    activeFilters.challenges = [];
    parts.forEach(part => {
      if (part.startsWith('matches-'))    activeFilters.challenges.push(decodeURIComponent(part.slice(8)));
      else if (part.startsWith('startsWith-')) activeFilters.startsWith = decodeURIComponent(part.slice(11));
      else if (part.startsWith('contains-'))  activeFilters.nameSearch  = decodeURIComponent(part.slice(9));
      else if (part.startsWith('seriesid-'))  activeFilters.seriesId    = part.slice(9);
      else if (part.startsWith('country-')) {
        const raw = part.slice(8).toLowerCase();
        const map = { uk:'97', au:'3', de:'32', pl:'74', nl:'64', ie:'42', us:'98' };
        activeFilters.country = map[raw] || '';
      }
    });
  }

  // Sync UI controls to reflect restored filter state
  const nameEl    = document.getElementById('fb-name');
  const countryEl = document.getElementById('fb-country');
  if (nameEl    && activeFilters.nameSearch) nameEl.value    = activeFilters.nameSearch;
  if (countryEl && activeFilters.country)    countryEl.value = activeFilters.country;
  if (activeFilters.seriesId) {
    document.querySelectorAll('.fb-series-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.series === activeFilters.seriesId);
    });
  }
  if (activeFilters.visitedOnly)   document.getElementById('fb-visited')?.classList.add('active');
  if (activeFilters.unvisitedOnly) document.getElementById('fb-unvisited')?.classList.add('active');
  if (activeFilters.hideUnmatched) document.getElementById('fb-hide-unmatched')?.classList.add('active');
  if (activeFilters.startsWith) {
    document.querySelectorAll('.alpha-btn').forEach(b => {
      b.classList.toggle('active', b.textContent === activeFilters.startsWith);
    });
  }
}

window.addEventListener('hashchange', () => {
  if (_suppressHashChange) return;
  if (geoLoaded) { readHash(); applyFilters(); }
});

// ─── UI status helpers ────────────────────────────────────────────────────────

function updateFilterStatus() {
  const el            = document.getElementById('filter-status');
  const hideBtn       = document.getElementById('fb-hide-unmatched');
  const hideContainer = document.querySelector('.fb-hide-row');

  if (hasActiveFilter()) {
    const matched = allEvents.filter(f => eventMatchesFilters(f)).length;
    if (el) { el.textContent = `${matched} / ${allEvents.length} events`; el.style.display = 'block'; }
    if (hideBtn)       hideBtn.style.display       = '';
    if (hideContainer) hideContainer.style.display = '';
  } else {
    if (el) el.style.display = 'none';
    if (hideBtn)       hideBtn.style.display       = 'none';
    if (hideContainer) hideContainer.style.display = 'none';
    // If no filter is active, hideUnmatched can't meaningfully be on — reset it
    if (activeFilters.hideUnmatched) {
      activeFilters.hideUnmatched = false;
      hideBtn?.classList.remove('active');
    }
  }
}

function updateClearBtn() {
  document.getElementById('clear-filters-btn')
    ?.classList.toggle('visible', hasActiveFilter());
}

function setLoadingState(loading) {
  const el = document.getElementById('loading-status');
  if (!el) return;
  el.style.display = loading ? 'block' : 'none';
}

// ─── Haversine ────────────────────────────────────────────────────────────────

function haversineKm(lat1, lon1, lat2, lon2) {
  const R    = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a    = Math.sin(dLat/2)**2 +
               Math.cos(lat1 * Math.PI/180) * Math.cos(lat2 * Math.PI/180) *
               Math.sin(dLon/2)**2;
  return R * 2 * Math.asin(Math.sqrt(a));
}

// ─── GeoJSON loading ──────────────────────────────────────────────────────────

setLoadingState(true);

fetch('events.json')
  .then(r => r.json())
  .then(data => {
    allEvents = (data.events || data).features;
    geoLoaded = true;

    populateCountryDropdown();

    allEvents.forEach(feature => {
      const [lng, lat] = feature.geometry.coordinates;
      const props      = feature.properties;
      const name       = props.EventShortName || props.eventname;
      const eventUrl   = `https://www.parkrun.org.uk/${props.eventname}`;

      const marker = L.marker([lat, lng], { icon: ICONS[10].unvisited });

      marker.bindPopup(() => {
        const isVisited    = visitedSet.has(props.eventname);
        const country      = countryLabel(props.countrycode);
        const series       = props.seriesid === 2 ? ' · Junior' : '';
        const evData       = athleteData?.events?.[props.eventname];

        let visitedHtml = '';
        if (isVisited && evData) {
          const parts = [];
          if (evData.count > 1) parts.push(`${evData.count} visits`);
          else parts.push('1 visit');
          if (evData.first && evData.last && evData.first !== evData.last)
            parts.push(`${evData.first} → ${evData.last}`);
          else if (evData.first)
            parts.push(evData.first);
          if (evData.best_time) parts.push(`best ${evData.best_time}`);
          if (evData.pb) parts.push('🏅 PB here');
          visitedHtml = `<div style="font-size:11px;color:#27ae60;font-weight:600;margin-bottom:8px">
            ✓ ${parts.join(' · ')}
          </div>`;
        } else if (isVisited) {
          visitedHtml = `<div style="font-size:11px;color:#27ae60;font-weight:600;margin-bottom:8px">✓ Visited</div>`;
        } else {
          visitedHtml = `<div style="font-size:11px;color:#aaa;margin-bottom:8px">Not visited</div>`;
        }

        return `<div style="min-width:180px">
          <div style="font-weight:600;font-size:13px;margin-bottom:4px">${props.EventLongName || name}</div>
          <div style="font-size:11px;color:#666;margin-bottom:2px">${props.EventLocation || ''}${series}</div>
          <div style="font-size:11px;color:#666;margin-bottom:6px">${country}</div>
          ${visitedHtml}
          <a href="${eventUrl}/results/" target="_blank" style="font-size:12px;color:#27ae60;font-weight:500;text-decoration:none">Results →</a>
          &nbsp;
          <a href="${eventUrl}/" target="_blank" style="font-size:12px;color:#27ae60;font-weight:500;text-decoration:none">Event page →</a>
        </div>`;
      });

      marker.addTo(map);
      markerMap[feature.id] = marker;
    });

    setLoadingState(false);

    // Apply any hash filter that was waiting, then re-colour if athlete arrived first
    readHash();
    applyFilters();
  })
  .catch(err => {
    console.error('Failed to load events.json', err);
    const el = document.getElementById('loading-status');
    if (el) { el.textContent = 'Failed to load events — check events.json exists'; el.style.color = '#e74c3c'; }
  });

// ─── Athlete loading ──────────────────────────────────────────────────────────

function loadAthlete(id) {
  if (!id) return;
  athleteId = id;
  localStorage.setItem('parkrun-athlete', id);

  fetch(`athletes/${id}.json`)
    .then(r => {
      if (!r.ok) throw new Error(`No data for athlete ${id}`);
      return r.json();
    })
    .then(data => {
      // Support both formats:
      //   Old: ["chippenham","bushy",...]
      //   New: { athlete_id, total_runs, home_event, events: { slug: {...} } }
      if (Array.isArray(data)) {
        visitedSet  = new Set(data);
        athleteData = null;
      } else {
        visitedSet  = new Set(Object.keys(data.events || {}));
        athleteData = data;
      }

      const el = document.getElementById('athlete-count');
      if (el) el.textContent = `${visitedSet.size} visited`;
      if (geoLoaded) applyFilters();
      if (typeof refreshAthleteUI === 'function') refreshAthleteUI();
    })
    .catch(() => {
      const el = document.getElementById('athlete-count');
      if (el) el.textContent = `Could not load athlete ${id}`;
    });
}

// ─── Country data ─────────────────────────────────────────────────────────────

const COUNTRY_INFO = {
  0:  { name: 'Global',       flag: '🌍' },
  3:  { name: 'Australia',    flag: '🇦🇺' },
  4:  { name: 'Austria',      flag: '🇦🇹' },
  14: { name: 'Canada',       flag: '🇨🇦' },
  23: { name: 'Denmark',      flag: '🇩🇰' },
  30: { name: 'Finland',      flag: '🇫🇮' },
  32: { name: 'Germany',      flag: '🇩🇪' },
  42: { name: 'Ireland',      flag: '🇮🇪' },
  44: { name: 'Italy',        flag: '🇮🇹' },
  46: { name: 'Japan',        flag: '🇯🇵' },
  54: { name: 'Lithuania',    flag: '🇱🇹' },
  57: { name: 'Malaysia',     flag: '🇲🇾' },
  64: { name: 'Netherlands',  flag: '🇳🇱' },
  65: { name: 'New Zealand',  flag: '🇳🇿' },
  67: { name: 'Norway',       flag: '🇳🇴' },
  74: { name: 'Poland',       flag: '🇵🇱' },
  82: { name: 'Singapore',    flag: '🇸🇬' },
  85: { name: 'South Africa', flag: '🇿🇦' },
  88: { name: 'Sweden',       flag: '🇸🇪' },
  97: { name: 'UK',           flag: '🇬🇧' },
  98: { name: 'USA',          flag: '🇺🇸' },
};

function countryLabel(code) {
  const info = COUNTRY_INFO[code];
  return info ? `${info.name} ${info.flag}` : `Country ${code}`;
}

function populateCountryDropdown() {
  const codes = {};
  allEvents.forEach(f => {
    const cc = f.properties.countrycode;
    codes[cc] = (codes[cc] || 0) + 1;
  });
  const sel = document.getElementById('fb-country');
  if (!sel) return;
  Object.entries(codes).sort((a,b) => b[1]-a[1]).forEach(([code, count]) => {
    const opt = document.createElement('option');
    opt.value       = code;
    opt.textContent = `${countryLabel(code)} (${count})`;
    sel.appendChild(opt);
  });
}

// ─── Origin pin ───────────────────────────────────────────────────────────────
// Single draggable pin that drives both radius filtering and closest-unvisited.
// Placed either via geolocation or by clicking the map.

let originPin    = null;
let radiusCircle = null;

const ORIGIN_ICON = L.divIcon({
  className: '',
  html: `<svg width="24" height="36" viewBox="0 0 24 36" xmlns="http://www.w3.org/2000/svg">
    <path d="M12 0C5.37 0 0 5.37 0 12c0 9 12 24 12 24s12-15 12-24C24 5.37 18.63 0 12 0z"
          fill="#e67e22" stroke="white" stroke-width="1.5"/>
    <circle cx="12" cy="12" r="5" fill="white"/>
  </svg>`,
  iconSize:    [24, 36],
  iconAnchor:  [12, 36],
  popupAnchor: [0, -36]
});

function setOrigin(lat, lng) {
  if (originPin) {
    originPin.setLatLng([lat, lng]);
  } else {
    originPin = L.marker([lat, lng], { icon: ORIGIN_ICON, draggable: true, zIndexOffset: 9999 })
      .addTo(map)
      .bindTooltip('Origin — drag to move', { permanent: false });
    originPin.on('drag',    () => { const ll = originPin.getLatLng(); onOriginMoved(ll.lat, ll.lng); });
    originPin.on('dragend', () => { const ll = originPin.getLatLng(); onOriginMoved(ll.lat, ll.lng); });
  }
  if (typeof updateOriginBar === 'function') updateOriginBar(true, lat, lng);
  onOriginMoved(lat, lng);
}

function onOriginMoved(lat, lng) {
  if (typeof updateOriginBar === 'function') updateOriginBar(true, lat, lng);
  const km = parseInt(document.getElementById('radius-km')?.value) || 0;
  if (km > 0) {
    activeFilters.radius = { lat, lng, km };
    updateRadiusCircle(lat, lng, km);
  } else {
    activeFilters.radius = null;
    if (radiusCircle) { map.removeLayer(radiusCircle); radiusCircle = null; }
  }
  applyFilters();
}

function updateRadiusCircle(lat, lng, km) {
  if (radiusCircle) map.removeLayer(radiusCircle);
  radiusCircle = L.circle([lat, lng], {
    radius: km * 1000, color: '#e67e22', fillColor: '#e67e22',
    fillOpacity: 0.06, weight: 1.5, dashArray: '6 4'
  }).addTo(map);
}

function clearOrigin() {
  if (originPin)    { map.removeLayer(originPin);    originPin    = null; }
  if (radiusCircle) { map.removeLayer(radiusCircle); radiusCircle = null; }
  activeFilters.radius = null;
  const kmSlider = document.getElementById('radius-km');
  if (kmSlider) kmSlider.value = 0;
  const lbl = document.getElementById('radius-label');
  if (lbl) lbl.textContent = 'Off';
  if (typeof updateOriginBar === 'function') updateOriginBar(false);
  applyFilters();
}

// ─── Pick-on-map mode ─────────────────────────────────────────────────────────

let pickingMode = false;

function enterPickMode() {
  pickingMode = true;
  map.getContainer().style.cursor = 'crosshair';
  document.getElementById('place-pin-btn').classList.add('active');
}

function exitPickMode() {
  pickingMode = false;
  map.getContainer().style.cursor = '';
  document.getElementById('place-pin-btn').classList.remove('active');
}

map.on('click', e => {
  if (!pickingMode) return;
  exitPickMode();
  setOrigin(e.latlng.lat, e.latlng.lng);
});

// ─── Geolocation ──────────────────────────────────────────────────────────────

function locateMe() {
  const btn = document.getElementById('locate-btn');
  if (btn) btn.textContent = 'Locating…';
  exitPickMode();
  map.locate({ setView: false })
    .on('locationfound', e => {
      if (btn) btn.textContent = 'My location';
      setOrigin(e.latlng.lat, e.latlng.lng);
      map.setView(e.latlng, Math.max(map.getZoom(), 10));
    })
    .on('locationerror', () => {
      if (btn) btn.textContent = 'My location';
      alert('Could not determine your location.');
    });
}

// ─── Filter builder wire-up ───────────────────────────────────────────────────

function initFilterBuilder() {
  document.getElementById('fb-name')?.addEventListener('input', e => {
    activeFilters.nameSearch = e.target.value.trim();
    activeFilters.challenges = [];
    applyFilters();
  });

  document.getElementById('fb-country')?.addEventListener('change', e => {
    activeFilters.country = e.target.value;
    applyFilters();
  });

  document.querySelectorAll('.fb-series-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const val = btn.dataset.series;
      if (activeFilters.seriesId === val) {
        activeFilters.seriesId = '';
        btn.classList.remove('active');
      } else {
        activeFilters.seriesId = val;
        document.querySelectorAll('.fb-series-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
      }
      applyFilters();
    });
  });

  document.getElementById('fb-visited')?.addEventListener('click', function() {
    activeFilters.visitedOnly   = !activeFilters.visitedOnly;
    activeFilters.unvisitedOnly = false;
    this.classList.toggle('active', activeFilters.visitedOnly);
    document.getElementById('fb-unvisited')?.classList.remove('active');
    applyFilters();
  });

  document.getElementById('fb-unvisited')?.addEventListener('click', function() {
    activeFilters.unvisitedOnly = !activeFilters.unvisitedOnly;
    activeFilters.visitedOnly   = false;
    this.classList.toggle('active', activeFilters.unvisitedOnly);
    document.getElementById('fb-visited')?.classList.remove('active');
    applyFilters();
  });

  // Origin pin
  document.getElementById('locate-btn')?.addEventListener('click', locateMe);
  document.getElementById('place-pin-btn')?.addEventListener('click', () => {
    if (pickingMode) exitPickMode(); else enterPickMode();
  });
  document.getElementById('clear-origin-btn')?.addEventListener('click', clearOrigin);

  // Radius slider — 0 = off
  const radiusSlider = document.getElementById('radius-km');
  const radiusLabel  = document.getElementById('radius-label');
  radiusSlider?.addEventListener('input', e => {
    const km = parseInt(e.target.value);
    if (radiusLabel) radiusLabel.textContent = km === 0 ? 'Off' : `${km} km`;
    if (!originPin) return;
    const { lat, lng } = originPin.getLatLng();
    if (km > 0) {
      activeFilters.radius = { lat, lng, km };
      updateRadiusCircle(lat, lng, km);
    } else {
      activeFilters.radius = null;
      if (radiusCircle) { map.removeLayer(radiusCircle); radiusCircle = null; }
    }
    if (closestMode) applyClosest(); else applyFilters();
  });

  // Display options
  document.getElementById('fb-hide-unmatched')?.addEventListener('click', function() {
    activeFilters.hideUnmatched = !activeFilters.hideUnmatched;
    this.classList.toggle('active', activeFilters.hideUnmatched);
    applyFilters();
  });

  document.getElementById('fb-cluster')?.addEventListener('click', function() {
    activeFilters.clustering = !activeFilters.clustering;
    this.classList.toggle('active', activeFilters.clustering);
    if (activeFilters.clustering) enableClustering();
    else disableClustering();
    applyFilters();
  });

  document.getElementById('clear-filters-btn')?.addEventListener('click', clearAllFilters);

  const athleteInput = document.getElementById('athlete-id-input');
  if (athleteInput) {
    athleteInput.addEventListener('keydown', e => {
      if (e.key === 'Enter') loadAthlete(athleteInput.value.trim());
    });
    document.getElementById('load-athlete-btn')?.addEventListener('click', () => {
      loadAthlete(athleteInput.value.trim());
    });
  }

  document.querySelectorAll('.tile-btn').forEach(btn => {
    btn.addEventListener('click', () => setTileLayer(btn.dataset.tile));
  });

  // Initialise origin bar to show the "no origin" state
  if (typeof updateOriginBar === 'function') updateOriginBar(false);
}

document.addEventListener('DOMContentLoaded', initFilterBuilder);
