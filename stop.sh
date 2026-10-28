#!/usr/bin/env bash
# Stop the server start.sh started (the converted game folder stays: the next start is quick).
#   ./stop.sh            NAME=game-server by default, as in start.sh
set -euo pipefail
NAME=${NAME:-game-server}
command -v docker >/dev/null || { echo "error: Docker is not installed" >&2; exit 1; }
if docker container inspect "$NAME" >/dev/null 2>&1; then
  docker rm -f "$NAME" >/dev/null
  echo "stopped $NAME"
else
  echo "$NAME is not running"
fi
