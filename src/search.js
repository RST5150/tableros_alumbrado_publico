import L from 'leaflet';

const MAX_RESULTS = 8;
const SEARCH_ICON = `<svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M15.5 14h-.79l-.28-.27a6.5 6.5 0 1 0-.7.7l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0A4.5 4.5 0 1 1 14 9.5 4.5 4.5 0 0 1 9.5 14z"/></svg>`;

function normalize(str) {
  return (str || '')
    .toString()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .trim();
}

function resultLabel({ row, direccion }) {
  const codigo = row?.Nombre ? `Tablero ${row.Nombre}` : 'Tablero';
  return { title: codigo, subtitle: direccion || row?.Calle || '' };
}

// Control de mapa estilo "Buscar en el mapa" de Google My Maps: caja blanca con lupa arriba
// a la izquierda y un desplegable de resultados a medida que se escribe. Busca por código
// (Nombre) y por dirección (Calle/Altura/Letra/Bis) entre los tableros que el usuario puede ver.
export function initSearch(map, getSearchableTableros) {
  const SearchControl = L.Control.extend({
    options: { position: 'topleft' },
    onAdd() {
      const container = L.DomUtil.create('div', 'map-search leaflet-bar');
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
        if (!map.hasLayer(match.layerGroup)) match.layerGroup.addTo(map);
        map.flyTo(match.marker.getLatLng(), Math.max(map.getZoom(), 18));
        match.marker.openPopup();
        closeResults();
        input.value = resultLabel(match).title;
        clearBtn.hidden = false;
      }

      function runSearch() {
        const q = normalize(input.value);
        clearBtn.hidden = input.value.length === 0;
        if (q.length < 2) {
          closeResults();
          return;
        }
        const all = getSearchableTableros();
        matches = all
          .filter((m) => normalize(m.row?.Nombre).includes(q) || normalize(m.direccion).includes(q))
          .slice(0, MAX_RESULTS);
        activeIndex = -1;
        renderResults();
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
        input.focus();
      });

      document.addEventListener('click', (e) => {
        if (!container.contains(e.target)) closeResults();
      });

      return container;
    },
  });

  new SearchControl().addTo(map);
}
