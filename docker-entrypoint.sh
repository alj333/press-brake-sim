#!/bin/sh
# Make the mounted data directory writable by the unprivileged 'node' user, then drop privileges.
# When the container is started with an explicit non-root `user:`, just run the command.
set -e
DATA_DIR="${DATA_DIR:-/data}"
if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA_DIR" 2>/dev/null || true
  chown -R node:node "$DATA_DIR" 2>/dev/null || true
  exec su-exec node "$@"
fi
exec "$@"
