// Backend gratuito (sin servidor propio) del formulario "Agregar/Editar tablero" del mapa.
// Instrucciones de instalación: ver README.md, sección "Formulario de tableros".
//
// Reemplazar por el mismo Client ID que hay en src/config.js (googleClientId).
var CLIENT_ID = 'REEMPLAZAR_CON_TU_CLIENT_ID.apps.googleusercontent.com';

var COLUMNS = [
  'Nombre', 'Lat', 'Lon', 'Tipo', 'Clasificación', 'Tipo de ubicación', 'Calle', 'Altura',
  'Letra', 'Bis', 'Responsable', 'Plano', 'Foto Externa', 'Foto Interna', 'Última Inspección',
];

function doGet() {
  return jsonResponse({ ok: true, message: 'Apps Script de Mapa de Tableros activo.' });
}

function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents);
    var email = verifyIdToken(body.idToken);

    if (!getEditableZonas(email).has(body.zona)) {
      return jsonResponse({ ok: false, error: 'No tenés permiso para editar tableros de esa zona.' });
    }

    if (body.action === 'uploadFile') {
      return jsonResponse({ ok: true, url: uploadPlano(body) });
    }

    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(body.zona);
    if (!sheet) return jsonResponse({ ok: false, error: 'No existe la hoja "' + body.zona + '".' });

    if (body.action === 'create') {
      createRow(sheet, body.data);
    } else if (body.action === 'update') {
      updateRow(sheet, body.data);
    } else {
      return jsonResponse({ ok: false, error: 'Acción inválida.' });
    }

    return jsonResponse({ ok: true });
  } catch (err) {
    return jsonResponse({ ok: false, error: String(err.message || err) });
  }
}

// Carpeta raíz de Drive de cada zona (ya existentes, con subcarpetas "Sector XX" adentro).
var ZONA_FOLDER_IDS = {
  tableros_zona1: '12QHDt35ZtjMF2jvsSZNxMvaZqapBC5pw',
  tableros_zona2: '1o9rgtGOAUwvAcqyaTeCuJvXx7DkRfXb7',
  tableros_zona3: '1rFfcV9aPdpVyeC73NgEtm2O_HfjMfnOP',
};

// Mismo límite que en src/forms.js (MAX_SECTOR_BY_ZONA): número real de sectores que tiene
// cada zona. Si cambian los sectores, actualizar acá y allá.
var MAX_SECTOR_BY_ZONA = { 1: 69, 2: 53, 3: 52 };

// Solo se aceptan PDF cuyo nombre (sin extensión) sea el código de tablero: 5 dígitos, el
// primero 1/2/3 (zona), sector (dígitos 2-3) dentro del rango real de esa zona. Se valida acá
// (no solo en el formulario) porque esta es la única puerta que no se puede saltear pegándole
// directo a la URL del script.
function assertValidPlanoFileName(fileName) {
  var base = String(fileName).replace(/\.[^.]+$/, '');
  if (!/^\d{5}$/.test(base)) {
    throw new Error('El nombre del archivo tiene que ser el código del tablero: 5 números (ej. "16309.pdf").');
  }
  var zona = Number(base.charAt(0));
  var sector = Number(base.substring(1, 3));
  var maxSector = MAX_SECTOR_BY_ZONA[zona];
  if (!maxSector) {
    throw new Error('El primer número tiene que ser 1, 2 o 3 (zona) — "' + base.charAt(0) + '" no es válido.');
  }
  if (sector < 1 || sector > maxSector) {
    throw new Error('El sector "' + base.substring(1, 3) + '" no existe en la Zona ' + zona + ' (hay hasta ' + maxSector + ').');
  }
}

// Sube el plano a Drive, dentro de la subcarpeta "Sector XX" que corresponda según el código
// del tablero, y devuelve el link para guardar en la columna "Plano". El archivo queda visible
// para "cualquiera con el link" — si no, el link no serviría para nada al abrirlo desde el
// popup del mapa.
function uploadPlano(body) {
  if (!body.fileData || !body.fileName) throw new Error('Falta el archivo a subir.');
  if (body.mimeType !== 'application/pdf' && !/\.pdf$/i.test(body.fileName)) {
    throw new Error('Solo se aceptan archivos PDF.');
  }
  assertValidPlanoFileName(body.fileName);

  var maxBytes = 8 * 1024 * 1024;
  var bytes = Utilities.base64Decode(body.fileData);
  if (bytes.length > maxBytes) throw new Error('El archivo pesa más de 8 MB.');

  markOldPlanoAsOld(body.zona, body.nombre);

  var safeName = [body.zona, body.nombre, body.fileName].filter(Boolean).join('_');
  var blob = Utilities.newBlob(bytes, body.mimeType || 'application/octet-stream', safeName);
  var file = getSectorFolder(body.zona, body.nombre).createFile(blob);
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  return file.getUrl();
}

