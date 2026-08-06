import L from 'leaflet';
import Papa from 'papaparse';
import { CONFIG } from './config.js';
import { toDisplayDate } from './dateUtils.js';

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

// 'TRUE' (checkbox nativo de Sheets), 'SI'/'SÍ' o '1' cuentan como marcado — así funciona
// tanto si la columna es un checkbox real de Sheets como si alguien tipea el valor a mano.
function isTelegestionTrue(row) {
  const value = (row?.['Telegestión'] || '').toString().trim().toUpperCase();
  return value === 'TRUE' || value === 'SI' || value === 'SÍ' || value === '1';
}

// `access` es 'edit' (formulario completo), 'inspect' (solo Última Inspección + fotos, ver
// Capas_inspeccion en Roles) o null (sin botón).
function pointPopupHtml(row, access) {
  const inspeccionado = toDisplayDate(row['Última Inspección']);
  const telegestionado = isTelegestionTrue(row);
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
      <div class="tablero-popup-badges">
        <span class="estado-badge ${telegestionado ? 'estado-ok' : 'estado-info'}">
          ${telegestionado ? 'Telegestionado' : 'Sin Telegestión'}
        </span>
        <span class="estado-badge ${inspeccionado ? 'estado-ok' : 'estado-pendiente'}">
          ${inspeccionado ? `Inspeccionado: ${inspeccionado}` : 'Sin inspección registrada'}
        </span>
      </div>
      ${dir ? `<p>${dir}</p>` : ''}
      <dl>
        ${extraRows.map(([label, value]) => `<dt>${label}</dt><dd>${value}</dd>`).join('')}
      </dl>
      ${
        access === 'edit'
          ? '<button type="button" class="edit-tablero-btn" data-mode="edit">Editar</button>'
          : access === 'inspect'
          ? '<button type="button" class="edit-tablero-btn" data-mode="inspect">Registrar inspección</button>'
          : ''
      }
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
function buildTableroMarker(row, def, getAccess) {
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
  marker.bindPopup(() => pointPopupHtml(marker.tableroRow, getAccess(def.id)));
  // Empieza cerrado: se abre solo por encima de cierto zoom (ver applyTableroLabelsVisibility),
  // si no con ~2200 tableros el mapa quedaría ilegible de entrada. En mobile ni se bindea:
  // con ~2200 tooltips (aunque cerrados) el dispositivo se ralentiza mucho.
  if (row.Nombre && !isMobileDevice()) {
    marker.bindTooltip(row.Nombre, { permanent: true, direction: 'top', offset: [0, -12], className: 'tablero-label' });
    marker.closeTooltip();
  }
  marker.tableroRow = row;
  marker.tableroDireccion = direccion(row);
  marker.tableroDef = def;
  return marker;
}

// Leaflet ubica el tooltip "center" en layer.getCenter(), el centroide geométrico real del
// polígono. La Zona 2 tiene forma de "L" (un brazo baja y otro se extiende a la derecha) y ese
// centroide cae justo sobre el borde angosto que une ambos brazos, no dentro del brazo derecho.
// Se fuerza acá un punto elegido a mano, centrado en la parte derecha del polígono.
const LABEL_ANCHOR_OVERRIDES = {
  'Zona 2': [-32.95844, -60.66372],
};

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
      // En mobile no se bindea ningún tooltip: con ~200 polígonos (zonas+subzonas+sectores)
      // ralentiza mucho la interfaz en dispositivos menos potentes.
      if (isMobileDevice()) return;
      const name = feature.properties?.name;
      if (!name) return;
      const anchor = LABEL_ANCHOR_OVERRIDES[name];
      if (anchor) layer.getCenter = () => L.latLng(anchor);
      // Permanent (no sólo al pasar el mouse): muestra el número de zona/subzona/sector
      // siempre que esa capa esté prendida.
      layer.bindTooltip(name, { permanent: true, direction: 'center', className: 'polygon-label' });
    },
  });
}

