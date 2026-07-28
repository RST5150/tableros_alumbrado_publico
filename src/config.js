// Centraliza todo lo que hay que editar para conectar la app a los datos reales.
// Ver README.md para instrucciones paso a paso de cada punto.

export const CONFIG = {
  // Google Cloud Console → APIs & Services → Credentials → OAuth Client ID (tipo "Web application").
  googleClientId: 'REEMPLAZAR_CON_TU_CLIENT_ID.apps.googleusercontent.com',

  mapCenter: [-32.93788081611774, -60.723553454561625],
  mapZoom: 16,

  // Capas de polígonos: quedan como archivos estáticos en /public/data, generados con
  // `pnpm kml-convert` a partir del KML exportado de My Maps. Cambian poco.
  // Rutas SIN "/" inicial a propósito: así se resuelven relativas a la página actual y
  // funcionan tanto en local (localhost:5173/) como publicadas bajo un subpath de GitHub
  // Pages (rst5150.github.io/tableros_alumbrado_publico/). Con "/" inicial se rompían en Pages.
  polygonLayers: [
    { id: 'zonas', label: 'Zonas', file: 'data/zonas.geojson', color: '#2563eb' },
    { id: 'subzonas', label: 'Subzonas', file: 'data/subzonas.geojson', color: '#16a34a' },
    { id: 'sectores', label: 'Sectores', file: 'data/sectores.geojson', color: '#ea580c' },
  ],

  // Capas de puntos: se leen en vivo desde hojas de Google Sheets publicadas como CSV
  // (Archivo → Compartir → Publicar en la web). Reemplazar `url` por el link real de cada hoja
  // (esas sí van con https:// completo, no les afecta lo de arriba).
  // Mientras tanto apuntan a los CSV generados por `pnpm kml-convert` en /public/local-data
  // (datos reales exportados de My Maps, pero todavía sin migrar a Sheets: ver README,
  // sección "Privacidad mientras tanto").
  pointLayers: [
    { id: 'tableros_zona1', label: 'Tableros Zona 1', url: 'local-data/tableros_zona1.csv', color: '#dc2626' },
    { id: 'tableros_zona2', label: 'Tableros Zona 2', url: 'local-data/tableros_zona2.csv', color: '#9333ea' },
    { id: 'tableros_zona3', label: 'Tableros Zona 3', url: 'local-data/tableros_zona3.csv', color: '#0d9488' },
  ],

  // Capas visibles para cualquiera, sin necesidad de iniciar sesión.
  publicLayerIds: ['zonas', 'subzonas', 'sectores'],

  // Hoja "Roles" publicada como CSV: columnas Email, Capas_permitidas
  // (Capas_permitidas = ids de capa separados por coma, o "*" para todas).
  rolesCsvUrl: 'local-data/roles.csv',
};
