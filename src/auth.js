import Papa from 'papaparse';
import { CONFIG } from './config.js';

// Decodifica (sin verificar firma) el JWT que devuelve Google Identity Services.
// Alcanza para leer el email en el navegador: la seguridad "fuerte" de a qué datos se accede
// no depende de esto (ver README, sección de seguridad).
function decodeJwt(token) {
  const payload = token.split('.')[1];
  const json = atob(payload.replace(/-/g, '+').replace(/_/g, '/'));
  return JSON.parse(decodeURIComponent(escape(json)));
}

// Sesión persistida en el navegador: al recargar la página (o volver otro día) se restaura
// de inmediato sin esperar a Google. Solo se le pide un refresh a Google (ver isTokenFresh en
// start()) cuando el token cacheado ya está por vencer — mientras siga vigente, la sesión
// "dura" sin que aparezca ningún cartel de Google pidiendo iniciar sesión de nuevo. Si el
// refresco falla (se cerró la sesión de Google, cookies de terceros bloqueadas, etc.), el
// usuario sigue viendo sus capas con el último token conocido — si intenta guardar algo con un
// token ya vencido, el Apps Script lo rechaza y se le pide reloguearse (ver forms.js).
const STORAGE_KEY = 'mapa-tableros-auth';

// Margen antes del vencimiento real del token para considerarlo "por vencer" y pedir un
// refresh, en vez de esperar a que ya haya vencido.
const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;

function isTokenFresh(token) {
  try {
    const { exp } = decodeJwt(token);
    return typeof exp === 'number' && exp * 1000 - TOKEN_REFRESH_BUFFER_MS > Date.now();
  } catch {
    return false;
  }
}

function loadCachedUser() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY));
  } catch {
    return null;
  }
}

function saveCachedUser(user) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(user));
  } catch {
    // Modo privado / cuota llena: no es crítico, solo se pierde la persistencia.
  }
}

function clearCachedUser() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignorar
  }
}

function parseCapas(value) {
  const v = (value || '').trim();
  return v === '*' ? '*' : v.split(',').map((s) => s.trim()).filter(Boolean);
}

async function fetchRoles() {
  const res = await fetch(CONFIG.rolesCsvUrl);
  const text = await res.text();
  const { data } = Papa.parse(text, { header: true, skipEmptyLines: true });
  const roles = new Map();
  for (const row of data) {
    const email = (row.Email || '').trim().toLowerCase();
    if (!email) continue;
    // "Ver" y "editar" son permisos separados: alguien puede ver los tableros de una zona
    // sin poder tocarlos. Capas_editables es independiente de Capas_permitidas.
    roles.set(email, {
      view: parseCapas(row.Capas_permitidas),
      edit: parseCapas(row.Capas_editables),
    });
  }
  return roles;
}

function resolveGrant(user, roles, kind) {
  if (!user) return new Set();
  const grant = roles.get(user.email.toLowerCase())?.[kind];
  if (!grant) return new Set();
  if (grant === '*') return new Set([...CONFIG.polygonLayers, ...CONFIG.pointLayers].map((l) => l.id));
  return new Set(grant);
}

export function allowedLayerIds(user, roles) {
  const publicIds = new Set(CONFIG.publicLayerIds);
  return new Set([...publicIds, ...resolveGrant(user, roles, 'view')]);
}

// Zonas de tableros que el usuario puede crear/editar desde el formulario (independiente de
// cuáles puede ver).
export function editableLayerIds(user, roles) {
  return resolveGrant(user, roles, 'edit');
}

function hasGrant(entry) {
  if (!entry) return false;
  return ['view', 'edit'].some((k) => entry[k] === '*' || entry[k]?.length > 0);
}

// true si el usuario inició sesión pero no tiene ninguna fila (o ninguna capa) asignada en
// Roles — o sea, ve el mapa igual que alguien sin loguearse. Se usa para avisarle a un admin
// (ver notifyNoAccess) que falta darlo de alta.
export function hasNoPermissions(user, roles) {
  if (!user) return false;
  return !hasGrant(roles.get(user.email.toLowerCase()));
}

