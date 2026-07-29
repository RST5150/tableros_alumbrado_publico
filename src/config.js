// Centraliza todo lo que hay que editar para conectar la app a los datos reales.
// Ver README.md para instrucciones paso a paso de cada punto.

export const CONFIG = {
  // Google Cloud Console → APIs & Services → Credentials → OAuth Client ID (tipo "Web application").
  googleClientId: '773871451768-tlm5c75mea4ac8lehtoorvnhpgdsli2v.apps.googleusercontent.com',

  mapCenter: [-32.93788081611774, -60.723553454561625],
  mapZoom: 16,

  // Capas de polígonos: quedan como archivos estáticos en /public/data, generados con
  // `pnpm kml-convert` a partir del KML exportado de My Maps. Cambian poco.
  // Rutas SIN "/" inicial a propósito: así se resuelven relativas a la página actual y
  // funcionan tanto en local (localhost:5173/) como publicadas bajo un subpath de GitHub
  // Pages (rst5150.github.io/tableros_alumbrado_publico/). Con "/" inicial se rompían en Pages.
  // `defaultVisible: false` = la capa queda en el listado de capas (se puede tildar a mano)
  // pero no se muestra sola al entrar al mapa.
  polygonLayers: [
    { id: 'zonas', label: 'Zonas', file: 'data/zonas.geojson', color: '#2563eb' },
    { id: 'subzonas', label: 'Subzonas', file: 'data/subzonas.geojson', color: '#16a34a', defaultVisible: false },
    { id: 'sectores', label: 'Sectores', file: 'data/sectores.geojson', color: '#ea580c', defaultVisible: false },
  ],

  // Capas de puntos: se leen en vivo desde hojas de Google Sheets publicadas como CSV
  // (Archivo → Compartir → Publicar en la web). Ya migradas al Sheet "Mapa de Tableros - Datos".
  pointLayers: [
    { id: 'tableros_zona1', label: 'Tableros Zona 1', url: 'https://docs.google.com/spreadsheets/d/e/2PACX-1vRqSXOkKTJdGpJ1gPHzpsihR-4LT9JdxR7CwjZV9vBZZCdQffNI6luQFYLbM2khH-GA897XMsnIdPHc/pub?gid=1074267375&single=true&output=csv', color: '#dc2626' },
    { id: 'tableros_zona2', label: 'Tableros Zona 2', url: 'https://docs.google.com/spreadsheets/d/e/2PACX-1vRqSXOkKTJdGpJ1gPHzpsihR-4LT9JdxR7CwjZV9vBZZCdQffNI6luQFYLbM2khH-GA897XMsnIdPHc/pub?gid=169737162&single=true&output=csv', color: '#9333ea' },
    { id: 'tableros_zona3', label: 'Tableros Zona 3', url: 'https://docs.google.com/spreadsheets/d/e/2PACX-1vRqSXOkKTJdGpJ1gPHzpsihR-4LT9JdxR7CwjZV9vBZZCdQffNI6luQFYLbM2khH-GA897XMsnIdPHc/pub?gid=1181186740&single=true&output=csv', color: '#0d9488' },
  ],

  // Capas visibles para cualquiera, sin necesidad de iniciar sesión.
  publicLayerIds: ['zonas', 'subzonas', 'sectores'],

  // Hoja "Roles" publicada como CSV: columnas Email, Capas_permitidas, Capas_editables
  // (ambas = ids de capa separados por coma, o "*" para todas). Capas_permitidas controla qué
  // ve cada usuario; Capas_editables (independiente) controla qué puede crear/editar desde el
  // formulario de tableros.
  rolesCsvUrl: 'https://docs.google.com/spreadsheets/d/e/2PACX-1vRqSXOkKTJdGpJ1gPHzpsihR-4LT9JdxR7CwjZV9vBZZCdQffNI6luQFYLbM2khH-GA897XMsnIdPHc/pub?gid=1213598122&single=true&output=csv',

  // URL del Google Apps Script Web App que recibe los guardados del formulario de tableros
  // (ver README, sección "Formulario de tableros"). Hasta que esté configurado, el botón de
  // agregar/editar no se muestra.
  appsScriptUrl: 'https://script.google.com/macros/s/AKfycbyjEU1zItkQsk4YAgFjx_85ssIx3AVKcT7gLOH1XP-gejlIHt0Gv0bS-FGnUJrz5aec8A/exec',
};
