#!/bin/sh
set -eu
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  campus_node_bin=/home/issmail/.local/share/sanaa-runtime/node-v22.23.3-linux-x64/bin
  if [ -x "$campus_node_bin/node" ]; then
    PATH="$campus_node_bin:$PATH"
    export PATH
  else
    echo 'Node 22.13 or later is required. Add Node and npm to PATH.' >&2
    exit 1
  fi
fi
if [ ! -d node_modules ]; then npm ci; fi
npm run build
exec npm start
