// src/app/fakeCamera.ts — cámara sintética para CI/E2E (?fake=1).
// Extraído del harness F5 (misma escena: documento sobre fondo oscuro con
// texto simulado). Sin dependencias del DOM salvo document/canvas estándar.
// El stream sale de canvas.captureStream; el loop de dibujo vive en un
// setInterval (el caller lo detiene con stop()).

export interface FakeCamera {
  stream: MediaStream;
  source: HTMLCanvasElement;
  stop(): void;
}

export function makeFakeCamera(doc: Document, fps = 15): FakeCamera {
  const canvas = doc.createElement('canvas');
  canvas.width = 640;
  canvas.height = 480;
  const ctx = canvas.getContext('2d');
  if (ctx === null) throw new Error('fakeCamera: sin contexto 2d');
  let frame = 0;
  const timer = setInterval(() => {
    frame++;
    ctx.fillStyle = '#252525';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const x = canvas.width * 0.12;
    const y = canvas.height * 0.1;
    const w = canvas.width * 0.76;
    const h = canvas.height * 0.8;
    // Papel a niveles FOTOGRÁFICOS (luma ~220, bajo el clip 225): una cámara
    // real expone el papel sin clipar; el fixture debe representar una
    // captura pasable por el gate de exposición (hallazgo E2E T7: #f7f7f2
    // clipeaba al 61% y el gate la rechazaba correctamente, siempre retry).
    ctx.fillStyle = '#dcdcd6';
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = '#111';
    ctx.font = '28px system-ui';
    ctx.fillText('Documento SPA', x + 28, y + 55);
    for (let i = 0; i < 8; i++) ctx.fillRect(x + 30, y + 95 + i * 28, w * 0.72, 8 + (i % 3));
    ctx.fillStyle = '#222';
    for (let row = 0; row < 28; row++) {
      const yy = y + 70 + row * 11;
      for (let col = 0; col < 70; col++) {
        if ((row * 31 + col * 17 + frame) % 5 < 2) ctx.fillRect(x + 28 + col * 8, yy, 5, 2);
      }
    }
    ctx.fillStyle = '#888';
    ctx.font = '12px system-ui';
    ctx.fillText(`frame ${frame}`, x + 30, y + h - 20);
  }, Math.max(16, Math.round(1000 / fps)));
  const stream = canvas.captureStream(fps);
  return { stream, source: canvas, stop: () => clearInterval(timer) };
}
