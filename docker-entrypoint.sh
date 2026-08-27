#!/usr/bin/env sh
set -eu

mkdir -p /app/data /app/downloads

if [ "$(id -u)" = "0" ]; then
  chown -R node:node /app/data /app/downloads
  exec gosu node "$@"
fi

exec "$@"
