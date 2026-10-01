// scripts/copy-assets.js — copies the renderer's non-compiled assets (html, css,
// images) into dist/renderer/, next to the JS produced by tsconfig.renderer.json.
// Plain Node build script, no extra dependency, cross-platform (path.join, fs —
// never OS-specific shell commands, see CLAUDE.md).

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

// The renderer compiles to ES modules while the rest of dist/ is CommonJS: this
// marker lets `node --test` load the renderer unit tests (renderer/**/*.test.ts)
// as ES modules. Irrelevant to Electron, which loads the renderer as browser
// <script type="module"> files.
fs.writeFileSync(path.join(DEST, 'package.json'), `${JSON.stringify({ type: 'module' }, null, 2)}\n`);
console.log(`[copy-assets] renderer assets copied to ${path.relative(ROOT, DEST)}`);
