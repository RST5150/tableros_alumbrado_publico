// Backend gratuito (sin servidor propio) del formulario "Agregar/Editar tablero" del mapa.
// Instrucciones de instalación: ver README.md, sección "Formulario de tableros".
//
// Reemplazar por el mismo Client ID que hay en src/config.js (googleClientId).
var CLIENT_ID = 'REEMPLAZAR_CON_TU_CLIENT_ID.apps.googleusercontent.com';

// El orden acá tiene que ser EXACTAMENTE el mismo que el de las columnas reales en cada hoja
// tableros_zona* (createRow/updateRow escriben por posición, no por nombre de encabezado).
var COLUMNS = [
  'Nombre', 'Lat', 'Lon', 'Tipo', 'Clasificación', 'Tipo de ubicación', 'Calle', 'Altura',
  'Letra', 'Bis', 'Responsable', 'Plano', 'Foto Externa', 'Foto Interna', 'Telegestión',
  'Última Inspección',
];

function doGet() {
  return jsonResponse({ ok: true, message: 'Apps Script de Mapa de Tableros activo.' });
}

// El formulario ya valida esto (ver isValidCoordinate en forms.js), pero se repite acá porque
// es la única puerta que no se puede saltear pegándole directo a la URL del script. Sin esto,
// una coordenada con coma en vez de punto (típico si se tipea/pega con configuración regional
// en español) queda guardada mal en el Sheet sin ningún aviso: JavaScript no tira error al
// parsearla con parseFloat, solo corta en la coma y devuelve un número truncado.
function assertValidCoordinate(value, label) {
  if (!/^-?\d{1,3}(\.\d+)?$/.test(String(value || '').trim())) {
    throw new Error(label + ' inválida ("' + value + '") — tiene que usar punto como separador decimal, no coma.');
  }
}

