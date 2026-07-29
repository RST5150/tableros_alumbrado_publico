import L from 'leaflet';
import { CONFIG } from './config.js';

// Columnas reales del Sheet (además de Nombre/Lat/Lon y Plano, que se tratan aparte). Las
// claves tienen que coincidir exactamente con los encabezados de las hojas tableros_zona*.
const FIELDS = [
  { key: 'Tipo', label: 'Tipo' },
  { key: 'Clasificación', label: 'Clasificación' },
  { key: 'Tipo de ubicación', label: 'Tipo de ubicación' },
  { key: 'Calle', label: 'Calle' },
  { key: 'Altura', label: 'Altura' },
  { key: 'Letra', label: 'Letra' },
  { key: 'Bis', label: 'Bis' },
  { key: 'Responsable', label: 'Responsable' },
  { key: 'Foto Externa', label: 'Foto externa (link)' },
  { key: 'Foto Interna', label: 'Foto interna (link)' },
  { key: 'Última Inspección', label: 'Última inspección', type: 'date' },
];

const MAX_PLANO_BYTES = 8 * 1024 * 1024;

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(',')[1]);
    reader.onerror = () => reject(new Error('No se pudo leer el archivo.'));
    reader.readAsDataURL(file);
  });
}

// Sin header de Content-Type a propósito: así el pedido queda como "simple request" y no
// dispara un preflight CORS que Apps Script no sabe responder. El script igual lee el body
// como JSON sin importar el Content-Type declarado.
async function postToScript(payload, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(CONFIG.appsScriptUrl, {
      method: 'POST',
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    return await res.json();
  } finally {
    clearTimeout(timeout);
  }
}

function el(tag, className, html) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (html !== undefined) node.innerHTML = html;
  return node;
}

// Arma el panel una sola vez (queda oculto hasta que se abre); openForm() lo repuebla según
// el modo (crear / editar).
function buildPanel() {
  const root = el('div', 'tablero-form-panel');
  root.innerHTML = `
    <div class="tablero-form-header">
      <h2></h2>
      <button type="button" class="tablero-form-close" aria-label="Cerrar">&times;</button>
    </div>
    <form class="tablero-form-body">
      <div class="tablero-form-error" hidden></div>

      <label class="tablero-form-zona-field">
        Zona
        <select name="zona"></select>
      </label>

      <label>
        Código (Nombre)
        <input type="text" name="Nombre" required />
      </label>

      <div class="tablero-form-latlon">
        <label>
          Latitud
          <input type="text" name="Lat" inputmode="decimal" required />
        </label>
        <label>
          Longitud
          <input type="text" name="Lon" inputmode="decimal" required />
        </label>
      </div>
      <button type="button" class="tablero-form-pick">Elegir ubicación en el mapa</button>

      <label>
        Plano
        <input type="text" name="Plano" placeholder="Link (o subí un archivo abajo)" />
      </label>
      <div class="tablero-form-plano-upload">
        <label class="tablero-form-file-label">
          Subir plano nuevo (PDF o imagen, máx. 8 MB)
          <input type="file" class="tablero-form-plano-file" accept="application/pdf,image/*" />
        </label>
        <span class="tablero-form-plano-status"></span>
      </div>

      ${FIELDS.map(
        (f) => `
        <label>
          ${f.label}
          <input type="${f.type || 'text'}" name="${f.key}" />
        </label>
      `
      ).join('')}

      <div class="tablero-form-actions">
        <button type="button" class="tablero-form-cancel">Cancelar</button>
        <button type="submit" class="tablero-form-save">Guardar</button>
      </div>
    </form>
  `;
  return root;
}

