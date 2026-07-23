// scripts/generate-icons.js — genera l'icona "gauge" dell'app (tray + finestra/pacchetto),
// senza aggiungere dipendenze esterne (vedi CLAUDE.md): un rasterizzatore vettoriale minimale
// con supersampling per l'antialiasing, incapsulato in un encoder PNG scritto a mano (solo
// node:zlib per la compressione IDAT + un CRC32 table-based per i chunk).
//
// Script eseguito una tantum (`node scripts/generate-icons.js`): gli asset generati sono
// statici e deterministici, si rigenerano solo se si vuole ridisegnare l'icona — non fa parte
// di `npm run build`. Per .ico/.icns non serve altro codice qui: electron-builder li genera
// automaticamente da build/icon.png (vedi package.json, campo "build.icon").

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');
const ACCENT = [37, 99, 235, 255]; // #2563eb, stesso --accent di renderer/style.css
const WHITE = [255, 255, 255, 255];

// ---------------------------------------------------------------------------
// PNG encoder minimale (RGBA, 8 bit per canale, nessun filtro riga)
// ---------------------------------------------------------------------------
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function encodePng(size, rgbaBuffer) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0; // filtro riga "none"
    rgbaBuffer.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });

  return Buffer.concat([signature, pngChunk('IHDR', ihdr), pngChunk('IDAT', idat), pngChunk('IEND', Buffer.alloc(0))]);
}

// ---------------------------------------------------------------------------
// Rasterizzatore vettoriale con supersampling (antialiasing via media pesata
// sull'alpha, per non "sporcare" i bordi con nero alle zone trasparenti).
// ---------------------------------------------------------------------------
const SUPERSAMPLE = 4;

function rasterize(size, drawFn) {
  const buffer = Buffer.alloc(size * size * 4);
  const step = 1 / SUPERSAMPLE;
  const n = SUPERSAMPLE * SUPERSAMPLE;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let sumR = 0, sumG = 0, sumB = 0, sumA = 0;
      for (let sy = 0; sy < SUPERSAMPLE; sy++) {
        for (let sx = 0; sx < SUPERSAMPLE; sx++) {
          const hx = x + (sx + 0.5) * step;
          const hy = y + (sy + 0.5) * step;
          const [r, g, b, a] = drawFn(hx, hy);
          sumR += r * a;
          sumG += g * a;
          sumB += b * a;
          sumA += a;
        }
      }
      const avgA = sumA / n;
      const idx = (y * size + x) * 4;
      if (sumA > 0) {
        buffer[idx] = Math.round(sumR / sumA);
        buffer[idx + 1] = Math.round(sumG / sumA);
        buffer[idx + 2] = Math.round(sumB / sumA);
      }
      buffer[idx + 3] = Math.round(avgA);
    }
  }
  return buffer;
}

