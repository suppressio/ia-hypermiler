// scripts/copy-assets.js — copia gli asset non compilati del renderer (html, css,
// eventuali immagini) dentro dist/renderer/, accanto al JS prodotto da
// tsconfig.renderer.json. Script di build "puro Node", nessuna dipendenza extra,
// cross-platform (path.join, fs — mai comandi shell OS-specifici, come da CLAUDE.md).

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'renderer');
const DEST = path.join(ROOT, 'dist', 'renderer');

const SKIP_EXTENSIONS = new Set(['.ts']);

function copyRecursive(srcDir, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const srcPath = path.join(srcDir, entry.name);
    const destPath = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      copyRecursive(srcPath, destPath);
    } else if (!SKIP_EXTENSIONS.has(path.extname(entry.name))) {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

copyRecursive(SRC, DEST);
console.log(`[copy-assets] asset del renderer copiati in ${path.relative(ROOT, DEST)}`);
