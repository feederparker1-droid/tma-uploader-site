#!/usr/bin/env bash
# Packs the game folder into a portal-ready zip (index.html at the archive root).
# Usage: scripts/pack.sh [out.zip]   → default dist/game-<version>-<date>.zip
set -euo pipefail
cd "$(dirname "$0")/.."
VER=$(grep -oE 'G\.VERSION *= *["'"'"'][^"'"'"']+' game/js/main.js 2>/dev/null | head -1 | sed -E 's/.*["'"'"']//' || true)
VER=${VER:-dev}
OUT=${1:-dist/game-${VER}-$(date +%Y%m%d).zip}
mkdir -p "$(dirname "$OUT")"
rm -f "$OUT"
if command -v zip >/dev/null 2>&1; then
  (cd game && zip -qr -X "../$OUT" . -x '*.DS_Store' -x '__MACOSX/*')
else
  python3 - "$OUT" <<'PY'
import os, sys, zipfile
out = sys.argv[1]
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
    for root, _, files in os.walk('game'):
        for f in files:
            if f == '.DS_Store': continue
            p = os.path.join(root, f)
            z.write(p, os.path.relpath(p, 'game'))
PY
fi
SIZE=$(du -h "$OUT" | cut -f1)
echo "packed $OUT ($SIZE)"
echo "Poki limit check (< 8 MB initial download):"; du -sh game | cut -f1
