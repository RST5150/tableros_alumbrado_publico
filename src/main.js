import './style.css';
import 'leaflet/dist/leaflet.css';
import { initAuth, allowedLayerIds, editableLayerIds } from './auth.js';
import { buildMap } from './layers.js';
import { initSearch } from './search.js';
import { initForms } from './forms.js';

async function main() {
  // buildMap necesita un callback de "editar" al crearse, pero ese callback vive en forms.js,
  // que a su vez necesita `upsertTablero` (que devuelve buildMap). Se resuelve con esta
  // indirección: se le pasa una función que delega en `handleEditRequest`, reasignada una vez
  // que forms.js ya existe.
  let handleEditRequest = () => {};
  const { map, applyVisibility, getSearchableTableros, setEditableZonaIds, upsertTablero } = await buildMap(
    allowedLayerIds(null, new Map()),
    (def, row, marker) => handleEditRequest(def, row, marker)
  );

  initSearch(map, getSearchableTableros);
  const forms = initForms({ map, upsertTablero });
  handleEditRequest = forms.openEditForm;

  const auth = initAuth(async (user) => {
    const roles = user ? await auth.fetchRoles() : new Map();
    applyVisibility(allowedLayerIds(user, roles));
    const editable = editableLayerIds(user, roles);
    setEditableZonaIds(editable);
    forms.setAuthState(user, editable);
  });
}

main();
