// Convierte los shapefiles de Zonas/Subzonas/Sectores (los que arma QGIS, con coordenadas en
// POSGAR 94 / Argentina 5) a los GeoJSON en WGS84 que usa la app.
//
// Uso:
//   1. Poné en scripts/shp-input/ los pares .shp + .dbf, con estos nombres exactos:
//      zonas.shp/.dbf, subzonas.shp/.dbf, sectores.shp/.dbf
//   2. pnpm shp-convert

import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import shapefile from 'shapefile';
import proj4 from 'proj4';

const ROOT = path.resolve(import.meta.dirname, '..');
const INPUT_DIR = path.join(ROOT, 'scripts', 'shp-input');
const OUT_DIR = path.join(ROOT, 'public', 'data');

// Extraída del .prj de los shapefiles (POSGAR 94 / Argentina 5 — Gauss-Krüger faja 5).
const POSGAR94_ARG5 =
  '+proj=tmerc +lat_0=-90 +lon_0=-60 +k=1 +x_0=5500000 +y_0=0 +ellps=WGS84 +units=m +no_defs';

// Mismos colores que ya tenía cada capa (tomados del KML original de My Maps), para que el
// mapa se vea igual aunque cambie la fuente de datos.
const ZONA_COLORS = { 1: '#7cb342', 2: '#ff5252', 3: '#0288d1' };
const SECTOR_ZONA_COLORS = { 1: '#0288d1', 2: '#0f9d58', 3: '#e65100' };
const SUBZONA_COLORS = {
  '1M': '#0288d1', '1A': '#fbc02d', '1B': '#e65100', '1D': '#f9a825', '1J': '#4e342e',
  '1F': '#4e342e', '1C': '#006064', '1E': '#817717', '1K': '#3949ab', '1L': '#afb42b',
  '2J': '#880e4f', '2F': '#9c27b0', '2E': '#ffea00', '2A': '#c2185b', '2B': '#f57c00',
  '2D': '#795548', '2C': '#0097a7', '3A': '#01579b', '3B': '#097138', '3C': '#a52714',
  '3E': '#1a237e', '3D': '#ffea00', '3F': '#ffea00',
};
const DEFAULT_COLOR = '#666666';

function reprojectRing(ring) {
  return ring.map(([x, y]) => proj4(POSGAR94_ARG5, 'EPSG:4326', [x, y]));
}

function reprojectGeometry(geometry) {
  if (geometry.type === 'Polygon') {
    return { type: 'Polygon', coordinates: geometry.coordinates.map(reprojectRing) };
  }
  if (geometry.type === 'MultiPolygon') {
    return {
      type: 'MultiPolygon',
      coordinates: geometry.coordinates.map((poly) => poly.map(reprojectRing)),
    };
  }
  throw new Error(`Tipo de geometría no soportado: ${geometry.type}`);
}

async function readShapefile(name) {
  const shp = path.join(INPUT_DIR, `${name}.shp`);
  const dbf = path.join(INPUT_DIR, `${name}.dbf`);
  if (!existsSync(shp) || !existsSync(dbf)) return null;

  const source = await shapefile.open(shp, dbf);
  const features = [];
  let result = await source.read();
  while (!result.done) {
    features.push(result.value);
    result = await source.read();
  }
  return { type: 'FeatureCollection', features };
}

async function convertZonas() {
  const geojson = await readShapefile('zonas');
  if (!geojson) return;
  for (const f of geojson.features) {
    f.geometry = reprojectGeometry(f.geometry);
    const zona = String(f.properties.ZONAS);
    f.properties.name = `Zona ${zona}`;
    f.properties.color = ZONA_COLORS[zona] || DEFAULT_COLOR;
    f.properties.fillColor = f.properties.color;
    f.properties.fillOpacity = 0.3;
  }
  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(path.join(OUT_DIR, 'zonas.geojson'), JSON.stringify(geojson, null, 2));
  console.log(`✓ zonas -> public/data/zonas.geojson (${geojson.features.length} features)`);
}

async function convertSubzonas() {
  const geojson = await readShapefile('subzonas');
  if (!geojson) return;
  for (const f of geojson.features) {
    f.geometry = reprojectGeometry(f.geometry);
    const subzona = String(f.properties.Subzona);
    f.properties.name = subzona;
    f.properties.color = SUBZONA_COLORS[subzona] || DEFAULT_COLOR;
    f.properties.fillColor = f.properties.color;
    f.properties.fillOpacity = 0.3;
  }
  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(path.join(OUT_DIR, 'subzonas.geojson'), JSON.stringify(geojson, null, 2));
  console.log(`✓ subzonas -> public/data/subzonas.geojson (${geojson.features.length} features)`);
}

async function convertSectores() {
  const geojson = await readShapefile('sectores');
  if (!geojson) return;
  for (const f of geojson.features) {
    f.geometry = reprojectGeometry(f.geometry);
    const zona = String(f.properties.Zona);
    const subZona = f.properties['Sub Zona'];
    f.properties.name = `Sector ${f.properties.Sector}${subZona ? ` (${subZona})` : ''}`;
    f.properties.color = SECTOR_ZONA_COLORS[zona] || DEFAULT_COLOR;
    f.properties.fillColor = f.properties.color;
    f.properties.fillOpacity = 0.3;
  }
  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(path.join(OUT_DIR, 'sectores.geojson'), JSON.stringify(geojson, null, 2));
  console.log(`✓ sectores -> public/data/sectores.geojson (${geojson.features.length} features)`);
}

async function main() {
  if (!existsSync(INPUT_DIR)) {
    console.error(`No existe ${INPUT_DIR}. Creala y poné ahí los .shp/.dbf.`);
    process.exit(1);
  }
  await convertZonas();
  await convertSubzonas();
  await convertSectores();
  console.log('\nListo.');
}

main();
