import { defineConfig } from 'vite';

// Cuando publiques en GitHub Pages como https://<usuario>.github.io/<repo>/,
// reemplazá el valor de abajo por '/<repo>/'. Si en cambio usás un dominio propio
// o publicás en la raíz (https://<usuario>.github.io/), dejalo en '/'.
const REPO_NAME = 'tableros_alumbrado_publico';

export default defineConfig(({ command }) => ({
  // En dev (pnpm dev) servimos desde la raíz; el base con el nombre del repo
  // solo hace falta para el build que se publica en GitHub Pages.
  base: process.env.VITE_BASE_PATH || (command === 'build' ? `/${REPO_NAME}/` : '/'),
}));
