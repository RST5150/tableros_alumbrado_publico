# Mapa de Tableros

Reemplazo del Google My Maps "Tableros V4.1" por una web propia: Leaflet + OpenStreetMap,
datos editables desde Google Sheets/Drive, y capas visibles según el rol de cada usuario
(login con Google). Sitio 100% estático, pensado para publicarse gratis en GitHub Pages.

## Cómo está armado

- **Zonas / Subzonas / Sectores** (polígonos): archivos `public/data/*.geojson`, ya generados
  a partir de los KMZ reales exportados de My Maps (3 zonas, 23 subzonas, 174 sectores),
  conservando el color de cada una. Cambian poco, así que quedan versionados en el repo.
- **Tableros Zona 1/2/3** (puntos): se leen en vivo desde hojas de Google Sheets publicadas
  como CSV. Así el equipo edita ubicaciones/datos desde Drive sin tocar código. **Por ahora**
  `src/config.js` apunta a `public/local-data/*.csv`, que son los datos reales ya convertidos
  (831 + 760 + 610 tableros) pero todavía no migrados a una planilla — ver "Privacidad
  mientras tanto" más abajo y el paso 2 para completar la migración.
- **Roles**: hoja "Roles" (Email, Capas_permitidas) también publicada como CSV. Al iniciar
  sesión con Google, la app matchea el email contra esa hoja y solo muestra las capas
  permitidas. Seguridad "simple" (como se acordó): la interfaz oculta lo no permitido, pero
  los CSV publicados son accesibles por URL directa — no usar para datos sensibles.

## ⚠️ Privacidad mientras tanto

El repo es **público**, así que `public/local-data/tableros_zona*.csv` (direcciones reales de
~2200 tableros) está en `.gitignore` — existe en tu disco para poder probar en local, pero
**no se sube** a GitHub ni queda en el sitio publicado. Resultado: hasta que migres a Google
Sheets (paso 2) y pegues las URLs reales en `src/config.js`, el sitio publicado va a mostrar
Zonas/Subzonas/Sectores pero **no** los Tableros (la capa intenta cargar y falla en silencio,
sin romper el resto del mapa). Una vez migrado a Sheets, las URLs publicadas ahí sí son
públicas por diseño (es la forma más simple que se eligió) — si eso no es aceptable, avisame y
lo pasamos a un esquema con backend que valide accesos.

## Desarrollo local

```bash
pnpm install
pnpm dev
```

Abre `http://localhost:5173`. Sin login vas a ver solo Zonas/Subzonas/Sectores (capas
públicas); los Tableros aparecen al iniciar sesión con un email que tenga permisos en la hoja
de Roles (mientras no haya Google Client ID configurado, no se puede iniciar sesión — ver
paso 3).

## 1. Regenerar los datos desde My Maps (si cambian los KMZ)

Ya se hizo una vez con tus archivos de `Downloads/Capas tableros`. Si en el futuro exportás de
nuevo (por cambios en el mapa):

1. En My Maps, por cada capa → menú (⋮) → **Exportar a KML/KMZ** → exportar **esa capa sola**.
2. Poné los archivos en `scripts/input/` con estos nombres exactos (`.kml` o `.kmz`, los dos
   funcionan): `zonas`, `subzonas`, `sectores`, `tableros_zona1`, `tableros_zona2`,
   `tableros_zona3`.
3. Corré:
   ```bash
   pnpm kml-convert
   ```
   Esto regenera `public/data/*.geojson` (polígonos, listos) y
   `scripts/output/tableros_zona*.csv` (para importar a Sheets en el paso 2).

## 2. Migrar los tableros a un Google Sheet editable

1. Creá una planilla nueva en Drive, por ejemplo "Mapa de Tableros - Datos".
2. Por cada `scripts/output/tableros_zona*.csv` (o los que ya están en
   `public/local-data/tableros_zona*.csv`): creá una hoja con ese nombre (ej. `tableros_zona1`)
   y **Archivo → Importar → Subir** ese CSV en esa hoja. Las columnas ya vienen con los datos
   reales de My Maps: `Nombre, Lat, Lon, Tipo, Clasificación, Tipo de ubicación, Calle, Altura,
   Letra, Bis, Responsable, Plano, Foto Externa, Foto Interna, Última Inspección`.
3. Ojo con **Zona 3**: unos ~4 nombres de calle con "Ñ" quedaron corrompidos en la conversión
   (ej. "MU�OZ", "ORDO�EZ") por un problema de codificación en ese KMZ puntual. Buscalos y
   corregilos a mano en la planilla (Ctrl+F por "�").
4. Creá una hoja `Roles` con columnas `Email`, `Capas_permitidas` y `Capas_editables`, por
   ejemplo:

   | Email | Capas_permitidas | Capas_editables |
   |---|---|---|
   | supervisor.zona1@tuempresa.com | tableros_zona1 | tableros_zona1 |
   | inspector.zona1@tuempresa.com | tableros_zona1 | |
   | jefe.fiscalizacion@tuempresa.com | * | * |

   `Capas_permitidas` controla qué ve cada quien en el mapa; `Capas_editables` (independiente)
   controla quién puede crear/editar tableros desde el formulario — se puede ver una zona sin
   poder tocarla (fila del medio: la ve pero no la edita). En ambas, `*` = todas; si no, listar
   los ids separados por coma.
