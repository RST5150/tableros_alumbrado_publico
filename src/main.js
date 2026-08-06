import 'leaflet/dist/leaflet.css';
import './style.css';
import { initAuth, allowedLayerIds, editableLayerIds, inspectableLayerIds, hasNoPermissions, notifyNoAccess } from './auth.js';
import { buildMap } from './layers.js';
import { initSearch } from './search.js';
import { initForms } from './forms.js';
import { initKonamiCode } from './easterEgg.js';

async function main() {
  initKonamiCode();

  // buildMap necesita un callback de "editar" al crearse, pero ese callback vive en forms.js,
  // que a su vez necesita `upsertTablero` (que devuelve buildMap). Se resuelve con esta
  // indirección: se le pasa una función que delega en `handleEditRequest`, reasignada una vez
  // que forms.js ya existe.
  let handleEditRequest = () => {};
  const { map, applyVisibility, getSearchableTableros, setEditableZonaIds, setInspectableZonaIds, upsertTablero } =
    await buildMap(allowedLayerIds(null, new Map()), (def, row, marker, mode) =>
      handleEditRequest(def, row, marker, mode)
    );

  initSearch(map, getSearchableTableros);
  const forms = initForms({ map, upsertTablero });
  handleEditRequest = forms.openEditForm;

  const auth = initAuth(async (user) => {
    const roles = user ? await auth.fetchRoles() : new Map();
    applyVisibility(allowedLayerIds(user, roles));
    const editable = editableLayerIds(user, roles);
    const inspectable = inspectableLayerIds(user, roles);
    setEditableZonaIds(editable);
    setInspectableZonaIds(inspectable);
    forms.setAuthState(user, editable, inspectable);
    if (hasNoPermissions(user, roles)) notifyNoAccess(user);
  });
}

main();
