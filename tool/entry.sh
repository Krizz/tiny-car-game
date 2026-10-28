#!/bin/sh
# The tool image's commands (start.sh runs them):
#   prepare <input> [--rebuild] [--no-music]   disc / game folder -> /out/game
#   serve                                      the game server on PORT (8080) + RTC_PORT/udp, files from /out
#   udpcheck <ws url> <address,...>            can a peer reach the server's UDP port at these addresses?
set -e
cmd=${1:-serve}
[ $# -gt 0 ] && shift
case "$cmd" in
  prepare) exec python3 /tool/prepare.py "$@" ;;
  serve)
    [ -d /out/game ] || { echo "error: /out/game is missing — run prepare first"; exit 1; }
    mkdir -p /out/laps
    export LAPS_DIR=/out/laps/
    cd /app
    exec bun run server.ts ;;
  udpcheck) cd /app && exec bun /tool/udpcheck.ts "$@" ;;
  *) exec "$cmd" "$@" ;;
esac