// Le pide al Apps Script que registre/avise que este usuario no tiene permisos. El dedupe (no
// mandar el mismo mail en cada recarga) vive del lado del script, en la hoja "Solicitudes de
// acceso" — acá simplemente se avisa cada vez, sin guardar nada en el navegador.
export async function notifyNoAccess(user) {
  if (CONFIG.appsScriptUrl.startsWith('REEMPLAZAR')) return;
  try {
    await fetch(CONFIG.appsScriptUrl, {
      method: 'POST',
      body: JSON.stringify({ idToken: user.token, action: 'notifyNoAccess', nombre: user.name }),
    });
  } catch {
    // Si falla (red, script caído, etc.) no es crítico: en el peor caso el admin se entera de
    // este usuario por otra vía en vez de por mail.
  }
}

// onChange(user) se llama al iniciar/cerrar sesión, con el usuario actual (o null).
export function initAuth(onChange) {
  const authArea = document.getElementById('auth-area');
  let currentUser = null;

  function renderSignedOut() {
    authArea.innerHTML = '';
    if (!window.google || CONFIG.googleClientId.startsWith('REEMPLAZAR')) {
      authArea.textContent = 'Configurá el Google Client ID en src/config.js';
      return;
    }
    const container = document.createElement('div');
    authArea.appendChild(container);
    // 'filled_black' en vez de 'filled_blue': el botón de Google siempre lleva un fondo propio
    // (no lo permite sacar del todo), pero en negro se integra mucho mejor con la barra oscura
    // que en blanco.
    window.google.accounts.id.renderButton(container, { theme: 'filled_black', size: 'medium' });
  }

  function renderSignedIn(user) {
    authArea.innerHTML = '';
    const chip = document.createElement('div');
    chip.className = 'user-chip';
    chip.innerHTML = `
      <img src="${user.picture}" alt="" referrerpolicy="no-referrer" />
      <span>${user.name}</span>
    `;
    const signOut = document.createElement('button');
    signOut.className = 'signout';
    signOut.textContent = 'Salir';
    signOut.onclick = () => {
      window.google?.accounts.id.disableAutoSelect();
      clearCachedUser();
      currentUser = null;
      renderSignedOut();
      onChange(null);
    };
    chip.appendChild(signOut);
    authArea.appendChild(chip);
  }

  async function handleCredential(response) {
    const claims = decodeJwt(response.credential);
    // Se guarda el JWT crudo (no solo los datos ya decodificados) porque el formulario de
    // tableros lo manda tal cual al Apps Script, que lo vuelve a validar contra Google antes
    // de aceptar cualquier guardado.
    currentUser = { email: claims.email, name: claims.name, picture: claims.picture, token: response.credential };
    saveCachedUser(currentUser);
    renderSignedIn(currentUser);
    onChange(currentUser);
  }

  function start() {
    if (!window.google || CONFIG.googleClientId.startsWith('REEMPLAZAR')) {
      renderSignedOut();
      return;
    }

    window.google.accounts.id.initialize({
      client_id: CONFIG.googleClientId,
      callback: handleCredential,
      // Si el navegador ya tiene una sesión de Google usada antes en este sitio, refresca el
      // login solo (sin que el usuario tenga que apretar el botón cada vez).
      auto_select: true,
    });

    // Restaura la sesión guardada de entrada, sin esperar a Google: así no hay que volver a
    // tocar el botón en cada visita.
    const cached = loadCachedUser();
    if (cached) {
      currentUser = cached;
      renderSignedIn(currentUser);
      // Se difiere: si `onChange` corriera ya (síncrono, acá adentro de initAuth), y ese
      // callback depende de la variable a la que se asigna el resultado de initAuth(...)
      // (como hace main.js con `const auth = initAuth(...)`), esa variable todavía no existe
      // en ese punto exacto y revienta en silencio (promesa rechazada sin nadie que la vea).
      Promise.resolve().then(() => onChange(currentUser));
    } else {
      renderSignedOut();
    }
    // `prompt()` puede mostrar un cartel de Google si el refresco silencioso falla — por eso
    // solo se llama cuando hace falta (sin sesión cacheada, o con el token cacheado por
    // vencer), y no en cada recarga mientras la sesión siga siendo válida.
    if (!cached || !isTokenFresh(cached.token)) {
      window.google.accounts.id.prompt();
    }
  }

  if (window.google) {
    start();
  } else {
    window.addEventListener('load', start);
  }

  return { fetchRoles };
}