export function initForms({ map, upsertTablero }) {
  let user = null;
  let editableZonaIds = new Set();
  let mode = 'create';
  let editingDef = null;

  const panel = buildPanel();
  document.body.appendChild(panel);

  const title = panel.querySelector('h2');
  const form = panel.querySelector('form');
  const errorBox = panel.querySelector('.tablero-form-error');
  const zonaField = panel.querySelector('.tablero-form-zona-field');
  const zonaSelect = panel.querySelector('select[name=zona]');
  const nombreInput = panel.querySelector('input[name=Nombre]');
  const latInput = panel.querySelector('input[name=Lat]');
  const lonInput = panel.querySelector('input[name=Lon]');
  const pickBtn = panel.querySelector('.tablero-form-pick');
  const planoInput = panel.querySelector('input[name=Plano]');
  const planoFileInput = panel.querySelector('.tablero-form-plano-file');
  const planoStatus = panel.querySelector('.tablero-form-plano-status');
  const saveBtn = panel.querySelector('.tablero-form-save');

  planoFileInput.addEventListener('change', () => {
    const file = planoFileInput.files[0];
    if (!file) {
      planoStatus.textContent = '';
      return;
    }
    if (file.size > MAX_PLANO_BYTES) {
      planoStatus.textContent = `"${file.name}" pesa más de 8 MB, elegí otro archivo.`;
      planoFileInput.value = '';
      return;
    }
    planoStatus.textContent = `Se va a subir "${file.name}" y va a reemplazar el link de arriba.`;
  });

  function showError(message) {
    errorBox.textContent = message;
    errorBox.hidden = false;
  }
  function hideError() {
    errorBox.hidden = true;
  }

  function closePanel() {
    panel.classList.remove('open');
  }

  panel.querySelector('.tablero-form-close').addEventListener('click', closePanel);
  panel.querySelector('.tablero-form-cancel').addEventListener('click', closePanel);

  pickBtn.addEventListener('click', () => {
    pickBtn.textContent = 'Hacé clic en el mapa…';
    pickBtn.disabled = true;
    map.once('click', (e) => {
      latInput.value = e.latlng.lat.toFixed(6);
      lonInput.value = e.latlng.lng.toFixed(6);
      pickBtn.textContent = 'Elegir ubicación en el mapa';
      pickBtn.disabled = false;
    });
  });

  function editableZonaDefs() {
    return CONFIG.pointLayers.filter((l) => editableZonaIds.has(l.id));
  }

  function openForm(opts) {
    mode = opts.mode;
    editingDef = opts.def || null;
    hideError();
    form.reset();
    planoStatus.textContent = '';

    if (mode === 'create') {
      title.textContent = 'Nuevo tablero';
      zonaField.hidden = false;
      zonaSelect.innerHTML = editableZonaDefs()
        .map((l) => `<option value="${l.id}">${l.label}</option>`)
        .join('');
      nombreInput.disabled = false;
    } else {
      title.textContent = `Editar tablero ${opts.row.Nombre}`;
      zonaField.hidden = true;
      nombreInput.value = opts.row.Nombre || '';
      nombreInput.disabled = true;
      latInput.value = opts.row.Lat || '';
      lonInput.value = opts.row.Lon || '';
      planoInput.value = opts.row.Plano || '';
      for (const f of FIELDS) {
        const input = form.querySelector(`[name="${CSS.escape(f.key)}"]`);
        if (input) input.value = opts.row[f.key] || '';
      }
    }

    panel.classList.add('open');
  }

  function openCreateForm() {
    openForm({ mode: 'create' });
  }

  function openEditForm(def, row) {
    if (!editableZonaIds.has(def.id)) return;
    openForm({ mode: 'edit', def, row });
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    hideError();

    const zonaId = mode === 'create' ? zonaSelect.value : editingDef.id;
    const def = CONFIG.pointLayers.find((l) => l.id === zonaId);
    const data = {
      Nombre: nombreInput.value.trim(),
      Lat: latInput.value.trim(),
      Lon: lonInput.value.trim(),
      Plano: planoInput.value.trim(),
    };
    for (const f of FIELDS) {
      data[f.key] = form.querySelector(`[name="${CSS.escape(f.key)}"]`).value.trim();
    }

    if (!def || !data.Nombre || !data.Lat || !data.Lon) {
      showError('Completá código, latitud y longitud.');
      return;
    }
    if (Number.isNaN(parseFloat(data.Lat)) || Number.isNaN(parseFloat(data.Lon))) {
      showError('Latitud/longitud inválidas.');
      return;
    }
    if (!user?.token) {
      showError('Tu sesión venció. Cerrá y volvé a iniciar sesión con Google.');
      return;
    }
    if (CONFIG.appsScriptUrl.startsWith('REEMPLAZAR')) {
      showError('Falta configurar el Apps Script del formulario (ver README).');
      return;
    }

    saveBtn.disabled = true;
    // Apps Script puede tardar (o directamente no responder si el deploy quedó mal
    // configurado); sin este límite, un fetch que nunca resuelve deja el botón trabado para
    // siempre y sin ningún error visible.
    const timeoutMs = 20000;
    try {
      const planoFile = planoFileInput.files[0];
      if (planoFile) {
        saveBtn.textContent = 'Subiendo plano…';
        const fileData = await fileToBase64(planoFile);
        const uploadJson = await postToScript(
          {
            idToken: user.token,
            action: 'uploadFile',
            zona: zonaId,
            nombre: data.Nombre,
            fileName: planoFile.name,
            mimeType: planoFile.type,
            fileData,
          },
          timeoutMs
        );
        if (!uploadJson.ok) throw new Error(uploadJson.error || 'No se pudo subir el plano.');
        data.Plano = uploadJson.url;
      }

      saveBtn.textContent = 'Guardando…';
      const json = await postToScript({ idToken: user.token, action: mode, zona: zonaId, data }, timeoutMs);
      if (!json.ok) throw new Error(json.error || 'No se pudo guardar.');
      upsertTablero(def, data);
      closePanel();
    } catch (err) {
      if (err.name === 'AbortError') {
        showError('El Apps Script no respondió a tiempo. Revisá que el deploy esté activo (ver README) y probá de nuevo.');
      } else {
        showError(err.message || 'Error de red al guardar.');
      }
    } finally {
      saveBtn.disabled = false;
      saveBtn.textContent = 'Guardar';
    }
  });

  const AddButton = L.Control.extend({
    options: { position: 'bottomright' },
    onAdd() {
      const btn = el('button', 'add-tablero-btn', '+ Agregar tablero');
      btn.type = 'button';
      L.DomEvent.disableClickPropagation(btn);
      btn.addEventListener('click', openCreateForm);
      return btn;
    },
  });
  const addControl = new AddButton().addTo(map);

  function updateAddButtonVisibility() {
    addControl.getContainer().style.display = editableZonaIds.size > 0 ? '' : 'none';
  }
  updateAddButtonVisibility();

  // Llamado desde main.js cada vez que cambia el login.
  function setAuthState(newUser, newEditableZonaIds) {
    user = newUser;
    editableZonaIds = newEditableZonaIds;
    updateAddButtonVisibility();
  }

  return { setAuthState, openEditForm };
}