async function loadPointLayer(def, getAccess) {
  const res = await fetch(def.url);
  if (!res.ok) throw new Error(`No se pudo cargar ${def.url}`);
  const text = await res.text();
  const { data } = Papa.parse(text, { header: true, skipEmptyLines: true });

  const markers = [];
  for (const row of data) {
    if (Number.isNaN(parseFloat(row.Lat)) || Number.isNaN(parseFloat(row.Lon))) continue;
    markers.push(buildTableroMarker(row, def, getAccess));
  }
  const layer = L.layerGroup(markers);
  // Lista completa de marcadores del layerGroup, independiente de cuáles estén agregados al
  // mapa en este momento — el filtro de Telegestión (ver applyTelegestionFilter) saca/agrega
  // marcadores del grupo, así que layer.getLayers() sola no alcanza para recalcularlo después.
  layer.tableroMarkers = markers;
  return layer;
}

export function isMobileDevice() {
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
// `onEditRequest(def, row, marker, mode)` se llama al apretar el botón del popup de un
// tablero, con mode 'edit' o 'inspect' según qué botón se haya mostrado (ver pointPopupHtml).
export async function buildMap(allowedIds, onEditRequest) {
  const map = L.map('map').setView(CONFIG.mapCenter, CONFIG.mapZoom);
  const prefs = loadPrefs();

  // Pane propio con z-index por encima del de polígonos (Zonas/Subzonas/Sectores), para que
  // los tableros siempre se vean arriba sin importar el orden en que se activen las capas.
  map.createPane('tableros');
  map.getPane('tableros').style.zIndex = 650;

  initGeolocation(map);

  // Botón para ocultar/mostrar de una los cuadros de capas (mapas base, Zonas/Subzonas/
  // Sectores, Tableros y "Mostrar referencias") — útil en mobile, donde ocupan bastante
  // espacio. Se agrega primero para quedar siempre arriba del resto en esta esquina, incluso
  // con los demás ocultos; el click y el resto del cableado se terminan de armar más abajo,
  // una vez que existen esos controles (ver applyLayersPanelsVisibility).
  let layersBtn = null;
  let layersPanelsHidden = prefs.layersPanelsHidden === true;
  const LayersPanelsToggle = L.Control.extend({
    options: { position: 'topright' },
    onAdd() {
      layersBtn = L.DomUtil.create('button', 'layers-panels-btn leaflet-bar');
      layersBtn.type = 'button';
      layersBtn.title = 'Mostrar/ocultar capas';
      layersBtn.innerHTML = '👁️';
      layersBtn.classList.toggle('active', layersPanelsHidden);
      L.DomEvent.disableClickPropagation(layersBtn);
      return layersBtn;
    },
  });
  new LayersPanelsToggle().addTo(map);

  // Solo mapas base gratuitos, sin API key (CartoDB y Esri World Imagery tienen términos de
  // "uso liviano" — no pensados para tráfico masivo, pero de sobra para esta app interna).
  const baseLayers = {
    Callejero: L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      maxZoom: 20,
    }),
    Claro: L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
      subdomains: 'abcd',
      maxZoom: 20,
    }),
    Voyager: L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
      subdomains: 'abcd',
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
    Satelital: L.tileLayer(
      'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      {
        attribution:
          'Tiles &copy; <a href="https://www.esri.com">Esri</a> — Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community',
        maxZoom: 19,
      }
    ),
  };

  // Overlay transparente de nombres de calles/lugares para combinar con Satelital (esa capa,
  // al ser solo fotos aéreas, no trae ningún texto). El de Esri (Reference/World_Boundaries_
  // and_Places) casi no tiene datos cargados en esta zona — se usa en cambio el "solo etiquetas"
  // de CartoDB (mismo proveedor que Claro/Voyager/Oscuro), que sí incluye nombres de calle.
  // Pane propia (no la pane de tiles compartida con el mapa base) para poder oscurecer el
  // texto con un filtro CSS sin afectar la imagen satelital de abajo — CartoDB no ofrece una
  // variante de "solo etiquetas" con un tono más oscuro ya hecho.
  map.createPane('streetLabels');
  map.getPane('streetLabels').style.zIndex = 450;
  map.getPane('streetLabels').style.filter = 'brightness(0.7) contrast(1.15)';

  const streetLabelsOverlay = L.tileLayer(
    'https://{s}.basemaps.cartocdn.com/rastertiles/voyager_only_labels/{z}/{x}/{y}{r}.png',
    {
      pane: 'streetLabels',
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
      subdomains: 'abcd',
      maxZoom: 20,
    }
  );

  const initialBase = prefs.baseLayer && baseLayers[prefs.baseLayer] ? prefs.baseLayer : 'Callejero';
  baseLayers[initialBase].addTo(map);
  let currentBaseName = initialBase;

  const baseLayersControl = L.control.layers(baseLayers, null, { collapsed: false }).addTo(map);

  // El checkbox de "Nombres de calles" solo tiene sentido (y solo aparece) con Satelital de
  // base — las demás capas ya traen sus propios nombres. Se agrega/saca del control entero
  // (no solo se tilda/destilda) al cambiar de mapa base, para que no quede una opción muerta
  // ofrecida sobre capas que no la necesitan.
  let streetLabelsRegistered = false;
  function updateStreetLabelsAvailability() {
    const isSatelital = currentBaseName === 'Satelital';
    if (isSatelital && !streetLabelsRegistered) {
      baseLayersControl.addOverlay(streetLabelsOverlay, 'Nombres de calles');
      streetLabelsRegistered = true;
      if (prefs.streetLabelsOverlay) streetLabelsOverlay.addTo(map);
    } else if (!isSatelital && streetLabelsRegistered) {
      map.removeLayer(streetLabelsOverlay);
      baseLayersControl.removeLayer(streetLabelsOverlay);
      streetLabelsRegistered = false;
    }
  }
  updateStreetLabelsAvailability();

  map.on('baselayerchange', (e) => {
    prefs.baseLayer = e.name;
    savePrefs(prefs);
    currentBaseName = e.name;
    updateStreetLabelsAvailability();
  });
  map.on('overlayadd overlayremove', (e) => {
    if (e.layer !== streetLabelsOverlay) return;
    prefs.streetLabelsOverlay = e.type === 'overlayadd';
    savePrefs(prefs);
  });

  // Zonas de tableros que el usuario actual puede editar o inspeccionar (independiente de
  // cuáles ve). "Editar" (Capas_editables) da el formulario completo; "Inspeccionar"
  // (Capas_inspeccion) solo deja tocar Última Inspección y las fotos. Se definen antes de
  // cargar las capas porque cada popup de tablero las consulta en el momento de abrirse (ver
  // buildTableroMarker).
  let editableZonaIds = new Set();
  let inspectableZonaIds = new Set();
  const getAccess = (id) => (editableZonaIds.has(id) ? 'edit' : inspectableZonaIds.has(id) ? 'inspect' : null);

  // El botón del popup (si está, ver pointPopupHtml) dispara onEditRequest con el tablero que
  // corresponde al marcador que abrió ese popup y el modo ('edit' o 'inspect') según qué botón
  // se haya mostrado.
  map.on('popupopen', (e) => {
    const marker = e.popup._source;
    const btn = e.popup.getElement()?.querySelector('.edit-tablero-btn');
    if (btn && marker?.tableroRow) {
      btn.onclick = () => onEditRequest?.(marker.tableroDef, marker.tableroRow, marker, btn.dataset.mode);
    }
  });

  const allDefs = [
    ...CONFIG.polygonLayers.map((d) => ({ ...d, kind: 'polygon' })),
    ...CONFIG.pointLayers.map((d) => ({ ...d, kind: 'point' })),
  ];

  const entries = await Promise.all(
    allDefs.map(async (def) => {
      try {
        const layer = def.kind === 'polygon' ? await loadPolygonLayer(def) : await loadPointLayer(def, getAccess);
        return { def, layer };
      } catch (err) {
        console.error(`Error cargando capa "${def.id}":`, err);
        return null;
      }
    })
  );

  const loaded = entries.filter(Boolean);

  // Dos cuadros separados: uno para Zonas/Subzonas/Sectores y otro para los Tableros (este
  // primero, el toggle "Mostrar referencias" queda apilado después/abajo de los dos — ver
  // dónde se agrega tablerosControl más abajo).
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
    applyTelegestionFilter();
  }

  // Números de tablero: solo se muestran a partir de cierto zoom (con el mapa alejado, ~2200
  // etiquetas superpuestas serían ilegibles), y solo si "Mostrar referencias" está tildado
  // (ver labelsVisible más abajo). Se recalcula al hacer zoom.
  const TABLERO_LABEL_MIN_ZOOM = 17;
  function applyTableroLabelsVisibility() {
    const show = labelsVisible && map.getZoom() >= TABLERO_LABEL_MIN_ZOOM;
    for (const { def, layer } of loaded) {
      if (def.kind !== 'point') continue;
      layer.eachLayer((marker) => (show ? marker.openTooltip() : marker.closeTooltip()));
    }
  }
  // 'moveend' (no solo 'zoomend'): con zoom por rueda del mouse, mientras la animación de zoom
  // está en curso (map._animatingZoom) Leaflet puede pisar los open/closeTooltip que se llamen
  // en ese lapso al resetear las panes; recién con la animación terminada el estado queda firme.
  // 'moveend' se dispara siempre después de que termina, así que sirve de red de seguridad.
  map.on('zoomend moveend', applyTableroLabelsVisibility);

  // Referencias de zonas/subzonas/sectores: cada una aparece a partir de su propio zoom mínimo
  // (zonas no tiene piso, son pocas y se leen bien alejado; subzonas y sectores son más chicos
  // y numerosos, así que se muestran más cerca para no amontonarse). Se recalcula al hacer zoom.
  const POLYGON_LABEL_MIN_ZOOM = { subzonas: 10, sectores: 15 };

  // Toggle de "Mostrar referencias": abre/cierra el tooltip permanente de cada polígono sin
  // afectar si la capa en sí está prendida o apagada.
  let labelsVisible = prefs.labelsVisible !== false;
  function applyLabelsVisibility() {
    const zoom = map.getZoom();
    for (const { def, layer } of loaded) {
      if (def.kind !== 'polygon') continue;
      const minZoom = POLYGON_LABEL_MIN_ZOOM[def.id] ?? 0;
      const show = labelsVisible && zoom >= minZoom;
      layer.eachLayer((sub) => (show ? sub.openTooltip() : sub.closeTooltip()));
    }
  }
  map.on('zoomend moveend', applyLabelsVisibility);

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
        applyTableroLabelsVisibility();
      });
      return container;
    },
  });

  // Filtro por Telegestión: en vez de tildar/destildar toda una zona, saca/agrega marcadores
  // individuales de su layerGroup según coincidan con el filtro (ver applyTelegestionFilter) —
  // así quedan afuera también de la búsqueda (getSearchableTableros) y de los popups, no solo
  // ocultos visualmente.
  let telegestionFilter = prefs.telegestionFilter || 'all';
  function matchesTelegestionFilter(row) {
    if (telegestionFilter === 'all') return true;
    return telegestionFilter === 'si' ? isTelegestionTrue(row) : !isTelegestionTrue(row);
  }
  function applyTelegestionFilter() {
    for (const { def, layer } of loaded) {
      if (def.kind !== 'point' || !layer.tableroMarkers) continue;
      for (const marker of layer.tableroMarkers) {
        const shouldShow = matchesTelegestionFilter(marker.tableroRow);
        const isShown = layer.hasLayer(marker);
        if (shouldShow && !isShown) marker.addTo(layer);
        else if (!shouldShow && isShown) layer.removeLayer(marker);
      }
    }
    applyTableroLabelsVisibility();
  }

  const TelegestionFilter = L.Control.extend({
    options: { position: 'topright' },
    onAdd() {
      const container = L.DomUtil.create('div', 'telegestion-filter leaflet-bar');
      container.innerHTML = `
        <label>
          Telegestión
          <select>
            <option value="all">Todos</option>
            <option value="si">Con telegestión</option>
            <option value="no">Sin telegestión</option>
          </select>
        </label>
      `;
      L.DomEvent.disableClickPropagation(container);
      const select = container.querySelector('select');
      select.value = telegestionFilter;
      select.addEventListener('change', (e) => {
        telegestionFilter = e.target.value;
        prefs.telegestionFilter = telegestionFilter;
        savePrefs(prefs);
        applyTelegestionFilter();
      });
      return container;
    },
  });

  // Se agrega antes que el toggle "Mostrar referencias" para que el cuadro de Tableros quede
  // apilado arriba de ese toggle (Leaflet apila los controles de una misma esquina en el orden
  // en que se van agregando al mapa).
  const tablerosControl = L.control.layers(null, null, { collapsed: false }).addTo(map);
  const controlFor = (def) => (def.kind === 'polygon' ? polygonControl : tablerosControl);

  // El filtro de Telegestión se agrega antes que "Mostrar referencias" para quedar apilado
  // arriba de ese toggle (mismo criterio de orden que tablerosControl más arriba).
  const telegestionFilterControl = new TelegestionFilter().addTo(map);

  // En mobile no hay tooltips bindeados (ver loadPolygonLayer), así que el toggle no tendría
  // ningún efecto: se omite en vez de mostrar un control que no hace nada.
  const labelsToggleControl = isMobileDevice() ? null : new LabelsToggle().addTo(map);

  // El cuadro de Tableros (y el filtro de Telegestión, que solo tiene sentido si hay tableros
  // visibles) no deben verse cuando no hay ninguna capa de tableros habilitada (usuario sin
  // loguear, o logueado sin permiso a ninguna zona de tableros), ni cuando el botón de ocultar
  // capas está activo.
  let visiblePointLayers = 0;
  function updateTablerosControlVisibility() {
    const display = visiblePointLayers > 0 && !layersPanelsHidden ? '' : 'none';
    tablerosControl.getContainer().style.display = display;
    telegestionFilterControl.getContainer().style.display = display;
  }
  updateTablerosControlVisibility();

  // Termina de armar el botón de ocultar/mostrar capas (layersBtn), ahora que ya existen
  // todos los controles que tiene que tapar.
  function applyLayersPanelsVisibility() {
    const display = layersPanelsHidden ? 'none' : '';
    baseLayersControl.getContainer().style.display = display;
    polygonControl.getContainer().style.display = display;
    if (labelsToggleControl) labelsToggleControl.getContainer().style.display = display;
    updateTablerosControlVisibility();
  }
  layersBtn.addEventListener('click', () => {
    layersPanelsHidden = !layersPanelsHidden;
    prefs.layersPanelsHidden = layersPanelsHidden;
    savePrefs(prefs);
    layersBtn.classList.toggle('active', layersPanelsHidden);
    applyLayersPanelsVisibility();
  });
  applyLayersPanelsVisibility();

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
  // crear/editar (o solo inspeccionar) el usuario actual (los popups ya abiertos no cambian,
  // pero cualquiera que se abra después consulta estos sets en el momento, ver
  // buildTableroMarker).
  function setEditableZonaIds(ids) {
    editableZonaIds = ids;
  }

  function setInspectableZonaIds(ids) {
    inspectableZonaIds = ids;
  }

  // Refleja en el mapa, al instante, un tablero recién creado/editado desde el formulario
  // (sin esperar a que el CSV publicado del Sheet se actualice, que tarda unos minutos).
  function upsertTablero(def, row) {
    const entry = loaded.find((e) => e.def.id === def.id);
    if (!entry) return;
    // Se busca en tableroMarkers (la lista completa), no con eachLayer (que solo recorre los
    // que están agregados al grupo ahora mismo) — si el tablero que se está editando estaba
    // afuera por el filtro de Telegestión, eachLayer no lo hubiera encontrado.
    const markers = entry.layer.tableroMarkers || (entry.layer.tableroMarkers = []);
    const idx = markers.findIndex((m) => m.tableroRow?.Nombre === row.Nombre);
    if (idx !== -1) {
      const [oldMarker] = markers.splice(idx, 1);
      if (entry.layer.hasLayer(oldMarker)) entry.layer.removeLayer(oldMarker);
    }
    const newMarker = buildTableroMarker(row, def, getAccess);
    markers.push(newMarker);
    if (matchesTelegestionFilter(row)) newMarker.addTo(entry.layer);
    applyTableroLabelsVisibility();
  }

  applyVisibility(allowedIds);
  return { map, applyVisibility, getSearchableTableros, setEditableZonaIds, setInspectableZonaIds, upsertTablero };
}
