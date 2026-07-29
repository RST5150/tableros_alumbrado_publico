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
