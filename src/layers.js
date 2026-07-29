import L from 'leaflet';
import Papa from 'papaparse';
import { CONFIG } from './config.js';

const isUrl = (v) => /^https?:\/\//i.test(v || '');

// Preferencias del mapa (mapa base, qué capas quedaron tildadas, si se muestran las
// referencias) guardadas en el navegador para no tener que elegirlas de nuevo en cada visita.
const PREFS_KEY = 'mapa-tableros-prefs';

function loadPrefs() {
  try {
    return JSON.parse(localStorage.getItem(PREFS_KEY)) || {};
  } catch {
    return {};
  }
}

function savePrefs(prefs) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // Modo privado / cuota llena: no es crítico, solo se pierde la persistencia.
  }
}

function direccion(row) {
  const partes = [row.Calle, row.Altura].filter(Boolean).join(' ');
  const letra = row.Letra ? row.Letra : '';
  const bis = row.Bis ? row.Bis : '';
  return [partes, letra, bis].filter(Boolean).join(' ');
}

function pointPopupHtml(row, editable) {
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
      ${editable ? '<button type="button" class="edit-tablero-btn">Editar</button>' : ''}
    </div>
  `;
}

// Mismo ícono (rayo de color) que usaba cada zona en el mapa original de My Maps, extraído de
// los KMZ. Se cachea una sola instancia por capa en vez de crear un L.icon por marcador.
const tableroIconCache = new Map();
function tableroIcon(def) {
  if (!tableroIconCache.has(def.id)) {
    tableroIconCache.set(
      def.id,
      L.icon({ iconUrl: def.icon, iconSize: [28, 28], iconAnchor: [14, 14], popupAnchor: [0, -14] })
    );
  }
  return tableroIconCache.get(def.id);
}

// Reutilizable tanto al cargar el CSV inicial como al reflejar en el mapa un guardado hecho
// desde el formulario (ver forms.js / upsertTablero más abajo).
function buildTableroMarker(row, def, isEditable) {
  const latlng = [parseFloat(row.Lat), parseFloat(row.Lon)];
  const marker = def.icon
    ? L.marker(latlng, { pane: 'tableros', icon: tableroIcon(def) })
    : L.circleMarker(latlng, {
        pane: 'tableros',
        radius: 7,
        color: def.color,
        weight: 2,
        fillColor: def.color,
        fillOpacity: 0.85,
      });
  // Función (no string fija): así el popup se recalcula cada vez que se abre y refleja el
  // permiso de edición vigente en ese momento, aunque haya cambiado desde que se cargó la capa.
  marker.bindPopup(() => pointPopupHtml(marker.tableroRow, isEditable(def.id)));
  // Empieza cerrado: se abre solo por encima de cierto zoom (ver applyTableroLabelsVisibility),
  // si no con ~2200 tableros el mapa quedaría ilegible de entrada.
  if (row.Nombre) {
    marker.bindTooltip(row.Nombre, { permanent: true, direction: 'top', offset: [0, -12], className: 'tablero-label' });
    marker.closeTooltip();
  }
  marker.tableroRow = row;
  marker.tableroDireccion = direccion(row);
  marker.tableroDef = def;
  return marker;
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

async function loadPointLayer(def, isEditable) {
  const res = await fetch(def.url);
  if (!res.ok) throw new Error(`No se pudo cargar ${def.url}`);
  const text = await res.text();
  const { data } = Papa.parse(text, { header: true, skipEmptyLines: true });

  const markers = [];
  for (const row of data) {
    if (Number.isNaN(parseFloat(row.Lat)) || Number.isNaN(parseFloat(row.Lon))) continue;
    markers.push(buildTableroMarker(row, def, isEditable));
  }
  return L.layerGroup(markers);
}

function isMobileDevice() {
  return (
    /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) ||
    (navigator.maxTouchPoints > 0 && window.matchMedia('(pointer: coarse)').matches)
  );
}

// Botón "Mi ubicación" estilo Google Maps: al tocarlo centra el mapa en la posición actual
// (con zoom cómodo) y arranca (si no estaba corriendo) el watch en tiempo real del punto
// azul. Las actualizaciones de posición NUNCA recentran el mapa solas — eso es solo al
// volver a tocar el botón — para no pelear con el usuario mientras navega el mapa a mano.
// En mobile arranca solo (mismo flujo que un click) apenas se crea el mapa.
function initGeolocation(map) {
  map.createPane('userlocation');
  map.getPane('userlocation').style.zIndex = 700;

  let marker = null;
  let accuracyCircle = null;
  let watching = false;
  let btn = null;

  function onLocationFound(e) {
    if (!marker) {
      marker = L.circleMarker(e.latlng, {
        pane: 'userlocation',
        radius: 8,
        color: '#fff',
        weight: 2,
        fillColor: '#1a73e8',
        fillOpacity: 1,
      }).addTo(map);
      accuracyCircle = L.circle(e.latlng, {
        pane: 'userlocation',
        radius: e.accuracy,
        color: '#1a73e8',
        weight: 1,
        fillOpacity: 0.12,
      }).addTo(map);
    } else {
      marker.setLatLng(e.latlng);
      accuracyCircle.setLatLng(e.latlng).setRadius(e.accuracy);
    }
  }

  function onLocationError(e) {
    console.warn('No se pudo obtener la ubicación:', e.message);
    // Sin fix previo (ej. permiso denegado): el watch nunca va a tener éxito, así que se
    // corta y se destilda el botón en vez de dejarlo "activo" sin ubicación real.
    if (!marker) {
      watching = false;
      btn?.classList.remove('active');
      map.stopLocate();
    }
  }

  map.on('locationfound', onLocationFound);
  map.on('locationerror', onLocationError);

  function locateAndCenter() {
    if (!watching) {
      watching = true;
      btn?.classList.add('active');
      map.locate({ watch: true, enableHighAccuracy: true, maximumAge: 10000 });
    }
    if (marker) {
      map.setView(marker.getLatLng(), Math.max(map.getZoom(), 17));
    } else {
      map.once('locationfound', (e) => map.setView(e.latlng, Math.max(map.getZoom(), 17)));
    }
  }

  const LocateControl = L.Control.extend({
    options: { position: 'topleft' },
    onAdd() {
      btn = L.DomUtil.create('button', 'locate-btn leaflet-bar');
      btn.type = 'button';
      btn.title = 'Mi ubicación';
      btn.innerHTML = '📍';
      L.DomEvent.disableClickPropagation(btn);
      btn.addEventListener('click', locateAndCenter);
      return btn;
    },
  });
  new LocateControl().addTo(map);

  if (isMobileDevice()) locateAndCenter();
}

// Crea el mapa, carga todas las capas definidas en CONFIG y arma el control de capas
// mostrando solo las que están en `allowedIds`. Devuelve una función para refrescar
// la visibilidad cuando cambian los permisos (login/logout).
// `onEditRequest(def, row, marker)` se llama al apretar "Editar" en el popup de un tablero.
export async function buildMap(allowedIds, onEditRequest) {
  const map = L.map('map').setView(CONFIG.mapCenter, CONFIG.mapZoom);
  const prefs = loadPrefs();

  // Pane propio con z-index por encima del de polígonos (Zonas/Subzonas/Sectores), para que
  // los tableros siempre se vean arriba sin importar el orden en que se activen las capas.
  map.createPane('tableros');
  map.getPane('tableros').style.zIndex = 650;

  initGeolocation(map);

  // Solo mapas base gratuitos basados en datos de OpenStreetMap (sin API key).
  const baseLayers = {
    Callejero: L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      maxZoom: 20,
    }),
    Oscuro: L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
      subdomains: 'abcd',
      maxZoom: 20,
    }),
    Topográfico: L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
      attribution:
        'Map data: &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>, SRTM | Map style: &copy; <a href="https://opentopomap.org">OpenTopoMap</a> (CC-BY-SA)',
      maxZoom: 20,
      maxNativeZoom: 17,
    }),
  };
  const initialBase = prefs.baseLayer && baseLayers[prefs.baseLayer] ? prefs.baseLayer : 'Callejero';
  baseLayers[initialBase].addTo(map);
  L.control.layers(baseLayers, null, { collapsed: false }).addTo(map);
  map.on('baselayerchange', (e) => {
    prefs.baseLayer = e.name;
    savePrefs(prefs);
  });

  // Zonas de tableros que el usuario actual puede editar (independiente de cuáles ve). Se
  // define antes de cargar las capas porque cada popup de tablero la consulta en el momento
  // de abrirse (ver buildTableroMarker).
  let editableZonaIds = new Set();
  const isEditable = (id) => editableZonaIds.has(id);

  // El botón "Editar" del popup (si está, ver pointPopupHtml) dispara onEditRequest con el
  // tablero que corresponde al marcador que abrió ese popup.
  map.on('popupopen', (e) => {
    const marker = e.popup._source;
    const btn = e.popup.getElement()?.querySelector('.edit-tablero-btn');
    if (btn && marker?.tableroRow) {
      btn.onclick = () => onEditRequest?.(marker.tableroDef, marker.tableroRow, marker);
    }
  });

  const allDefs = [
    ...CONFIG.polygonLayers.map((d) => ({ ...d, kind: 'polygon' })),
    ...CONFIG.pointLayers.map((d) => ({ ...d, kind: 'point' })),
  ];

  const entries = await Promise.all(
    allDefs.map(async (def) => {
      try {
        const layer = def.kind === 'polygon' ? await loadPolygonLayer(def) : await loadPointLayer(def, isEditable);
        return { def, layer };
      } catch (err) {
        console.error(`Error cargando capa "${def.id}":`, err);
        return null;
      }
    })
  );

  const loaded = entries.filter(Boolean);

  // Dos cuadros separados: uno para Zonas/Subzonas/Sectores y otro para los Tableros
  // (el toggle de números, más abajo, queda apilado entre los dos).
  const polygonControl = L.control.layers(null, null, { collapsed: false }).addTo(map);

  // Guarda qué capas tilda/destilda el usuario a mano, para restaurarlo en la próxima visita
  // (pisa el defaultVisible de CONFIG la primera vez que esa capa está disponible).
  if (!prefs.layerVisibility) prefs.layerVisibility = {};
  map.on('overlayadd overlayremove', (e) => {
    const entry = loaded.find((en) => en.layer === e.layer);
    if (!entry) return;
    prefs.layerVisibility[entry.def.id] = e.type === 'overlayadd';
    savePrefs(prefs);
  });

  // Capas que ya se agregaron al selector (aunque no estén tildadas en el mapa). Sirve para
  // distinguir "recién habilitada -> aplicar defaultVisible" de "el usuario la destildó a mano".
  const registered = new Set();

  function applyVisibility(ids) {
    for (const { def, layer } of loaded) {
      const isAllowed = ids.has(def.id);
      if (isAllowed && !registered.has(def.id)) {
        controlFor(def).addOverlay(layer, def.label);
        registered.add(def.id);
        if (def.kind === 'point') visiblePointLayers += 1;
        const remembered = prefs.layerVisibility[def.id];
        const wantVisible = remembered !== undefined ? remembered : def.defaultVisible !== false;
        if (wantVisible) layer.addTo(map);
      } else if (!isAllowed && registered.has(def.id)) {
        map.removeLayer(layer);
        controlFor(def).removeLayer(layer);
        registered.delete(def.id);
        if (def.kind === 'point') visiblePointLayers -= 1;
      }
    }
    applyLabelsVisibility();
    updateTablerosControlVisibility();
    applyTableroLabelsVisibility();
  }

  // Números de tablero: solo se muestran a partir de cierto zoom (con el mapa alejado, ~2200
  // etiquetas superpuestas serían ilegibles). Se recalcula al hacer zoom.
  const TABLERO_LABEL_MIN_ZOOM = 18;
  function applyTableroLabelsVisibility() {
    const show = map.getZoom() >= TABLERO_LABEL_MIN_ZOOM;
    for (const { def, layer } of loaded) {
      if (def.kind !== 'point') continue;
      layer.eachLayer((marker) => (show ? marker.openTooltip() : marker.closeTooltip()));
    }
  }
  map.on('zoomend', applyTableroLabelsVisibility);

  // Toggle de "Mostrar referencias": abre/cierra el tooltip permanente de cada polígono sin
  // afectar si la capa en sí está prendida o apagada.
  let labelsVisible = prefs.labelsVisible !== false;
  function applyLabelsVisibility() {
    for (const { def, layer } of loaded) {
      if (def.kind !== 'polygon') continue;
      layer.eachLayer((sub) => (labelsVisible ? sub.openTooltip() : sub.closeTooltip()));
    }
  }

  const LabelsToggle = L.Control.extend({
    options: { position: 'topright' },
    onAdd() {
      const container = L.DomUtil.create('div', 'labels-toggle leaflet-bar');
      container.innerHTML = `
        <label>
          <input type="checkbox" />
          Mostrar referencias
        </label>
      `;
      L.DomEvent.disableClickPropagation(container);
      const checkbox = container.querySelector('input');
      checkbox.checked = labelsVisible;
      checkbox.addEventListener('change', (e) => {
        labelsVisible = e.target.checked;
        prefs.labelsVisible = labelsVisible;
        savePrefs(prefs);
        applyLabelsVisibility();
      });
      return container;
    },
  });
  new LabelsToggle().addTo(map);

  const tablerosControl = L.control.layers(null, null, { collapsed: false }).addTo(map);
  const controlFor = (def) => (def.kind === 'polygon' ? polygonControl : tablerosControl);

  // El cuadro de Tableros no debe verse cuando no hay ninguna capa de tableros habilitada
  // (usuario sin loguear, o logueado sin permiso a ninguna zona de tableros).
  let visiblePointLayers = 0;
  function updateTablerosControlVisibility() {
    tablerosControl.getContainer().style.display = visiblePointLayers > 0 ? '' : 'none';
  }
  updateTablerosControlVisibility();

  // Índice para el buscador: solo tableros de capas que el usuario actual puede ver
  // (evita que se pueda buscar/ubicar un tablero al que no se tiene acceso).
  function getSearchableTableros() {
    const results = [];
    for (const { def, layer } of loaded) {
      if (def.kind !== 'point' || !registered.has(def.id)) continue;
      layer.eachLayer((marker) => {
        results.push({ marker, layerGroup: layer, def, row: marker.tableroRow, direccion: marker.tableroDireccion });
      });
    }
    return results;
  }

  // Llamado desde main.js cada vez que cambia el login: actualiza qué zonas puede
  // crear/editar el usuario actual (los popups ya abiertos no cambian, pero cualquiera que se
  // abra después consulta este set en el momento, ver buildTableroMarker).
  function setEditableZonaIds(ids) {
    editableZonaIds = ids;
  }

  // Refleja en el mapa, al instante, un tablero recién creado/editado desde el formulario
  // (sin esperar a que el CSV publicado del Sheet se actualice, que tarda unos minutos).
  function upsertTablero(def, row) {
    const entry = loaded.find((e) => e.def.id === def.id);
    if (!entry) return;
    entry.layer.eachLayer((marker) => {
      if (marker.tableroRow?.Nombre === row.Nombre) entry.layer.removeLayer(marker);
    });
    buildTableroMarker(row, def, isEditable).addTo(entry.layer);
    applyTableroLabelsVisibility();
  }

  applyVisibility(allowedIds);
  return { map, applyVisibility, getSearchableTableros, setEditableZonaIds, upsertTablero };
}
