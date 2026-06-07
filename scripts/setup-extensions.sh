#!/usr/bin/env bash
set -euo pipefail

VSCODE_VERSION="1.115.0"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXTENSIONS_DIR="$REPO_ROOT/extensions"

inject_custom_themes() {
  local CUSTOM_THEMES_DIR="$REPO_ROOT/scripts/themes"
  local THEME_DEFAULTS_DIR="$EXTENSIONS_DIR/theme-defaults"

  if [[ ! -d "$CUSTOM_THEMES_DIR" ]]; then
    return
  fi

  echo "Injecting custom themes from scripts/themes/..."
  mkdir -p "$THEME_DEFAULTS_DIR/themes"

  for theme_file in "$CUSTOM_THEMES_DIR"/*.json; do
    [[ -f "$theme_file" ]] || continue
    local basename
    basename="$(basename "$theme_file")"
    cp "$theme_file" "$THEME_DEFAULTS_DIR/themes/$basename"
    echo "  Copied $basename"
  done

  # Patch theme-defaults/package.json to register custom themes
  local PKG_JSON="$THEME_DEFAULTS_DIR/package.json"
  if [[ -f "$PKG_JSON" ]]; then
    node -e "
      const fs = require('fs');
      const pkg = JSON.parse(fs.readFileSync('$PKG_JSON', 'utf8'));
      const themes = pkg.contributes?.themes || [];
      const customDir = '$CUSTOM_THEMES_DIR';
      const files = fs.readdirSync(customDir).filter(f => f.endsWith('.json'));
      for (const file of files) {
        const meta = JSON.parse(fs.readFileSync(customDir + '/' + file, 'utf8'));
        const name = meta.name || file.replace('.json', '');
        const id = name;
        if (themes.some(t => t.id === id)) continue;
        themes.push({
          id: id,
          label: name,
          uiTheme: meta.type === 'light' ? 'vs' : 'vs-dark',
          path: './themes/' + file
        });
        console.log('  Registered theme: ' + name);
      }
      pkg.contributes.themes = themes;
      fs.writeFileSync('$PKG_JSON', JSON.stringify(pkg, null, 2) + '\n');
    "
  fi
}

if [[ -d "$EXTENSIONS_DIR" && "$(ls -A "$EXTENSIONS_DIR" 2>/dev/null | wc -l)" -gt 10 ]]; then
  echo "extensions/ already populated ($(ls "$EXTENSIONS_DIR" | wc -l | tr -d ' ') entries) — skipping download."
  inject_custom_themes
  exit 0
fi

mkdir -p "$EXTENSIONS_DIR"

VSCODE_CANDIDATES=(
  "/Applications/Visual Studio Code.app/Contents/Resources/app/extensions"
  "/Applications/Cursor.app/Contents/Resources/app/extensions"
  "/usr/share/code/resources/app/extensions"
  "/usr/lib/code/extensions"
  "/opt/visual-studio-code/resources/app/extensions"
  "$HOME/.vscode/extensions"
)

for candidate in "${VSCODE_CANDIDATES[@]}"; do
  if [[ -d "$candidate" && "$(ls -A "$candidate" 2>/dev/null | wc -l)" -gt 10 ]]; then
    echo "Found VSCode extensions at: $candidate"
    echo "Copying built-in extensions..."
    cp -r "$candidate"/. "$EXTENSIONS_DIR/"
    echo "Copied $(ls "$EXTENSIONS_DIR" | wc -l | tr -d ' ') extensions."
    inject_custom_themes
    exit 0
  fi
done

echo "No local VSCode installation found. Downloading from GitHub..."

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

curl -L --progress-bar \
  "https://github.com/microsoft/vscode/archive/refs/tags/${VSCODE_VERSION}.tar.gz" \
  -o "$TMP_DIR/vscode.tar.gz"

echo "Extracting extensions..."
tar -xzf "$TMP_DIR/vscode.tar.gz" -C "$TMP_DIR" "vscode-${VSCODE_VERSION}/extensions"
cp -r "$TMP_DIR/vscode-${VSCODE_VERSION}/extensions/." "$EXTENSIONS_DIR/"

echo "Done — $(ls "$EXTENSIONS_DIR" | wc -l | tr -d ' ') extensions installed."

inject_custom_themes
