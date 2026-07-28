import L from 'leaflet';
import Papa from 'papaparse';
import { CONFIG } from './config.js';

const isUrl = (v) => /^https?:\/\//i.test(v || '');

function direccion(row) {
  const partes = [row.Calle, row.Altura].filter(Boolean).join(' ');
  const letra = row.Letra ? row.Letra : '';
  const bis = row.Bis ? row.Bis : '';
  return [partes, letra, bis].filter(Boolean).join(' ');
}

function pointPopupHtml(row) {
  const inspeccionado = (row['Última Inspección'] || '').trim();
  const dir = direccion(row);
  const extraRows = [
    ['Tipo', row.Tipo],
    ['Clasificación', row['Clasificación']],
    ['Ubicación', row['Tipo de ubicación']],
    ['Responsable', row.Responsable],
    ...(isUrl(row.Plano) ? [['Plano', `<a href="${row.Plano}" target="_blank" rel="noopener">Ver plano</a>`]] : []),
    ...(isUrl(row['Foto Externa']) ? [['Foto ext.', `<a href="${row['Foto Externa']}" target="_blank" rel="noopener">Ver foto</a>`]] : []),
    ...(isUrl(row['Foto Interna']) ? [['Foto int.', `<a href="${row['Foto Interna']}" target="_blank" rel="noopener">Ver foto</a>`]] : []),
  ].filter(([, v]) => v);

  return `
    <div class="tablero-popup">
      <h3>Tablero ${row.Nombre || 'sin código'}</h3>
      <span class="estado-badge ${inspeccionado ? 'estado-ok' : 'estado-pendiente'}">
        ${inspeccionado ? `Inspeccionado: ${inspeccionado}` : 'Sin inspección registrada'}
      </span>
      ${dir ? `<p>${dir}</p>` : ''}
      <dl>
        ${extraRows.map(([label, value]) => `<dt>${label}</dt><dd>${value}</dd>`).join('')}
      </dl>
    </div>
  `;
}

async function loadPolygonLayer(def) {
  const res = await fetch(def.file);
  if (!res.ok) throw new Error(`No se pudo cargar ${def.file}`);
  const geojson = await res.json();
  return L.geoJSON(geojson, {
    style: (feature) => ({
      color: feature.properties?.color || def.color,
      weight: 1.5,
      fillColor: feature.properties?.fillColor || def.color,
      fillOpacity: feature.properties?.fillOpacity ?? 0.25,
    }),
    onEachFeature: (feature, layer) => {
      const name = feature.properties?.name;
      // Permanent (no sólo al pasar el mouse): muestra el número de zona/subzona/sector
      // siempre que esa capa esté prendida.
      if (name) layer.bindTooltip(name, { permanent: true, direction: 'center', className: 'polygon-label' });
    },
  });
}

async function loadPointLayer(def) {
  const res = await fetch(def.url);
  if (!res.ok) throw new Error(`No se pudo cargar ${def.url}`);
  const text = await res.text();
  const { data } = Papa.parse(text, { header: true, skipEmptyLines: true });

  const markers = [];
  for (const row of data) {
    const lat = parseFloat(row.Lat);
    const lon = parseFloat(row.Lon);
    if (Number.isNaN(lat) || Number.isNaN(lon)) continue;
    const marker = L.circleMarker([lat, lon], {
      pane: 'tableros',
      radius: 7,
      color: def.color,
      weight: 2,
      fillColor: def.color,
      fillOpacity: 0.85,
    });
    marker.bindPopup(pointPopupHtml(row));
    markers.push(marker);
  }
  return L.layerGroup(markers);
}

// Crea el mapa, carga todas las capas definidas en CONFIG y arma el control de capas
// mostrando solo las que están en `allowedIds`. Devuelve una función para refrescar
// la visibilidad cuando cambian los permisos (login/logout).
export async function buildMap(allowedIds) {
  const map = L.map('map').setView(CONFIG.mapCenter, CONFIG.mapZoom);

  // Pane propio con z-index por encima del de polígonos (Zonas/Subzonas/Sectores), para que
  // los tableros siempre se vean arriba sin importar el orden en que se activen las capas.
  map.createPane('tableros');
  map.getPane('tableros').style.zIndex = 650;

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    maxZoom: 20,
  }).addTo(map);

  const allDefs = [
    ...CONFIG.polygonLayers.map((d) => ({ ...d, kind: 'polygon' })),
    ...CONFIG.pointLayers.map((d) => ({ ...d, kind: 'point' })),
  ];

  const entries = await Promise.all(
    allDefs.map(async (def) => {
      try {
        const layer = def.kind === 'polygon' ? await loadPolygonLayer(def) : await loadPointLayer(def);
        return { def, layer };
      } catch (err) {
        console.error(`Error cargando capa "${def.id}":`, err);
        return null;
      }
    })
  );

  const loaded = entries.filter(Boolean);
  const control = L.control.layers(null, null, { collapsed: false }).addTo(map);

  // Capas que ya se agregaron al selector (aunque no estén tildadas en el mapa). Sirve para
  // distinguir "recién habilitada -> aplicar defaultVisible" de "el usuario la destildó a mano".
  const registered = new Set();

  function applyVisibility(ids) {
    for (const { def, layer } of loaded) {
      const isAllowed = ids.has(def.id);
      if (isAllowed && !registered.has(def.id)) {
        control.addOverlay(layer, def.label);
        registered.add(def.id);
        if (def.defaultVisible !== false) layer.addTo(map);
      } else if (!isAllowed && registered.has(def.id)) {
        map.removeLayer(layer);
        control.removeLayer(layer);
        registered.delete(def.id);
      }
    }
  }

  applyVisibility(allowedIds);
  return { map, applyVisibility };
}
