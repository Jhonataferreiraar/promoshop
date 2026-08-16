#!/bin/sh
set -eu

if [ "$(id -u)" = "0" ]; then
  data_directory="${DATA_DIR:-/var/data}"
  mkdir -p "$data_directory"
  chown -R node:node "$data_directory"
  exec gosu node "$@"
fi

exec "$@"
