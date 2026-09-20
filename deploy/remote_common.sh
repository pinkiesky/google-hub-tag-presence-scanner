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
install -d -m 0755 /opt/cat-tracker/src/cat_tracker /opt/cat-tracker/deploy
REMOTE
    rsync -az --rsync-path='sudo -n rsync' --chmod=D755,F644 \
        "$PROJECT_DIR/pyproject.toml" "$PROJECT_DIR/README.md" \
        "$PROJECT_DIR/config.example.toml" "$PROJECT_DIR/.env.example" \
        "$REMOTE:/opt/cat-tracker/"
    rsync -az --rsync-path='sudo -n rsync' --chmod=D755,F644 \
        "$PROJECT_DIR/deploy/cat-tracker.service" \
        "$PROJECT_DIR/deploy/90-cat-tracker-bluetooth.conf" \
        "$REMOTE:/opt/cat-tracker/deploy/"
    # Delete stale source files only; never touch the venv, configuration or database.
    rsync -az --delete --rsync-path='sudo -n rsync' --chmod=D755,F644 \
        --exclude='__pycache__/' --exclude='*.pyc' \
        "$PROJECT_DIR/src/cat_tracker/" "$REMOTE:/opt/cat-tracker/src/cat_tracker/"
}
