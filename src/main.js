import './style.css';
import 'leaflet/dist/leaflet.css';
import { initAuth, allowedLayerIds } from './auth.js';
import { buildMap } from './layers.js';
import { initSearch } from './search.js';

async function main() {
  const { map, applyVisibility, getSearchableTableros } = await buildMap(allowedLayerIds(null, new Map()));
  initSearch(map, getSearchableTableros);

  const auth = initAuth(async (user) => {
    const roles = user ? await auth.fetchRoles() : new Map();
    applyVisibility(allowedLayerIds(user, roles));
  });
}

main();
