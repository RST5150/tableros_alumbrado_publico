// Comprime una foto en el navegador antes de subirla (reduce dimensiones + recodifica a JPEG),
// para no depender de que el celular ya la haya sacado liviana ni de bajarle la calidad a mano.
// Sin librería externa: alcanza con canvas, que ya está disponible en cualquier navegador.
const MAX_DIMENSION = 1600;
const JPEG_QUALITY = 0.75;

async function loadBitmap(file) {
  if (window.createImageBitmap) {
    try {
      return await createImageBitmap(file);
    } catch {
      // Sigue al fallback de <img> — createImageBitmap puede no soportar el formato puntual
      // del archivo en este navegador aunque sí sea una imagen válida.
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = () => reject(new Error('No se pudo leer la imagen.'));
      img.src = url;
    });
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

// Devuelve un File nuevo (JPEG, redimensionado) o el original si comprimir no ayudó o falló
// (ej. formato que el navegador no puede decodificar, como algunos HEIC) — nunca bloquea la
// subida por un error acá, en el peor caso se sube el archivo tal cual venía.
export async function compressImage(file, { maxDimension = MAX_DIMENSION, quality = JPEG_QUALITY } = {}) {
  try {
    const bitmap = await loadBitmap(file);
    const width = bitmap.width || bitmap.naturalWidth;
    const height = bitmap.height || bitmap.naturalHeight;
    const scale = Math.min(1, maxDimension / Math.max(width, height));
    const targetWidth = Math.round(width * scale);
    const targetHeight = Math.round(height * scale);

    const canvas = document.createElement('canvas');
    canvas.width = targetWidth;
    canvas.height = targetHeight;
    canvas.getContext('2d').drawImage(bitmap, 0, 0, targetWidth, targetHeight);
    bitmap.close?.();

    const blob = await new Promise((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('No se pudo comprimir la imagen.'))), 'image/jpeg', quality)
    );

    if (blob.size >= file.size) return file;

    const newName = file.name.replace(/\.[^.]+$/, '') + '.jpg';
    return new File([blob], newName, { type: 'image/jpeg' });
  } catch {
    return file;
  }
}