5. Por cada hoja (`tableros_zona1`, `tableros_zona2`, `tableros_zona3`, `Roles`): **Archivo →
   Compartir → Publicar en la web** → elegí esa hoja específica → formato **CSV** → Publicar.
   Copiá la URL que te da.
6. Pegá esas URLs en `src/config.js`, reemplazando los `url` de `pointLayers` y el
   `rolesCsvUrl`.
7. Una vez migrado, podés borrar `public/local-data/tableros_zona*.csv` (ya no se usan) —
   dejá `public/local-data/roles.csv` solo si todavía no armaste la hoja Roles real.

De ahí en más, cualquier edición en la planilla (agregar un tablero, actualizar la fecha de
inspección, dar de alta un rol) se refleja solo con recargar la página — no hace falta
redesplegar.

## 3. Login con Google

1. En [Google Cloud Console](https://console.cloud.google.com/) creá (o usá) un proyecto →
   **APIs & Services → Credentials → Create Credentials → OAuth client ID** → tipo **Web
   application**.
2. En "Authorized JavaScript origins" agregá `http://localhost:5173` (para probar en local) y
   la URL final de GitHub Pages (ej. `https://tuusuario.github.io`).
3. Copiá el Client ID y pegalo en `src/config.js` (`googleClientId`).

## 4. Publicar en GitHub Pages

1. Creá un repositorio en GitHub (puede ser privado) y pusheá este proyecto.
2. En el repo: **Settings → Pages → Build and deployment → Source: GitHub Actions**. El
   workflow `.github/workflows/deploy.yml` ya está armado: compila con pnpm y publica en cada
   push a `main`.
3. Si en algún momento renombrás el repo, actualizá `REPO_NAME` en `vite.config.js` para que
   coincida (o el sitio va a cargar en blanco por una ruta base incorrecta).
4. La URL final va a ser `https://rst5150.github.io/tableros_alumbrado_publico/`.

## 5. Formulario de tableros (Apps Script)

Permite agregar/editar tableros desde la propia web (botón "+ Agregar tablero" y "Editar" en
cada popup), sin tocar el Sheet a mano. Como el sitio sigue siendo estático, quien "escribe" en
la planilla es un **Google Apps Script** gratuito vinculado al mismo Sheet — no hace falta
darle acceso de Editor a cada persona: el script valida la identidad (contra Google) y el
permiso (contra la hoja Roles, columna `Capas_editables`) antes de guardar nada.

1. Abrí el Google Sheet maestro → **Extensiones → Apps Script**.
2. Borrá el contenido de `Code.gs` que viene por defecto y pegá el de
   [`scripts/apps-script/Code.gs`](scripts/apps-script/Code.gs) de este repo.
3. En la primera línea del script (`CLIENT_ID`), pegá el mismo Client ID que usaste en el paso
   3 (`src/config.js` → `googleClientId`).
4. **Implementar → Nueva implementación** → ícono de engranaje → **Aplicación web**.
   - Ejecutar como: **Yo** (tu cuenta, dueña del Sheet).
   - Quién tiene acceso: **Cualquier usuario**.
   - Implementar → autorizá los permisos que pida (acceso a la planilla y a internet, para
     validar el token contra Google) → copiá la **URL de la aplicación web**.
5. Pegá esa URL en `src/config.js` (`appsScriptUrl`).
6. Completá la columna `Capas_editables` en la hoja Roles para cada persona que deba poder
   editar (ver paso 2).

Cada vez que cambies el código de `Code.gs`, hay que volver a **Implementar → Gestionar
implementaciones → editar (lápiz) → Nueva versión** para que el cambio tenga efecto (la URL no
cambia).

**Nota**: al guardar, el tablero aparece en el mapa al instante (no espera al Sheet), pero el
CSV publicado que ven el resto de los usuarios puede tardar unos minutos en reflejar el cambio
— es el cacheo propio de "Publicar en la web" de Google Sheets, no algo que se pueda evitar
desde acá.

## Actualizar límites de Zonas/Subzonas/Sectores

Si en el futuro cambian los límites, repetí el paso 1 (exportar KML/KMZ de esa capa, correr
`pnpm kml-convert`) y hacé commit del `.geojson` actualizado.

## Administrar quién ve/edita qué

Editá la hoja "Roles" del Google Sheet: una fila por persona.

- `Capas_permitidas`: qué ve en el mapa (`zonas`, `subzonas`, `sectores`, `tableros_zona1`,
  `tableros_zona2`, `tableros_zona3`, o `*` para todo). Zonas/Subzonas/Sectores son públicas
  por defecto (ver `publicLayerIds` en `src/config.js`) — se puede cambiar eso si en algún
  momento también se quieren restringir.
- `Capas_editables`: cuáles de las capas de tableros puede crear/editar desde el formulario
  (independiente de lo anterior — ver paso 5). Los polígonos no son editables desde la web.