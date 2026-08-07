import L from 'leaflet';
import { CONFIG } from './config.js';
import { toDisplayDate, displayDateToIso } from './dateUtils.js';
import { compressImage } from './imageUtils.js';

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
  { key: 'Telegestión', label: 'Telegestión', type: 'checkbox' },
  { key: 'Última Inspección', label: 'Última inspección', type: 'date' },
];

const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;

// Límite del archivo original de una foto, antes de comprimir (ver imageUtils.js). Mucho más
// alto que MAX_UPLOAD_BYTES porque una foto de celular sin comprimir entra sin problema acá —
// es solo para no dejar que el navegador intente procesar algo absurdamente pesado.
const MAX_ORIGINAL_IMAGE_BYTES = 25 * 1024 * 1024;

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

// A diferencia de parseFloat() (que corta en el primer carácter inválido sin tirar error:
// parseFloat("-32,907190") da -32, no NaN), esto exige el formato completo con punto como
// separador decimal. Sin esto, una coordenada tipeada/pegada con coma (común si el teclado o
// el origen del copy-paste usan configuración regional en español) pasa la validación y queda
// guardada mal en el Sheet, silenciosamente.
function isValidCoordinate(value) {
  return /^-?\d{1,3}(\.\d+)?$/.test(String(value || '').trim());
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

      <label class="tablero-form-zona-field tablero-form-full-only">
        Zona
        <input type="text" class="tablero-form-zona-display" disabled />
      </label>

      <label class="tablero-form-full-only">
        Código (Nombre)
        <input type="text" name="Nombre" required />
      </label>

      <div class="tablero-form-latlon tablero-form-full-only">
        <label>
          Latitud
          <input type="text" name="Lat" inputmode="decimal" required />
        </label>
        <label>
          Longitud
          <input type="text" name="Lon" inputmode="decimal" required />
        </label>
      </div>
      <button type="button" class="tablero-form-pick tablero-form-full-only">Elegir ubicación en el mapa</button>

      <label class="tablero-form-full-only">
        Plano
        <input type="text" name="Plano" placeholder="Link (o subí un archivo abajo)" />
      </label>
      <div class="tablero-form-plano-upload tablero-form-full-only">
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
          Subir foto nueva (imagen, se comprime sola antes de subir — se puede subir tal cual sale del celular)
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
          Subir foto nueva (imagen, se comprime sola antes de subir — se puede subir tal cual sale del celular)
          <input type="file" class="tablero-form-foto-int-file" accept="image/*" />
        </label>
        <span class="tablero-form-foto-int-status"></span>
      </div>

      ${FIELDS.map((f) =>
        f.type === 'checkbox'
          ? `
        <label class="tablero-form-checkbox tablero-form-full-only">
          <input type="checkbox" name="${f.key}" />
          ${f.label}
        </label>
      `
          : f.type === 'date'
          ? `
        <label>
          ${f.label}
          <div class="tablero-form-date">
            <input type="text" name="${f.key}" placeholder="dd/mm/aaaa" inputmode="numeric" />
            <input type="date" class="tablero-form-date-picker" data-for="${f.key}" tabindex="-1" aria-hidden="true" />
            <button type="button" class="tablero-form-date-btn" data-for="${f.key}" aria-label="Elegir fecha en el calendario">📅</button>
          </div>
        </label>
      `
          : `
        <label class="tablero-form-full-only">
          ${f.label}
          <input type="text" name="${f.key}" />
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
  let inspectableZonaIds = new Set();
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

  // `state.file` es lo que realmente se sube al guardar: el archivo comprimido si la
  // compresión terminó a tiempo, o el original si falló/no hizo falta (ver imageUtils.js).
  // `state.promise` se espera en el submit por si todavía está comprimiendo cuando se aprieta
  // "Guardar". No se puede guardar esto en fileInput.files (de solo lectura para JS), por eso
  // va aparte.
  const fotoExtState = { file: null, promise: null };
  const fotoIntState = { file: null, promise: null };

  function resetFotoState(state) {
    state.file = null;
    state.promise = null;
  }

  function wireFotoFileInput(fileInput, statusEl, label, state) {
    fileInput.addEventListener('change', () => {
      const file = fileInput.files[0];
      resetFotoState(state);
      if (!file) {
        statusEl.textContent = '';
        return;
      }
      if (!file.type.startsWith('image/')) {
        statusEl.textContent = `"${file.name}" no es una imagen.`;
        fileInput.value = '';
        return;
      }
      if (file.size > MAX_ORIGINAL_IMAGE_BYTES) {
        statusEl.textContent = `"${file.name}" pesa más de 25 MB, elegí otro archivo.`;
        fileInput.value = '';
        return;
      }
      statusEl.textContent = `Comprimiendo "${file.name}"…`;
      state.promise = compressImage(file).then((compressed) => {
        if (compressed.size > MAX_UPLOAD_BYTES) {
          statusEl.textContent = `"${file.name}" sigue pesando más de 8 MB después de comprimir, elegí otro archivo.`;
          fileInput.value = '';
          state.file = null;
          return;
        }
        state.file = compressed;
        statusEl.textContent = `Se va a subir "${file.name}" como ${label} y va a reemplazar el link de arriba.`;
      });
    });
  }
  wireFotoFileInput(fotoExtFileInput, fotoExtStatus, 'foto externa', fotoExtState);
  wireFotoFileInput(fotoIntFileInput, fotoIntStatus, 'foto interna', fotoIntState);

  // Botón 📅 junto a cada campo de fecha: abre el date picker nativo del navegador (para no
  // perder esa comodidad al pasar de input type=date a texto) pero el valor elegido se vuelca
  // siempre en dd/mm/aaaa al campo de texto, que sigue siendo el que se lee/valida al guardar.
  panel.querySelectorAll('.tablero-form-date-btn').forEach((btn) => {
    const key = btn.dataset.for;
    const picker = panel.querySelector(`.tablero-form-date-picker[data-for="${CSS.escape(key)}"]`);
    const textInput = panel.querySelector(`input[name="${CSS.escape(key)}"]`);
    btn.addEventListener('click', () => {
      const iso = displayDateToIso(textInput.value.trim());
      if (iso) picker.value = iso;
      picker.showPicker ? picker.showPicker() : picker.focus();
    });
    picker.addEventListener('change', () => {
      textInput.value = toDisplayDate(picker.value);
    });
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
    resetFotoState(fotoExtState);
    resetFotoState(fotoIntState);
    // Modo inspección (ver Capas_inspeccion en Roles): solo puede tocar Última Inspección y
    // las fotos, así que el resto de los campos (incluidos en tablero-form-full-only) se
    // ocultan — no alcanza con no mandarlos: si se ven mientras la restricción real vive en
    // Code.gs, un inspector podría creer que los está editando aunque el guardado los ignore.
    panel.classList.toggle('inspect-mode', mode === 'inspect');

    if (mode === 'create') {
      title.textContent = 'Nuevo tablero';
      zonaField.hidden = false;
      nombreInput.disabled = false;
      updateZonaDisplay();
    } else {
      title.textContent = mode === 'inspect' ? `Inspección — Tablero ${opts.row.Nombre}` : `Editar tablero ${opts.row.Nombre}`;
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
        if (!input) continue;
        if (f.type === 'checkbox') {
          input.checked = /^(TRUE|SI|SÍ|1)$/i.test((opts.row[f.key] || '').trim());
        } else if (f.type === 'date') {
          input.value = toDisplayDate(opts.row[f.key]);
        } else {
          input.value = opts.row[f.key] || '';
        }
      }
    }

    panel.classList.add('open');
  }

  function openCreateForm() {
    openForm({ mode: 'create' });
  }

  function openEditForm(def, row, marker, accessMode) {
    if (accessMode === 'inspect') {
      if (!inspectableZonaIds.has(def.id) && !editableZonaIds.has(def.id)) return;
      openForm({ mode: 'inspect', def, row });
    } else {
      if (!editableZonaIds.has(def.id)) return;
      openForm({ mode: 'edit', def, row });
    }
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
      const input = form.querySelector(`[name="${CSS.escape(f.key)}"]`);
      data[f.key] = f.type === 'checkbox' ? (input.checked ? 'TRUE' : 'FALSE') : input.value.trim();
    }

    if (data['Última Inspección']) {
      const iso = displayDateToIso(data['Última Inspección']);
      if (!iso) {
        showError('La fecha de última inspección tiene que tener el formato dd/mm/aaaa.');
        return;
      }
      data['Última Inspección'] = iso;
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
    if (mode === 'inspect' && !inspectableZonaIds.has(def.id) && !editableZonaIds.has(def.id)) {
      showError(`No tenés permiso para registrar inspecciones en la ${def.label}.`);
      return;
    }
    if (!isValidCoordinate(data.Lat) || !isValidCoordinate(data.Lon)) {
      showError('Latitud/longitud inválidas — usá punto como separador decimal (ej. "-32.907190"), no coma.');
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

      if (fotoExtFileInput.files[0]) {
        if (fotoExtState.promise) {
          saveBtn.textContent = 'Comprimiendo foto externa…';
          await fotoExtState.promise;
        }
        if (!fotoExtState.file) throw new Error('No se pudo procesar la foto externa, elegí otra.');
        saveBtn.textContent = 'Subiendo foto externa…';
        data['Foto Externa'] = await uploadFoto(fotoExtState.file, 'ext', zonaId, data.Nombre, timeoutMs);
      }

      if (fotoIntFileInput.files[0]) {
        if (fotoIntState.promise) {
          saveBtn.textContent = 'Comprimiendo foto interna…';
          await fotoIntState.promise;
        }
        if (!fotoIntState.file) throw new Error('No se pudo procesar la foto interna, elegí otra.');
        saveBtn.textContent = 'Subiendo foto interna…';
        data['Foto Interna'] = await uploadFoto(fotoIntState.file, 'int', zonaId, data.Nombre, timeoutMs);
      }

      saveBtn.textContent = 'Guardando…';
      // Code.gs espera 'create'/'update'/'inspect' (createRow/updateRow/inspectRow); acá el modo
      // interno es 'create'/'edit'/'inspect' — se traduce acá en vez de renombrar el estado
      // interno. 'inspect' pega a una acción separada en el backend que solo puede tocar
      // Última Inspección/fotos, aunque `data` (por cómo se arma arriba) venga con la fila
      // completa: la restricción real de qué columnas se graban vive del lado del servidor.
      const action = mode === 'edit' ? 'update' : mode === 'inspect' ? 'inspect' : mode;
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
  function setAuthState(newUser, newEditableZonaIds, newInspectableZonaIds) {
    user = newUser;
    editableZonaIds = newEditableZonaIds;
    inspectableZonaIds = newInspectableZonaIds || new Set();
    updateAddButtonVisibility();
  }

  return { setAuthState, openEditForm };
}
