import L from 'leaflet';
import { CONFIG } from './config.js';

// Columnas reales del Sheet (además de Nombre/Lat/Lon, Plano y las Fotos, que se tratan
// aparte). Las claves tienen que coincidir exactamente con los encabezados de tableros_zona*.
const FIELDS = [
  { key: 'Tipo', label: 'Tipo' },
  { key: 'Clasificación', label: 'Clasificación' },
  { key: 'Tipo de ubicación', label: 'Tipo de ubicación' },
  { key: 'Calle', label: 'Calle' },
  { key: 'Altura', label: 'Altura' },
  { key: 'Letra', label: 'Letra' },
  { key: 'Bis', label: 'Bis' },
  { key: 'Responsable', label: 'Responsable' },
  { key: 'Última Inspección', label: 'Última inspección', type: 'date' },
];

const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;

// Mismo límite que ya usa scripts/shp-convert.mjs / Code.gs: el número real de sectores que
// tiene cada zona (Zona1 hasta 69, Zona2 hasta 53, Zona3 hasta 52). Si cambian los sectores,
// actualizar acá y en Code.gs (MAX_SECTOR_BY_ZONA).
const MAX_SECTOR_BY_ZONA = { 1: 69, 2: 53, 3: 52 };

// La zona surge del primer dígito del código (formato XYYXX: X = zona) — no se elige a mano,
// para que no se pueda cargar un tablero en una zona que no corresponde a su propio código.
function zonaDefFromCodigo(codigo) {
  const digit = String(codigo || '').trim().charAt(0);
  return CONFIG.pointLayers.find((l) => l.id === `tableros_zona${digit}`) || null;
}

