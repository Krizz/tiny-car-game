#!/usr/bin/env bash
# Turn your own compatible game disc into a browser multiplayer server, and start it. Only Docker is needed.
#   ./start.sh <disc image or game folder> <output folder> [--rebuild] [--no-music] [--fg]
#     disc image: .cue (with its .bin — has the music), .bin, .iso (no music); or a game/CD folder
#     output folder: where the converted game goes (≈130 MB); reused next time, so a second start is quick
#   --rebuild    convert again even if the output folder is up to date
#   --no-music   leave the CD music out
#   --fg         run in this terminal (Ctrl+C stops it) instead of in the background
# Settings (environment), all optional:
#   PORT=80          web port (the next free one is taken if it is busy)
#   UDP_PORT=7903    the fast car-state channel's port (same)
#   PUBLIC_IP=…      this server's address on the internet (found by asking api.ipify.org)
#   LAN_IP=…         its address on the local network (found from the routing table)
#   AI_RACERS=6      fill the grid with computer drivers up to this many cars
#   NAME=game-server  the container's name (several servers: give each its own, and its own folder)
# Stop it with ./stop.sh (same NAME).
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
NAME=${NAME:-game-server}
IMAGE=${IMAGE:-game-server}
die() { echo "error: $*" >&2; exit 1; }

input='' out='' fg=0 pflags=()
for a in "$@"; do
  case "$a" in
    --rebuild|--no-music) pflags+=("$a") ;;
    --fg) fg=1 ;;
    -h|--help) sed -n '2,19p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) die "unknown option $a (see ./start.sh --help)" ;;
    *) if [ -z "$input" ]; then input=$a; elif [ -z "$out" ]; then out=$a; else die "too many arguments"; fi ;;
  esac
done
[ -n "$input" ] && [ -n "$out" ] || { sed -n '2,19p' "$0" | sed 's/^# \{0,1\}//'; exit 1; }
[ -e "$input" ] || die "$input not found"

command -v docker >/dev/null || die "Docker is needed: https://docs.docker.com/get-docker/"
docker info >/dev/null 2>&1 || die "Docker is installed but not running (start Docker Desktop, or the docker service)"

# absolute paths (no realpath on every system)
if [ -d "$input" ]; then indir=$(cd "$input" && pwd); inarg=/in
else indir=$(cd "$(dirname "$input")" && pwd); inarg="/in/$(basename "$input")"; fi
mkdir -p "$out"
out=$(cd "$out" && pwd)
case "$out" in "$indir"|"$indir"/*) die "the output folder must not be inside the input folder" ;; esac
user="$(id -u):$(id -g)"

echo "• building the server image (the first time takes a few minutes)…"
log=$(mktemp)
trap 'rm -f "$log"' EXIT
docker build -q -t "$IMAGE" -f "$HERE/tool/Dockerfile" "$HERE" >"$log" 2>&1 || { cat "$log"; die "the image did not build"; }

echo "• preparing the game from $(basename "$input")"
docker run --rm --user "$user" -v "$indir":/in:ro -v "$out":/out "$IMAGE" prepare "$inarg" ${pflags[@]+"${pflags[@]}"} \
  | sed 's/^/    /' || die "preparing the game failed"

# an older server of the same name goes first (it may hold the ports)
if docker container inspect "$NAME" >/dev/null 2>&1; then
  echo "• stopping the server already running as $NAME"
  docker rm -f "$NAME" >/dev/null
fi

# free ports: the first that Docker can publish, from the asked one up
free() { # <port> <tcp|udp>
  docker run --rm -p "$1:9/$2" --entrypoint true "$IMAGE" >/dev/null 2>&1
}
pick() { # <start> <tcp|udp> <name> <setting>
  local p=$1
  for _ in $(seq 20); do
    if free "$p" "$2"; then echo "$p"; return; fi
    echo "    $3 port $p is busy" >&2
    p=$((p + 1))
  done
  die "no free $3 port from $1 to $((p - 1)); set $4"
}
port=$(pick "${PORT:-80}" tcp web PORT)
udp=$(pick "${UDP_PORT:-7903}" udp udp UDP_PORT)

# addresses: public (asked from the internet) and local network (from the routing table)
lan=${LAN_IP:-}
if [ -z "$lan" ]; then
  lan=$(ip -4 route get 1.1.1.1 2>/dev/null | sed -n 's/.* src \([0-9.]*\).*/\1/p' || true)
  [ -n "$lan" ] || lan=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || true)
  [ -n "$lan" ] || lan=$(hostname -I 2>/dev/null | awk '{print $1}' || true)
fi
pub=${PUBLIC_IP:-}
if [ -z "$pub" ]; then
  pub=$(docker run --rm --entrypoint bun "$IMAGE" -e \
    'try { console.log((await (await fetch("https://api.ipify.org", { signal: AbortSignal.timeout(5000) })).text()).trim()) } catch {}' \
    2>/dev/null | grep -E '^[0-9]+(\.[0-9]+){3}$' || true)
fi
ips=$(printf '%s\n' "$pub" "$lan" | grep . | awk '!seen[$0]++' | paste -sd, -)
[ -n "$ips" ] || echo "    warning: no address found for the fast channel; set PUBLIC_IP / LAN_IP (players will use the slower TCP fallback)"

run=(--name "$NAME" --user "$user" -p "$port:8080" -p "$udp:$udp/udp"
  -e RTC_PORT="$udp" -e RTC_PUBLIC_IP="$ips" -v "$out":/out)
[ -n "${AI_RACERS:-}" ] && run+=(-e AI_RACERS="$AI_RACERS")
if [ "$fg" = 1 ]; then
  echo "• starting on port $port (Ctrl+C stops it)"
  exec docker run --rm -it "${run[@]}" "$IMAGE" serve
fi
docker run -d --restart unless-stopped "${run[@]}" "$IMAGE" serve >/dev/null

# up?
for _ in $(seq 30); do
  docker logs "$NAME" 2>&1 | grep -q "cargame on" && break
  if ! docker container inspect -f '{{.State.Running}}' "$NAME" 2>/dev/null | grep -q true; then
    docker logs "$NAME" 2>&1 | tail -20; die "the server stopped"
  fi
  sleep 1
done

# the fast channel: from another container, through the published port, at each address
udp_ok=''
for ip in $(echo "$ips" | tr , ' '); do
  if r=$(docker run --rm "$IMAGE" udpcheck "ws://$ip:$port/ws" "$ip" 2>/dev/null) && [ "${r%% *}" = ok ]; then
    udp_ok="$udp_ok $ip"
  fi
done

url() { [ "$port" = 80 ] && echo "http://$1" || echo "http://$1:$port"; }
echo
echo "Server is running ($NAME)."
echo "  this computer:    $(url localhost)"
[ -n "$lan" ] && [ "$lan" != "$pub" ] && echo "  local network:    $(url "$lan")"
if [ -n "$pub" ]; then
  echo "  internet:         $(url "$pub")"
  if [ -n "$lan" ] && [ "$lan" != "$pub" ]; then
    echo "                    (for players outside your network, forward TCP $port and UDP $udp on your router to $lan)"
  fi
fi
if [ -n "$udp_ok" ]; then
  echo "  fast UDP channel: works at$udp_ok (UDP $udp)"
else
  echo "  fast UDP channel: could not be reached here — players still race over TCP, with more jitter"
  echo "                    (is UDP $udp open in a firewall? set PUBLIC_IP / LAN_IP if the address is wrong)"
fi
echo "  stop:             NAME=$NAME ./stop.sh    logs: docker logs -f $NAME"