// Si el tablero ya tenía un plano cargado, no lo borra: le agrega ".old" al nombre en Drive
// para poder encontrarlos y limpiarlos a mano más adelante (Drive → buscar ".old").
function markOldPlanoAsOld(zona, nombre) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(zona);
  if (!sheet) return;

  var nombreIdx = COLUMNS.indexOf('Nombre');
  var planoIdx = COLUMNS.indexOf('Plano');
  var values = sheet.getDataRange().getValues();
  for (var i = 1; i < values.length; i++) {
    if (String(values[i][nombreIdx]).trim() !== String(nombre).trim()) continue;

    var fileId = extractDriveFileId(values[i][planoIdx]);
    if (!fileId) return;
    try {
      var oldFile = DriveApp.getFileById(fileId);
      if (oldFile.getName().indexOf('.old') === -1) oldFile.setName(oldFile.getName() + '.old');
    } catch (err) {
      // El archivo puede haber sido borrado o movido a mano; no bloquea la subida del nuevo.
    }
    return;
  }
}

function extractDriveFileId(url) {
  if (!url) return null;
  var match = String(url).match(/\/d\/([a-zA-Z0-9_-]+)/);
  return match ? match[1] : null;
}

// El código de tablero tiene el formato XYYXX: X = zona, YY = sector (siempre 2 dígitos),
// XX = número dentro del sector. Ej: "16309" -> sector "63".
function getSectorFolder(zona, nombre) {
  var rootId = ZONA_FOLDER_IDS[zona];
  if (!rootId) throw new Error('No hay carpeta de Drive configurada para "' + zona + '".');

  var codigo = String(nombre || '').trim();
  if (codigo.length < 3) throw new Error('No se pudo determinar el sector del código "' + codigo + '".');
  var sector = codigo.substring(1, 3);

  var root = DriveApp.getFolderById(rootId);
  var folderName = 'Sector ' + sector;
  var it = root.getFoldersByName(folderName);
  return it.hasNext() ? it.next() : root.createFolder(folderName);
}

// Valida el JWT de Google Sign-In contra los servidores de Google (no confía en el email que
// mande el cliente sin verificar) y devuelve el email ya verificado y en minúsculas.
function verifyIdToken(idToken) {
  if (!idToken) throw new Error('Falta la sesión. Volvé a iniciar sesión con Google.');

  var res = UrlFetchApp.fetch(
    'https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(idToken),
    { muteHttpExceptions: true }
  );
  var info = JSON.parse(res.getContentText());

  if (info.error) throw new Error('Tu sesión venció. Volvé a iniciar sesión con Google.');
  if (info.aud !== CLIENT_ID) throw new Error('Token de otra aplicación (Client ID no coincide).');
  if (!info.email || info.email_verified !== 'true') throw new Error('Email de Google no verificado.');

  return info.email.toLowerCase();
}

// Misma lógica que editableLayerIds() en src/auth.js, pero leyendo la columna
// "Capas_editables" (no "Capas_permitidas", que es solo para ver el mapa).
function getEditableZonas(email) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Roles');
  var rows = sheet.getDataRange().getValues();
  var header = rows[0];
  var emailIdx = header.indexOf('Email');
  var editIdx = header.indexOf('Capas_editables');

  for (var i = 1; i < rows.length; i++) {
    if (String(rows[i][emailIdx]).trim().toLowerCase() === email) {
      var capas = String(rows[i][editIdx] || '').trim();
      if (capas === '*') return { has: function () { return true; } };
      var set = {};
      capas.split(',').forEach(function (c) {
        var v = c.trim();
        if (v) set[v] = true;
      });
      return { has: function (zona) { return !!set[zona]; } };
    }
  }
  return { has: function () { return false; } };
}

function createRow(sheet, data) {
  var nombreIdx = COLUMNS.indexOf('Nombre');
  var lastRow = sheet.getLastRow();
  if (lastRow > 1) {
    var existing = sheet.getRange(2, 1, lastRow - 1, COLUMNS.length).getValues();
    for (var i = 0; i < existing.length; i++) {
      if (String(existing[i][nombreIdx]).trim() === String(data.Nombre).trim()) {
        throw new Error('Ya existe un tablero con el código "' + data.Nombre + '" en esta zona.');
      }
    }
  }
  sheet.appendRow(COLUMNS.map(function (col) { return data[col] || ''; }));
}

function updateRow(sheet, data) {
  var nombreIdx = COLUMNS.indexOf('Nombre');
  var values = sheet.getDataRange().getValues();
  for (var i = 1; i < values.length; i++) {
    if (String(values[i][nombreIdx]).trim() === String(data.Nombre).trim()) {
      var row = COLUMNS.map(function (col) { return data[col] || ''; });
      sheet.getRange(i + 1, 1, 1, row.length).setValues([row]);
      return;
    }
  }
  throw new Error('No se encontró ningún tablero con el código "' + data.Nombre + '" en esta zona.');
}

function jsonResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
