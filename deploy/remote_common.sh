#!/usr/bin/env bash
# Shared by the four remote commands; run those scripts instead.
set -euo pipefail

if [[ $# -ne 1 || $1 == --help || $1 == -h ]]; then
    echo "Usage: $(basename "$0") user@host" >&2
    exit 1
fi
REMOTE=$1
if [[ ! $REMOTE =~ ^[a-zA-Z0-9_][a-zA-Z0-9_.@-]*$ ]]; then
    echo 'Use user@hostname, user@IPv4-address, or an SSH config alias.' >&2
    exit 1
fi
PROJECT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)

# Noninteractive sudo is required because SSH stdin carries setup commands.
remote_root() {
    ssh "$REMOTE" 'sudo -n bash -se'
}

copy_project() {
    remote_root <<'REMOTE'
command -v rsync >/dev/null || { echo 'Install rsync on the remote host first.' >&2; exit 1; }
install -d -m 0755 /opt/cat-tracker/src /opt/cat-tracker/deploy
REMOTE
    rsync -az --rsync-path='sudo -n rsync' --chmod=D755,F644 \
        "$PROJECT_DIR/package.json" "$PROJECT_DIR/package-lock.json" \
        "$PROJECT_DIR/tsconfig.json" "$PROJECT_DIR/tsconfig.build.json" "$PROJECT_DIR/tsconfig.test.json" \
        "$PROJECT_DIR/nest-cli.json" "$PROJECT_DIR/jest.config.cjs" "$PROJECT_DIR/eslint.config.mjs" \
        "$PROJECT_DIR/.prettierrc.json" "$PROJECT_DIR/.prettierignore" \
        "$PROJECT_DIR/README.md" "$PROJECT_DIR/config.example.json" "$PROJECT_DIR/tags.example.json" \
        "$REMOTE:/opt/cat-tracker/"
    rsync -az --rsync-path='sudo -n rsync' --chmod=D755,F644 \
        "$PROJECT_DIR/deploy/cat-tracker.service" \
        "$REMOTE:/opt/cat-tracker/deploy/"
    # Synchronize application source; configuration and state live outside this directory.
    rsync -az --delete --rsync-path='sudo -n rsync' --chmod=D755,F644 \
        "$PROJECT_DIR/src/" "$REMOTE:/opt/cat-tracker/src/"
    for directory in views public scripts test; do
        rsync -az --delete --rsync-path='sudo -n rsync' --chmod=D755,F644 \
            "$PROJECT_DIR/$directory/" "$REMOTE:/opt/cat-tracker/$directory/"
    done
}
