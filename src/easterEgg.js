import { isMobileDevice } from './layers.js';

// Easter egg: código Konami clásico (↑↑↓↓←→←→ B A) con el teclado. Solo en desktop — en
// mobile no hay teclado físico, así que no tendría sentido (y evita que un teclado bluetooth
// lo dispare por accidente).
const SEQUENCE = [
  'ArrowUp',
  'ArrowUp',
  'ArrowDown',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'ArrowLeft',
  'ArrowRight',
  'KeyB',
  'KeyA',
];
const LINK = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';

export function initKonamiCode() {
  if (isMobileDevice()) return;

  let progress = 0;
  document.addEventListener('keydown', (e) => {
    if (e.code === SEQUENCE[progress]) {
      progress += 1;
      if (progress === SEQUENCE.length) {
        progress = 0;
        window.open(LINK, '_blank');
      }
    } else {
      // Si la tecla que falló es igual al principio de la secuencia, arranca de nuevo desde
      // ahí en vez de exigir reiniciar sin ningún margen de error.
      progress = e.code === SEQUENCE[0] ? 1 : 0;
    }
  });
}
