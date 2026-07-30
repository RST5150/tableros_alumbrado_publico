import L from 'leaflet';

const MAX_RESULTS = 8;
const SEARCH_ICON = `<svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M15.5 14h-.79l-.28-.27a6.5 6.5 0 1 0-.7.7l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0A4.5 4.5 0 1 1 14 9.5 4.5 4.5 0 0 1 9.5 14z"/></svg>`;

// Ícono propio (SVG inline) en vez del marcador default de Leaflet: ese default referencia
// imágenes por una ruta relativa que se rompe al empaquetar con Vite y queda invisible — mismo
// motivo por el que los tableros ya usan íconos propios (public/icons/) en vez del default.
const ADDRESS_PIN_ICON = L.divIcon({
  className: 'address-pin',
  html: '<svg viewBox="0 0 24 24" width="32" height="32"><path fill="#ea4335" stroke="#fff" stroke-width="1" d="M12 2C7.58 2 4 5.58 4 10c0 5.25 6.72 11.19 7 11.44a1 1 0 0 0 1.3 0C12.28 21.19 20 15.25 20 10c0-4.42-3.58-8-8-8zm0 11a3 3 0 1 1 0-6 3 3 0 0 1 0 6z"/></svg>',
  iconSize: [32, 32],
  iconAnchor: [16, 32],
  popupAnchor: [0, -32],
});

// Geocodifica direcciones reales (estilo Google Maps: "Calle 1234" te acerca ahí exista o no
// un tablero) contra Nominatim (OpenStreetMap) — gratis, sin API key, mismo criterio que los
// mapas base. Se sesga a Rosario (donde está todo el mapa) para evitar calles homónimas de
// otras ciudades. Debounce + descarte de respuestas viejas para no saturar el servicio
// gratuito ni pisar un resultado más nuevo con uno que tardó más en volver.
const GEOCODE_DEBOUNCE_MS = 450;
const GEOCODE_MIN_CHARS = 4;
const GEOCODE_BIAS = 'Rosario, Santa Fe, Argentina';

