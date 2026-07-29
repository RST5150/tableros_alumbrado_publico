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

async function fetchRoles() {
  const res = await fetch(CONFIG.rolesCsvUrl);
  const text = await res.text();
  const { data } = Papa.parse(text, { header: true, skipEmptyLines: true });
  const roles = new Map();
  for (const row of data) {
    const email = (row.Email || '').trim().toLowerCase();
    if (!email) continue;
    const layers = (row.Capas_permitidas || '').trim();
    roles.set(email, layers === '*' ? '*' : layers.split(',').map((s) => s.trim()).filter(Boolean));
  }
  return roles;
}

export function allowedLayerIds(user, roles) {
  const publicIds = new Set(CONFIG.publicLayerIds);
  if (!user) return publicIds;

  const grant = roles.get(user.email.toLowerCase());
  if (!grant) return publicIds;

  const allLayerIds = [...CONFIG.polygonLayers, ...CONFIG.pointLayers].map((l) => l.id);
  const granted = grant === '*' ? allLayerIds : grant;
  return new Set([...publicIds, ...granted]);
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
    currentUser = { email: claims.email, name: claims.name, picture: claims.picture };
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
