// Convierte los KML/KMZ exportados de Google My Maps a los formatos que usa la app:
//  - capas de polígonos (Zonas, Subzonas, Sectores) -> public/data/*.geojson
//    (se conserva el color de relleno/borde que ya tenía cada polígono en My Maps)
//  - capas de puntos (Tableros Zona 1/2/3)          -> scripts/output/*.csv
//    (ese CSV se importa a mano como hoja en el Google Sheet maestro, ver README)
//
// Uso:
//   1. Poné los .kml o .kmz exportados en scripts/input/, con estos nombres exactos:
//      zonas.kml(z), subzonas.kml(z), sectores.kml(z),
//      tableros_zona1.kml(z), tableros_zona2.kml(z), tableros_zona3.kml(z)
//      (los que no tengas, simplemente no se generan)
//   2. pnpm kml-convert

import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { DOMParser } from '@xmldom/xmldom';
import { kml } from '@tmcw/togeojson';
import AdmZip from 'adm-zip';

const ROOT = path.resolve(import.meta.dirname, '..');
const INPUT_DIR = path.join(ROOT, 'scripts', 'input');
const GEOJSON_OUT_DIR = path.join(ROOT, 'public', 'data');
const CSV_OUT_DIR = path.join(ROOT, 'scripts', 'output');

const POLYGON_LAYERS = ['zonas', 'subzonas', 'sectores'];
const POINT_LAYERS = ['tableros_zona1', 'tableros_zona2', 'tableros_zona3'];

// Propiedades que vienen en todo KML de My Maps pero no sirven para mostrar (son de estilo
// o quedan redundantes con la geometría/el "name" que ya se procesa aparte).
const NOISE_KEYS = new Set([
  'description', 'styleUrl', 'icon', 'icon-scale', 'icon-color', 'icon-opacity',
  'label-scale', 'label-color', 'label-opacity', 'line-color',
  'fill', 'fill-opacity', 'stroke', 'stroke-opacity', 'stroke-width',
  'name', 'latitud', 'longitud', 'lat', 'long', 'descripción', 'descripcion',
]);

function csvEscape(value) {
  const s = String(value ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// My Maps exporta muchos valores numéricos como "16309.0" / "9307.0". Se ve mejor sin el ".0".
function cleanValue(value) {
  const s = String(value ?? '').trim();
  return /^-?\d+\.0$/.test(s) ? s.slice(0, -2) : s;
}

// Devuelve el texto del KML para `name`, ya sea que exista como .kml suelto o .kmz
// (zip con un doc.kml adentro, que es lo que exporta Google My Maps). null si no hay ninguno.
async function readKmlText(name) {
  const kmlFile = path.join(INPUT_DIR, `${name}.kml`);
  if (existsSync(kmlFile)) return readFile(kmlFile, 'utf8');

  const kmzFile = path.join(INPUT_DIR, `${name}.kmz`);
  if (existsSync(kmzFile)) {
    const zip = new AdmZip(kmzFile);
    const entry = zip.getEntries().find((e) => e.entryName.toLowerCase().endsWith('.kml'));
    if (!entry) throw new Error(`${name}.kmz no contiene ningún .kml adentro`);
    return zip.readAsText(entry);
  }

  return null;
}

// Arma una etiqueta legible para el tooltip de cada polígono, a partir de lo que haya
// disponible (Subzona/Sector/ZONAS son las columnas reales que trae My Maps).
function polygonLabel(props) {
  if (props.name) return props.name;
  if (props.Subzona) return `Subzona ${props.Subzona}`;
  if (props.Sector) return `Sector ${props.Sector}${props['Sub Zona'] ? ` (${props['Sub Zona']})` : ''}`;
  if (props.ZONAS) return `Zona ${props.ZONAS}`;
  return '';
}

async function convertPolygon(name) {
  const text = await readKmlText(name);
  if (!text) return;
  const xml = new DOMParser().parseFromString(text, 'text/xml');
  const geojson = kml(xml);

  for (const feature of geojson.features) {
    const props = feature.properties || {};
    feature.properties = {
      ...props,
      name: polygonLabel(props),
      // Se guardan aparte para que layers.js pueda usar el color real de My Maps.
      fillColor: props.fill,
      color: props.stroke,
      fillOpacity: props['fill-opacity'],
    };
  }

  await mkdir(GEOJSON_OUT_DIR, { recursive: true });
  await writeFile(path.join(GEOJSON_OUT_DIR, `${name}.geojson`), JSON.stringify(geojson, null, 2));
  console.log(`✓ ${name} -> public/data/${name}.geojson (${geojson.features.length} features)`);
}

async function convertPoints(name) {
  const text = await readKmlText(name);
  if (!text) return;
  const xml = new DOMParser().parseFromString(text, 'text/xml');
  const geojson = kml(xml);

  const points = geojson.features.filter((f) => f.geometry?.type === 'Point');

  // Columnas extra: la unión de todas las propiedades "útiles" que aparecen en los puntos
  // (Tipo, Clasificación, Calle, Responsable, etc.), en el orden en que se van encontrando.
  const extraKeys = [];
  for (const feature of points) {
    for (const key of Object.keys(feature.properties || {})) {
      if (!NOISE_KEYS.has(key) && !extraKeys.includes(key)) extraKeys.push(key);
    }
  }

  const header = ['Nombre', 'Lat', 'Lon', ...extraKeys];
  const rows = [header];
  for (const feature of points) {
    const [lon, lat] = feature.geometry.coordinates;
    const props = feature.properties || {};
    const nombre = cleanValue(props.name);
    const extras = extraKeys.map((k) => cleanValue(props[k]));
    rows.push([nombre, lat, lon, ...extras]);
  }

  await mkdir(CSV_OUT_DIR, { recursive: true });
  const csv = rows.map((r) => r.map(csvEscape).join(',')).join('\n');
  await writeFile(path.join(CSV_OUT_DIR, `${name}.csv`), csv);
  console.log(`✓ ${name} -> scripts/output/${name}.csv (${rows.length - 1} puntos, columnas: ${header.join(', ')})`);
}

async function main() {
  if (!existsSync(INPUT_DIR)) {
    console.error(`No existe ${INPUT_DIR}. Creala y poné ahí los .kml/.kmz exportados de My Maps.`);
    process.exit(1);
  }
  const files = (await readdir(INPUT_DIR)).filter((f) => !f.startsWith('.'));
  if (files.length === 0) {
    console.error(`scripts/input/ está vacía. Exportá los KML/KMZ de My Maps y ponelos ahí.`);
    process.exit(1);
  }

  for (const name of POLYGON_LAYERS) await convertPolygon(name);
  for (const name of POINT_LAYERS) await convertPoints(name);

  console.log('\nListo. Los .geojson de polígonos ya quedaron en public/data/.');
  console.log('Los .csv de tableros están en scripts/output/: importalos como hojas en el Google Sheet maestro.');
}

main();