// A diferencia de los datos de los CSV (curados por el equipo), display_name viene de OSM sin
// pasar por nadie de acá: se escapa antes de insertarlo como HTML en el desplegable.
function escapeHtml(str) {
  return str.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function geocodeAddress(query) {
  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=ar&q=${encodeURIComponent(`${query}, ${GEOCODE_BIAS}`)}`;
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) return null;
    const data = await res.json();
    const hit = data[0];
    if (!hit) return null;
    return {
      kind: 'address',
      label: escapeHtml(hit.display_name.split(',').slice(0, 3).join(',')),
      lat: parseFloat(hit.lat),
      lon: parseFloat(hit.lon),
    };
  } catch {
    return null;
  }
}

function normalize(str) {
  return (str || '')
    .toString()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .trim();
}

function resultLabel(match) {
  if (match.kind === 'address') {
    return { title: `📍 ${match.label}`, subtitle: 'Ir a esta dirección' };
  }
  const codigo = match.row?.Nombre ? `Tablero ${match.row.Nombre}` : 'Tablero';
  return { title: codigo, subtitle: match.direccion || match.row?.Calle || '' };
}

// Buscador estilo "Buscar en el mapa" de Google My Maps: caja blanca con lupa, centrada
// arriba del mapa, con un desplegable de resultados a medida que se escribe. Busca por código
// (Nombre) y por dirección (Calle/Altura/Letra/Bis) entre los tableros que el usuario puede ver,
// y en paralelo geocodifica la dirección tipeada (ver geocodeAddress) para poder ir a
// cualquier dirección real del mapa, tenga o no un tablero.
//
// Se cuelga directo del contenedor del mapa (no de un L.Control de esquina): así se puede
// centrar horizontalmente arriba del todo con CSS, algo que el sistema de 4 esquinas de
// Leaflet no permite hacer para un único control sin desalinear a los demás que comparten esa
// esquina.
export function initSearch(map, getSearchableTableros) {
  const container = L.DomUtil.create('div', 'map-search', map.getContainer());
  container.innerHTML = `
    <div class="map-search-box">
      <span class="map-search-icon">${SEARCH_ICON}</span>
      <input type="text" placeholder="Buscar por código o dirección" autocomplete="off" />
      <button type="button" class="map-search-clear" aria-label="Limpiar" hidden>&times;</button>
    </div>
    <ul class="map-search-results" hidden></ul>
  `;
  L.DomEvent.disableClickPropagation(container);
  L.DomEvent.disableScrollPropagation(container);

  const input = container.querySelector('input');
  const clearBtn = container.querySelector('.map-search-clear');
  const resultsEl = container.querySelector('.map-search-results');
  let matches = [];
  let activeIndex = -1;
  let geocodeTimer = null;
  let geocodeSeq = 0;
  let addressMarker = null;

  function clearAddressMarker() {
    if (addressMarker) {
      map.removeLayer(addressMarker);
      addressMarker = null;
    }
  }

  function closeResults() {
    resultsEl.hidden = true;
    resultsEl.innerHTML = '';
    matches = [];
    activeIndex = -1;
  }

  function renderResults() {
    if (matches.length === 0) {
      resultsEl.hidden = true;
      resultsEl.innerHTML = '';
      return;
    }
    resultsEl.hidden = false;
    resultsEl.innerHTML = matches
      .map((m, i) => {
        const { title, subtitle } = resultLabel(m);
        return `<li data-index="${i}" class="${i === activeIndex ? 'active' : ''}">
          <span class="map-search-result-title">${title}</span>
          ${subtitle ? `<span class="map-search-result-subtitle">${subtitle}</span>` : ''}
        </li>`;
      })
      .join('');
  }

  function selectMatch(match) {
    if (!match) return;
    closeResults();
    input.value = resultLabel(match).title;
    clearBtn.hidden = false;

    if (match.kind === 'address') {
      clearAddressMarker();
      addressMarker = L.marker([match.lat, match.lon], { icon: ADDRESS_PIN_ICON }).addTo(map);
      const targetZoom = Math.max(map.getZoom(), 17);
      map.flyTo([match.lat, match.lon], targetZoom, { duration: 0.6 });
      return;
    }

    clearAddressMarker();
    if (!map.hasLayer(match.layerGroup)) match.layerGroup.addTo(map);
    const targetZoom = Math.max(map.getZoom(), 18);
    // Duración corta y fija: con flyTo por defecto el "vuelo" puede sentirse lento en
    // distancias largas. Se abre el popup apenas termina de moverse (y también de
    // inmediato, por si el destino coincide con la vista actual y "moveend" no dispara).
    map.flyTo(match.marker.getLatLng(), targetZoom, { duration: 0.6 });
    map.once('moveend', () => match.marker.openPopup());
    match.marker.openPopup();
  }

  function runSearch() {
    const rawQuery = input.value.trim();
    clearBtn.hidden = rawQuery.length === 0;
    const q = normalize(rawQuery);
    if (geocodeTimer) clearTimeout(geocodeTimer);

    if (q.length < 2) {
      geocodeSeq++; // invalida cualquier geocodificación en vuelo
      closeResults();
      return;
    }

    const all = getSearchableTableros();
    matches = all
      .filter((m) => normalize(m.row?.Nombre).includes(q) || normalize(m.direccion).includes(q))
      .slice(0, MAX_RESULTS)
      .map((m) => ({ kind: 'tablero', ...m }));
    activeIndex = -1;
    renderResults();

    if (q.length < GEOCODE_MIN_CHARS) {
      geocodeSeq++;
      return;
    }
    const seq = ++geocodeSeq;
    geocodeTimer = setTimeout(async () => {
      const result = await geocodeAddress(rawQuery);
      // La búsqueda cambió mientras esperábamos la respuesta, o no hubo resultado: se
      // descarta (evita pisar resultados más nuevos con uno que tardó más en volver).
      if (seq !== geocodeSeq || !result) return;
      matches = [...matches, result].slice(0, MAX_RESULTS + 1);
      renderResults();
    }, GEOCODE_DEBOUNCE_MS);
  }

  input.addEventListener('input', runSearch);
  input.addEventListener('focus', () => {
    if (input.value.length >= 2) runSearch();
  });

  input.addEventListener('keydown', (e) => {
    if (resultsEl.hidden) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      activeIndex = Math.min(activeIndex + 1, matches.length - 1);
      renderResults();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      activeIndex = Math.max(activeIndex - 1, 0);
      renderResults();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      selectMatch(matches[activeIndex] ?? matches[0]);
    } else if (e.key === 'Escape') {
      closeResults();
    }
  });

  resultsEl.addEventListener('click', (e) => {
    const li = e.target.closest('li');
    if (!li) return;
    selectMatch(matches[Number(li.dataset.index)]);
  });

  clearBtn.addEventListener('click', () => {
    input.value = '';
    clearBtn.hidden = true;
    closeResults();
    clearAddressMarker();
    input.focus();
  });

  document.addEventListener('click', (e) => {
    if (!container.contains(e.target)) closeResults();
  });
}