// El nombre del archivo (sin extensión) tiene que ser el código de tablero: 5 dígitos, el
// primero 1/2/3 (zona), el sector (dígitos 2-3) dentro del rango real de esa zona, y además
// coincidir con el código del tablero que se está creando/editando — así se sube tal cual
// (ver Code.gs → uploadPlano), sin agregarle ningún prefijo de zona/nombre al guardarlo.
function planoFileNameError(fileName, tableroNombre) {
  const base = fileName.replace(/\.[^.]+$/, '');
  if (!/^\d{5}$/.test(base)) {
    return 'El nombre del archivo tiene que ser el código del tablero: 5 números (ej. "16309.pdf").';
  }
  const zona = Number(base[0]);
  const sector = Number(base.slice(1, 3));
  const maxSector = MAX_SECTOR_BY_ZONA[zona];
  if (!maxSector) {
    return `El primer número tiene que ser 1, 2 o 3 (zona) — "${base[0]}" no es válido.`;
  }
  if (sector < 1 || sector > maxSector) {
    return `El sector "${base.slice(1, 3)}" no existe en la Zona ${zona} (hay hasta ${maxSector}).`;
  }
  if (!tableroNombre) {
    return 'Completá el código del tablero antes de subir el plano.';
  }
  if (base !== tableroNombre) {
    return `El nombre del archivo ("${base}") no coincide con el código del tablero ("${tableroNombre}").`;
  }
  return null;
}

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
        <input type="text" class="tablero-form-zona-display" disabled />
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
          Subir plano nuevo (PDF, máx. 8 MB, el archivo se tiene que llamar como el código del
          tablero — ej. "16309.pdf")
          <input type="file" class="tablero-form-plano-file" accept="application/pdf" />
        </label>
        <span class="tablero-form-plano-status"></span>
      </div>

      <label>
        Foto externa
        <input type="text" name="Foto Externa" placeholder="Link (o subí una foto abajo)" />
      </label>
      <div class="tablero-form-plano-upload">
        <label class="tablero-form-file-label">
          Subir foto nueva (imagen, máx. 8 MB — se puede subir tal cual sale del celular)
          <input type="file" class="tablero-form-foto-ext-file" accept="image/*" />
        </label>
        <span class="tablero-form-foto-ext-status"></span>
      </div>

      <label>
        Foto interna
        <input type="text" name="Foto Interna" placeholder="Link (o subí una foto abajo)" />
      </label>
      <div class="tablero-form-plano-upload">
        <label class="tablero-form-file-label">
          Subir foto nueva (imagen, máx. 8 MB — se puede subir tal cual sale del celular)
          <input type="file" class="tablero-form-foto-int-file" accept="image/*" />
        </label>
        <span class="tablero-form-foto-int-status"></span>
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
  const zonaDisplay = panel.querySelector('.tablero-form-zona-display');
  const nombreInput = panel.querySelector('input[name=Nombre]');
  const latInput = panel.querySelector('input[name=Lat]');
  const lonInput = panel.querySelector('input[name=Lon]');
  const pickBtn = panel.querySelector('.tablero-form-pick');
  const planoInput = panel.querySelector('input[name=Plano]');
  const planoFileInput = panel.querySelector('.tablero-form-plano-file');
  const planoStatus = panel.querySelector('.tablero-form-plano-status');
  const fotoExtInput = panel.querySelector('input[name="Foto Externa"]');
  const fotoExtFileInput = panel.querySelector('.tablero-form-foto-ext-file');
  const fotoExtStatus = panel.querySelector('.tablero-form-foto-ext-status');
  const fotoIntInput = panel.querySelector('input[name="Foto Interna"]');
  const fotoIntFileInput = panel.querySelector('.tablero-form-foto-int-file');
  const fotoIntStatus = panel.querySelector('.tablero-form-foto-int-status');
  const saveBtn = panel.querySelector('.tablero-form-save');

  planoFileInput.addEventListener('change', () => {
    const file = planoFileInput.files[0];
    if (!file) {
      planoStatus.textContent = '';
      return;
    }
    if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) {
      planoStatus.textContent = `"${file.name}" no es un PDF.`;
      planoFileInput.value = '';
      return;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      planoStatus.textContent = `"${file.name}" pesa más de 8 MB, elegí otro archivo.`;
      planoFileInput.value = '';
      return;
    }
    const nameError = planoFileNameError(file.name, nombreInput.value.trim());
    if (nameError) {
      planoStatus.textContent = nameError;
      planoFileInput.value = '';
      return;
    }
    planoStatus.textContent = `Se va a subir "${file.name}" y va a reemplazar el link de arriba.`;
  });

  function wireFotoFileInput(fileInput, statusEl, label) {
    fileInput.addEventListener('change', () => {
      const file = fileInput.files[0];
      if (!file) {
        statusEl.textContent = '';
        return;
      }
      if (!file.type.startsWith('image/')) {
        statusEl.textContent = `"${file.name}" no es una imagen.`;
        fileInput.value = '';
        return;
      }
      if (file.size > MAX_UPLOAD_BYTES) {
        statusEl.textContent = `"${file.name}" pesa más de 8 MB, elegí otro archivo.`;
        fileInput.value = '';
        return;
      }
      statusEl.textContent = `Se va a subir "${file.name}" como ${label} y va a reemplazar el link de arriba.`;
    });
  }
  wireFotoFileInput(fotoExtFileInput, fotoExtStatus, 'foto externa');
  wireFotoFileInput(fotoIntFileInput, fotoIntStatus, 'foto interna');

  function showError(message) {
    errorBox.textContent = message;
    errorBox.hidden = false;
  }
  function hideError() {
    errorBox.hidden = true;
  }

  function closePanel() {
    panel.classList.remove('open');
    cancelPick();
  }

  panel.querySelector('.tablero-form-close').addEventListener('click', closePanel);
  panel.querySelector('.tablero-form-cancel').addEventListener('click', closePanel);

  // Mientras se está eligiendo ubicación, los marcadores de tableros no dejan pasar el clic
  // al mapa (Leaflet no burbujea eventos de Marker por default) — con ~2200 tableros es fácil
  // clickear encima de uno sin querer y que el clic le abra el popup a ese marcador en vez de
  // registrarse como el punto elegido. Se desactivan sus eventos de mouse mientras se elige.
  function cancelPick() {
    map.off('click', handlePick);
    pickBtn.textContent = 'Elegir ubicación en el mapa';
    pickBtn.disabled = false;
    const tablerosPane = map.getPane('tableros');
    if (tablerosPane) tablerosPane.style.pointerEvents = '';
  }

  function handlePick(e) {
    latInput.value = e.latlng.lat.toFixed(6);
    lonInput.value = e.latlng.lng.toFixed(6);
    cancelPick();
  }

  pickBtn.addEventListener('click', () => {
    pickBtn.textContent = 'Hacé clic en el mapa…';
    pickBtn.disabled = true;
    const tablerosPane = map.getPane('tableros');
    if (tablerosPane) tablerosPane.style.pointerEvents = 'none';
    map.once('click', handlePick);
  });

  // Refleja en vivo la zona que va a resultar del código tipeado (ver zonaDefFromCodigo).
  function updateZonaDisplay() {
    const def = zonaDefFromCodigo(nombreInput.value);
    if (def) {
      zonaDisplay.value = def.label;
    } else {
      zonaDisplay.value = nombreInput.value.trim() ? 'Código inválido (tiene que empezar con 1, 2 o 3)' : '';
    }
  }
  nombreInput.addEventListener('input', updateZonaDisplay);

  function openForm(opts) {
    mode = opts.mode;
    editingDef = opts.def || null;
    hideError();
    form.reset();
    planoStatus.textContent = '';
    fotoExtStatus.textContent = '';
    fotoIntStatus.textContent = '';

    if (mode === 'create') {
      title.textContent = 'Nuevo tablero';
      zonaField.hidden = false;
      nombreInput.disabled = false;
      updateZonaDisplay();
    } else {
      title.textContent = `Editar tablero ${opts.row.Nombre}`;
      zonaField.hidden = true;
      nombreInput.value = opts.row.Nombre || '';
      nombreInput.disabled = true;
      latInput.value = opts.row.Lat || '';
      lonInput.value = opts.row.Lon || '';
      planoInput.value = opts.row.Plano || '';
      fotoExtInput.value = opts.row['Foto Externa'] || '';
      fotoIntInput.value = opts.row['Foto Interna'] || '';
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

  // El script arma el nombre final (código + _ext/_int) solo, a partir de zona/nombre/tipo —
  // no hace falta que el archivo que se sube ya se llame así.
  async function uploadFoto(file, tipo, zonaId, nombre, timeoutMs) {
    const fileData = await fileToBase64(file);
    const json = await postToScript(
      { idToken: user.token, action: 'uploadFoto', zona: zonaId, nombre, tipo, fileName: file.name, mimeType: file.type, fileData },
      timeoutMs
    );
    if (!json.ok) throw new Error(json.error || 'No se pudo subir la foto.');
    return json.url;
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    hideError();

    const def = mode === 'create' ? zonaDefFromCodigo(nombreInput.value.trim()) : editingDef;
    const zonaId = def?.id;
    const data = {
      Nombre: nombreInput.value.trim(),
      Lat: latInput.value.trim(),
      Lon: lonInput.value.trim(),
      Plano: planoInput.value.trim(),
      'Foto Externa': fotoExtInput.value.trim(),
      'Foto Interna': fotoIntInput.value.trim(),
    };
    for (const f of FIELDS) {
      data[f.key] = form.querySelector(`[name="${CSS.escape(f.key)}"]`).value.trim();
    }

    if (!data.Nombre || !data.Lat || !data.Lon) {
      showError('Completá código, latitud y longitud.');
      return;
    }
    if (!def) {
      showError('El código tiene que empezar con 1, 2 o 3 (zona).');
      return;
    }
    if (mode === 'create' && !editableZonaIds.has(def.id)) {
      showError(`No tenés permiso para crear tableros en la ${def.label}.`);
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

      const fotoExtFile = fotoExtFileInput.files[0];
      if (fotoExtFile) {
        saveBtn.textContent = 'Subiendo foto externa…';
        data['Foto Externa'] = await uploadFoto(fotoExtFile, 'ext', zonaId, data.Nombre, timeoutMs);
      }

      const fotoIntFile = fotoIntFileInput.files[0];
      if (fotoIntFile) {
        saveBtn.textContent = 'Subiendo foto interna…';
        data['Foto Interna'] = await uploadFoto(fotoIntFile, 'int', zonaId, data.Nombre, timeoutMs);
      }

      saveBtn.textContent = 'Guardando…';
      // Code.gs espera 'create'/'update' (createRow/updateRow); acá el modo interno es
      // 'create'/'edit' — se traduce acá en vez de renombrar el estado interno.
      const action = mode === 'edit' ? 'update' : mode;
      const json = await postToScript({ idToken: user.token, action, zona: zonaId, data }, timeoutMs);
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