// ---------------------------------------------------------------------------
// Disegno del gauge: anello, tacche su un arco di 270°, lancetta, mozzo.
// ---------------------------------------------------------------------------
function makeGaugeDrawFn({ size, foreground, background = null, roundedSquare = false }) {
  const cx = size / 2;
  const cy = size / 2;
  const rOuter = size * 0.42;
  const rInner = size * 0.34;
  const tickOuter = size * 0.40;
  const tickInner = size * 0.30;
  const needleLen = size * 0.3;
  const needleHalfBase = size * 0.045;
  const hubR = size * 0.06;
  const needleAngle = (-55 * Math.PI) / 180; // punta in alto a destra, lettura "moderata"
  const sweepStartDeg = 135;
  const sweepSpanDeg = 270; // apertura di 270°, "vuoto" in basso — stile speedometer
  const tickCount = 6;
  const tickHalfWidthDeg = 4;
  const cornerRadius = size * 0.22;
  const squareMargin = size * 0.04;

  function insideRoundedSquare(x, y) {
    const dx = Math.abs(x - cx) - (size / 2 - squareMargin - cornerRadius);
    const dy = Math.abs(y - cy) - (size / 2 - squareMargin - cornerRadius);
    const qx = Math.max(dx, 0);
    const qy = Math.max(dy, 0);
    const dist = Math.sqrt(qx * qx + qy * qy) + Math.min(Math.max(dx, dy), 0) - cornerRadius;
    return dist <= 0;
  }

  const TRANSPARENT = [0, 0, 0, 0];

  return function drawFn(x, y) {
    const dx = x - cx;
    const dy = y - cy;
    const dist = Math.sqrt(dx * dx + dy * dy);

    if (dist <= hubR) return foreground;

    const ndx = Math.cos(needleAngle);
    const ndy = Math.sin(needleAngle);
    const proj = dx * ndx + dy * ndy;
    if (proj >= -needleHalfBase && proj <= needleLen) {
      const perp = Math.abs(-dx * ndy + dy * ndx);
      const t = Math.max(0, proj) / needleLen;
      const halfWidth = needleHalfBase * (1 - t) + size * 0.004;
      if (perp <= halfWidth) return foreground;
    }

    if (dist >= tickInner && dist <= tickOuter) {
      let angleDeg = (Math.atan2(dy, dx) * 180) / Math.PI;
      if (angleDeg < 0) angleDeg += 360;
      let rel = angleDeg - sweepStartDeg;
      if (rel < 0) rel += 360;
      if (rel <= sweepSpanDeg) {
        const tickStep = sweepSpanDeg / (tickCount - 1);
        const nearestAngle = Math.round(rel / tickStep) * tickStep;
        if (Math.abs(rel - nearestAngle) < tickHalfWidthDeg) return foreground;
      }
    }

    if (dist >= rInner && dist <= rOuter) return foreground;

    if (roundedSquare && background && insideRoundedSquare(x, y)) return background;

    return TRANSPARENT;
  };
}

function generate(size, opts) {
  return encodePng(size, rasterize(size, makeGaugeDrawFn({ size, ...opts })));
}

function writeFile(relativePath, data) {
  const fullPath = path.join(ROOT, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, data);
  console.log(`[generate-icons] scritto ${relativePath} (${data.length} byte)`);
}

// Icona applicativa: sfondo quadrato arrotondato colore accento, glifo bianco. Scritta in
// due punti identici:
// - build/icon.png: sorgente per electron-builder (genera .ico/.icns automaticamente da un
//   unico PNG quadrato al momento di `npm run package`), NON copiata in dist/.
// - renderer/assets/app-icon.png: usata a runtime da main/windows.ts per l'icona di finestra
//   (soprattutto utile in `npm start`, non pacchettizzato). Passa dalla stessa pipeline già
//   funzionante di renderer/assets/ (copiata in dist/renderer/assets/ da scripts/copy-assets.js),
//   perché build/ non viene copiata in dist/ e non sarebbe altrimenti raggiungibile a runtime.
const appIcon = generate(1024, { foreground: WHITE, background: ACCENT, roundedSquare: true });
writeFile('build/icon.png', appIcon);
writeFile('renderer/assets/app-icon.png', appIcon);

// electron-builder genera l'icona Linux derivandola dal .icns di macOS — ma sulla CI ogni
// piattaforma builda a sé (il job Linux non esegue mai --mac), quindi su un runner Linux
// non c'è mai un .icns da cui derivare, e l'AppImage/deb finisce con l'icona di Electron di
// default. Fix: build/icons/ con le dimensioni esplicite (convenzione electron-builder,
// nessuna voce aggiuntiva richiesta in package.json — stesso build.buildResources di default).
const LINUX_ICON_SIZES = [16, 24, 32, 48, 64, 96, 128, 256, 512, 1024];
for (const size of LINUX_ICON_SIZES) {
  writeFile(`build/icons/${size}x${size}.png`, generate(size, { foreground: WHITE, background: ACCENT, roundedSquare: true }));
}

// Icona tray: sfondo trasparente, glifo monocromatico colore accento — nativeImage la
// carica direttamente, nessuna conversione richiesta (main/tray.ts già pronto).
writeFile('renderer/assets/tray-icon.png', generate(64, { foreground: ACCENT }));
