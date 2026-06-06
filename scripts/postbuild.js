import fs from 'fs';
import path from 'path';

const DIST_DIR = 'dist';
const ASSETS_DIR = path.join(DIST_DIR, 'assets');

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} kB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function getFileSizes(dir, extension) {
  if (!fs.existsSync(dir)) return { total: 0, files: [] };

  const files = fs.readdirSync(dir)
    .filter(f => f.endsWith(extension))
    .map(f => ({
      name: f,
      size: fs.statSync(path.join(dir, f)).size
    }))
    .sort((a, b) => b.size - a.size);

  return {
    total: files.reduce((sum, f) => sum + f.size, 0),
    files
  };
}

// Copy extensions (only runtime assets, not dev dependencies)
if (fs.existsSync('extensions')) {
  const extensionsDest = path.join(DIST_DIR, 'extensions');
  fs.mkdirSync(extensionsDest, { recursive: true });
  
  // Files/directories that are needed at runtime
  const runtimeAssets = [
    'package.json',
    'package.nls.json',
    'dist',
    'out',
    'syntaxes',
    'themes',
    'snippets',
    'language-configuration.json',
    'icon.png',
    'media',
    'preview-src',
    'schemas',
    'notebook-out',
  ];
  
  const extensionDirs = fs.readdirSync('extensions', { withFileTypes: true })
    .filter(dirent => dirent.isDirectory())
    .map(dirent => dirent.name);
  
  for (const extName of extensionDirs) {
    const extSrc = path.join('extensions', extName);
    const extDest = path.join(extensionsDest, extName);
    
    fs.mkdirSync(extDest, { recursive: true });
    
    for (const asset of runtimeAssets) {
      const srcPath = path.join(extSrc, asset);
      const destPath = path.join(extDest, asset);
      
      if (fs.existsSync(srcPath)) {
        const stat = fs.statSync(srcPath);
        if (stat.isDirectory()) {
          fs.cpSync(srcPath, destPath, { recursive: true });
        } else {
          fs.copyFileSync(srcPath, destPath);
        }
      }
    }
  }
}
if (fs.existsSync('extensions-meta.json')) {
  fs.copyFileSync('extensions-meta.json', path.join(DIST_DIR, 'extensions-meta.json'));
}
console.log('Post-build: copied extensions (filtered)\n');

// Calculate bundle sizes
const js = getFileSizes(ASSETS_DIR, '.js');
const css = getFileSizes(ASSETS_DIR, '.css');
const wasm = getFileSizes(ASSETS_DIR, '.wasm');
const other = getFileSizes(ASSETS_DIR, '.ttf');

console.log('═══════════════════════════════════════════════════════════');
console.log('                    BUNDLE SIZE SUMMARY                     ');
console.log('═══════════════════════════════════════════════════════════');
console.log(`  JavaScript:  ${formatSize(js.total).padStart(12)}`);
console.log(`  CSS:         ${formatSize(css.total).padStart(12)}`);
console.log(`  Fonts:       ${formatSize(other.total).padStart(12)}`);
console.log(`  WASM:        ${formatSize(wasm.total).padStart(12)}`);
console.log('───────────────────────────────────────────────────────────');
console.log(`  TOTAL:       ${formatSize(js.total + css.total + other.total + wasm.total).padStart(12)}`);
console.log('═══════════════════════════════════════════════════════════');

// Show top 5 largest JS files
console.log('\nTop 5 largest JS chunks:');
js.files.slice(0, 5).forEach((f, i) => {
  console.log(`  ${i + 1}. ${f.name.padEnd(50)} ${formatSize(f.size).padStart(10)}`);
});
console.log('');
