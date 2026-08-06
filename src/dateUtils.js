// El Sheet trae "Última Inspección" en distintos formatos según cómo se cargó: aaaa-mm-dd
// (ISO, si vino del input type=date que se usaba antes) o mm/dd/aaaa (locale en-US de la
// planilla). Acá se centraliza la conversión hacia/desde el dd/mm/aaaa que se usa en toda la
// interfaz, para no depender del formato de fecha que le toque a cada navegador/SO.

export function toDisplayDate(value) {
  const v = (value || '').trim();
  if (!v) return '';
  let m = v.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return `${m[3].padStart(2, '0')}/${m[2].padStart(2, '0')}/${m[1]}`;
  m = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[2].padStart(2, '0')}/${m[1].padStart(2, '0')}/${m[3]}`;
  return v;
}

// Convierte dd/mm/aaaa (lo que tipea el usuario en el formulario) a aaaa-mm-dd (lo que se
// manda a guardar, igual que antes cuando el campo era un input type=date nativo). Devuelve
// null si el texto no tiene ese formato o el día/mes no son válidos.
export function displayDateToIso(display) {
  const m = (display || '').trim().match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!m) return null;
  const [, dd, mm, yyyy] = m;
  const day = Number(dd);
  const month = Number(mm);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${yyyy}-${mm}-${dd}`;
}
