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
    });
    renderSignedOut();
  }

  if (window.google) {
    start();
  } else {
    window.addEventListener('load', start);
  }

  return { fetchRoles };
}
