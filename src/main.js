import './style.css';
import 'leaflet/dist/leaflet.css';
import { initAuth, allowedLayerIds } from './auth.js';
import { buildMap } from './layers.js';

async function main() {
  const { applyVisibility } = await buildMap(allowedLayerIds(null, new Map()));

  const auth = initAuth(async (user) => {
    const roles = user ? await auth.fetchRoles() : new Map();
    applyVisibility(allowedLayerIds(user, roles));
  });
}

main();