function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents);
    var email = verifyIdToken(body.idToken);

    if (body.action === 'notifyNoAccess') {
      return jsonResponse({ ok: true, notified: notifyNoAccess(email, body.nombre) });
    }

    if (!getEditableZonas(email).has(body.zona)) {
      return jsonResponse({ ok: false, error: 'No tenés permiso para editar tableros de esa zona.' });
    }

    if (body.action === 'uploadFile') {
      return jsonResponse({ ok: true, url: uploadPlano(body) });
    }
    if (body.action === 'uploadFoto') {
      return jsonResponse({ ok: true, url: uploadFoto(body) });
    }

    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(body.zona);
    if (!sheet) return jsonResponse({ ok: false, error: 'No existe la hoja "' + body.zona + '".' });

    if (body.action === 'create' || body.action === 'update') {
      assertValidCoordinate(body.data.Lat, 'Latitud');
      assertValidCoordinate(body.data.Lon, 'Longitud');
    }

    if (body.action === 'create') {
      createRow(sheet, body.data);
      logHistorial(email, body.zona, body.data.Nombre, 'Alta', resumenAlta(body.data));
    } else if (body.action === 'update') {
      var cambios = updateRow(sheet, body.data);
      logHistorial(email, body.zona, body.data.Nombre, 'Edición', cambios);
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
// primero 1/2/3 (zona), sector (dígitos 2-3) dentro del rango real de esa zona, y además tiene
// que coincidir con el código del tablero que se está creando/editando (nombre). Se valida acá
// (no solo en el formulario) porque esta es la única puerta que no se puede saltear pegándole
// directo a la URL del script.
function assertValidPlanoFileName(fileName, nombre) {
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
  if (base !== String(nombre || '').trim()) {
    throw new Error('El nombre del archivo ("' + base + '") tiene que coincidir con el código del tablero ("' + nombre + '").');
  }
}

// Sube el plano a Drive, dentro de la subcarpeta "Sector XX" que corresponda según el código
// del tablero, y devuelve el link para guardar en la columna "Plano". El archivo queda visible
// para "cualquiera con el link" — si no, el link no serviría para nada al abrirlo desde el
// popup del mapa. Se guarda con el nombre original del archivo (ya validado arriba como igual
// al código del tablero) — sin agregarle ningún prefijo de zona/nombre.
function uploadPlano(body) {
  if (!body.fileData || !body.fileName) throw new Error('Falta el archivo a subir.');
  if (body.mimeType !== 'application/pdf' && !/\.pdf$/i.test(body.fileName)) {
    throw new Error('Solo se aceptan archivos PDF.');
  }
  assertValidPlanoFileName(body.fileName, body.nombre);

  var maxBytes = 8 * 1024 * 1024;
  var bytes = Utilities.base64Decode(body.fileData);
  if (bytes.length > maxBytes) throw new Error('El archivo pesa más de 8 MB.');

  markOldPlanoAsOld(body.zona, body.nombre);

  var blob = Utilities.newBlob(bytes, body.mimeType || 'application/octet-stream', body.fileName);
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

// Fotos externa/interna: van a Cloudinary (no a Drive) porque ahí es donde ya se venían
// guardando. El API Secret NO va acá — se lee de Configuración del proyecto → Propiedades del
// script (clave CLOUDINARY_API_SECRET), para que no quede en el código del repo, que es público.
var CLOUDINARY_CLOUD_NAME = 'alumbrado';
var CLOUDINARY_API_KEY = '731833263647895';

// "tableros_zona1" -> "Zona1", para armar la carpeta de Cloudinary (ver uploadFoto).
function zonaFolderName(zona) {
  var match = String(zona).match(/(\d+)$/);
  return 'Zona' + (match ? match[1] : zona);
}

// A diferencia del plano, acá no se valida el nombre que trae el archivo: el nombre final
// (código de tablero + _ext/_int) lo arma este mismo script a partir de la zona/tablero que
// se está editando, así quien sube la foto puede usar el archivo tal cual sale del celular.
function uploadFoto(body) {
  if (!body.fileData) throw new Error('Falta el archivo a subir.');
  if (!/^image\//.test(body.mimeType || '')) throw new Error('Solo se aceptan imágenes.');
  if (body.tipo !== 'ext' && body.tipo !== 'int') throw new Error('Tipo de foto inválido.');

  var maxBytes = 8 * 1024 * 1024;
  var bytes = Utilities.base64Decode(body.fileData);
  if (bytes.length > maxBytes) throw new Error('El archivo pesa más de 8 MB.');

  var apiSecret = PropertiesService.getScriptProperties().getProperty('CLOUDINARY_API_SECRET');
  if (!apiSecret) throw new Error('Falta configurar CLOUDINARY_API_SECRET en las propiedades del script.');

  var codigo = String(body.nombre || '').trim();
  // A diferencia de Drive (que sí separa por "Sector XX"), acá las fotos quedan sueltas
  // directo dentro de tableros/ZonaN, sin subcarpeta de sector. "folder" va SEPARADO de
  // "public_id" (no concatenado con "/") porque en cuentas de Cloudinary con "Dynamic Folder
  // Mode" las barras dentro de public_id ya no arman carpetas solas — hace falta este
  // parámetro aparte para que el archivo aparezca organizado en el Media Library.
  var folder = 'tableros/' + zonaFolderName(body.zona);
  var publicId = codigo + '_' + body.tipo;

  var timestamp = Math.floor(Date.now() / 1000);
  // Orden alfabético por nombre de parámetro (folder, overwrite, public_id, timestamp): así
  // lo exige el algoritmo de firma de Cloudinary — tiene que incluir todos los parámetros que
  // se mandan (menos file/cloud_name/resource_type/api_key), en ese orden.
  var toSign = 'folder=' + folder + '&overwrite=true&public_id=' + publicId + '&timestamp=' + timestamp;
  var signature = sha1Hex(toSign + apiSecret);

  var blob = Utilities.newBlob(bytes, body.mimeType, body.fileName || (codigo + '_' + body.tipo));
  var res = UrlFetchApp.fetch('https://api.cloudinary.com/v1_1/' + CLOUDINARY_CLOUD_NAME + '/image/upload', {
    method: 'post',
    payload: {
      file: blob,
      api_key: CLOUDINARY_API_KEY,
      timestamp: String(timestamp),
      signature: signature,
      folder: folder,
      public_id: publicId,
      overwrite: 'true',
    },
    muteHttpExceptions: true,
  });

  var json = JSON.parse(res.getContentText());
  if (json.error) throw new Error('Cloudinary: ' + json.error.message);
  return json.secure_url;
}

function sha1Hex(value) {
  var digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_1, value);
  return digest
    .map(function (b) {
      var v = (b < 0 ? b + 256 : b).toString(16);
      return v.length === 1 ? '0' + v : v;
    })
    .join('');
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

// Lat/Lon se mandan como número real (no texto) — si van como string, Sheets los reinterpreta
// según la configuración regional de la planilla al guardarlos (en español/Argentina, puede
// tomar el punto decimal como separador de miles), rompiendo la coordenada. Como updateRow
// reescribe la fila entera en cada guardado, esto pasaba en CUALQUIER edición, no solo al
// tocar Lat/Lon. Ya vienen validados con punto decimal (ver assertValidCoordinate), así que
// Number() los interpreta bien siempre.
function rowValueFor(col, data) {
  var value = data[col] || '';
  return col === 'Lat' || col === 'Lon' ? Number(value) : value;
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
  sheet.appendRow(COLUMNS.map(function (col) { return rowValueFor(col, data); }));
}

// Devuelve el detalle de qué campos cambiaron (ver diffRows), para que quede registrado en la
// hoja "Historial" (ver logHistorial) quién editó qué.
function updateRow(sheet, data) {
  var nombreIdx = COLUMNS.indexOf('Nombre');
  var values = sheet.getDataRange().getValues();
  for (var i = 1; i < values.length; i++) {
    if (String(values[i][nombreIdx]).trim() === String(data.Nombre).trim()) {
      var oldRow = values[i];
      var newRow = COLUMNS.map(function (col) { return rowValueFor(col, data); });
      sheet.getRange(i + 1, 1, 1, newRow.length).setValues([newRow]);
      return diffRows(oldRow, newRow);
    }
  }
  throw new Error('No se encontró ningún tablero con el código "' + data.Nombre + '" en esta zona.');
}

// Compara columna por columna (mismo orden que COLUMNS) y arma un texto tipo
// 'Responsable: "Juan" -> "Pedro"; ...' con los campos que efectivamente cambiaron.
function diffRows(oldRow, newRow) {
  var changes = [];
  for (var i = 0; i < COLUMNS.length; i++) {
    var before = String(oldRow[i] || '').trim();
    var after = String(newRow[i] || '').trim();
    if (before !== after) {
      changes.push(COLUMNS[i] + ': "' + before + '" -> "' + after + '"');
    }
  }
  return changes.length ? changes.join('; ') : '(sin cambios)';
}

// Mismo formato que diffRows pero para un alta (no hay "antes"): lista los campos que se
// completaron.
function resumenAlta(data) {
  return COLUMNS.filter(function (col) { return data[col]; })
    .map(function (col) { return col + ': "' + data[col] + '"'; })
    .join('; ');
}

// Hoja "Historial" (blame): una fila por cada alta/edición, con quién y qué cambió. Se crea
// sola la primera vez que hace falta (no requiere setup manual en el Sheet). Si falla el
// logueo (ej. hoja bloqueada), no debe tirar abajo el guardado real del tablero — por eso
// doPost no llama esto directo, sino a través de este wrapper con try/catch.
function logHistorial(email, zona, nombre, accion, detalle) {
  try {
    var sheet = getOrCreateHistorialSheet();
    sheet.appendRow([new Date(), email, zona, nombre, accion, detalle]);
  } catch (err) {
    // No se re-lanza: perder una línea de historial no debería impedir que el tablero se guarde.
  }
}

// Emails que reciben el aviso cuando alguien inicia sesión en el mapa sin tener ningún
// permiso asignado todavía en la hoja Roles. Si cambian los destinatarios, actualizar acá.
var NOTIFY_NO_ACCESS_EMAILS = ['alumbradorosario@gmail.com', 'ricardosalvia999@gmail.com'];

// Devuelve true si mandó el aviso (primera vez que ve este email) o false si ya lo había
// notificado antes (no reenvía en cada login). El registro en "Solicitudes de acceso" además
// sirve como lista de pendientes para dar de alta a mano en Roles.
function notifyNoAccess(email, nombre) {
  var sheet = getOrCreateSolicitudesSheet();
  var rows = sheet.getDataRange().getValues();
  for (var i = 1; i < rows.length; i++) {
    if (String(rows[i][1]).trim().toLowerCase() === email) return false;
  }

  sheet.appendRow([new Date(), email, nombre || '']);

  MailApp.sendEmail({
    to: NOTIFY_NO_ACCESS_EMAILS.join(','),
    subject: 'Mapa de Tableros: usuario sin permisos',
    body:
      (nombre ? nombre + ' (' + email + ')' : email) +
      ' inició sesión en el mapa de tableros pero todavía no tiene ningún permiso asignado en ' +
      'la hoja "Roles".\n\nPara darle acceso, agregá una fila en la hoja Roles del Sheet ' +
      'maestro con su email y las capas que corresponda (Capas_permitidas / Capas_editables).\n\n' +
      'Este aviso se manda una sola vez por persona (ver hoja "Solicitudes de acceso").',
  });
  return true;
}

function getOrCreateSolicitudesSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('Solicitudes de acceso');
  if (!sheet) {
    sheet = ss.insertSheet('Solicitudes de acceso');
    sheet.appendRow(['Fecha', 'Email', 'Nombre']);
  }
  return sheet;
}

function getOrCreateHistorialSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('Historial');
  if (!sheet) {
    sheet = ss.insertSheet('Historial');
    sheet.appendRow(['Fecha', 'Email', 'Zona', 'Tablero', 'Acción', 'Cambios']);
  }
  return sheet;
}

function jsonResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
