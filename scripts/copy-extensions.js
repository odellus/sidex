import fs from 'fs';
import path from 'path';

const DIST_DIR = 'dist';

// Copy extensions (only runtime assets, not dev dependencies)
if (fs.existsSync('extensions')) {
  const extensionsDest = path.join(DIST_DIR, 'extensions');
  
  // Check if already copied and up to date
  let shouldCopy = true;
  if (fs.existsSync(extensionsDest)) {
    const existingExts = fs.readdirSync(extensionsDest);
    if (existingExts.length > 50) {
      console.log(`Extensions already present in dist/ (${existingExts.length} extensions) — skipping copy`);
      shouldCopy = false;
    }
  }
  
  if (shouldCopy) {
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
    
    let copiedCount = 0;
    for (const extName of extensionDirs) {
      const extSrc = path.join('extensions', extName);
      const extDest = path.join(extensionsDest, extName);
      
      fs.mkdirSync(extDest, { recursive: true });
      
      let hasAssets = false;
      for (const asset of runtimeAssets) {
        const srcPath = path.join(extSrc, asset);
        const destPath = path.join(extDest, asset);
        
        if (fs.existsSync(srcPath)) {
          hasAssets = true;
          const stat = fs.statSync(srcPath);
          if (stat.isDirectory()) {
            fs.cpSync(srcPath, destPath, { recursive: true });
          } else {
            fs.copyFileSync(srcPath, destPath);
          }
        }
      }
      
      if (hasAssets) {
        copiedCount++;
      }
    }
    
    console.log(`Copied ${copiedCount} extensions to dist/extensions (runtime assets only)`);
  }
}

if (fs.existsSync('extensions-meta.json')) {
  fs.mkdirSync(DIST_DIR, { recursive: true });
  const destPath = path.join(DIST_DIR, 'extensions-meta.json');
  fs.copyFileSync('extensions-meta.json', destPath);
}
