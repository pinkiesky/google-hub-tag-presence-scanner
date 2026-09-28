#!/usr/bin/env bash
set -euo pipefail
if [[ $# -ne 1 || ! $1 =~ ^[a-zA-Z0-9_][a-zA-Z0-9_.@-]*$ ]]; then
    echo "Usage: $(basename "$0") user@host" >&2
    exit 1
fi
REMOTE=$1
PROJECT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
remote_root() { ssh "$REMOTE" 'sudo -n bash -se'; }
copy_project() {
    remote_root <<'REMOTE'
command -v rsync >/dev/null || { echo 'Install rsync on the remote host first.' >&2; exit 1; }
install -d -m 0755 /opt/cat-presence-satellite-rpi
REMOTE
    for file in package.json package-lock.json tsconfig.json tsconfig.build.json tsconfig.test.json jest.config.cjs eslint.config.mjs .prettierrc.json .prettierignore README.md; do
        rsync -az --rsync-path='sudo -n rsync' --chmod=D755,F644 "$PROJECT_DIR/$file" "$REMOTE:/opt/cat-presence-satellite-rpi/"
    done
    for directory in src test deploy; do
        rsync -az --delete --rsync-path='sudo -n rsync' --chmod=D755,F644 "$PROJECT_DIR/$directory/" "$REMOTE:/opt/cat-presence-satellite-rpi/$directory/"
    done
}
