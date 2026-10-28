# The game server and its converter in one image (start.sh builds and runs it). No game files in it:
# they are made from the user's own disc by `prepare` into a mounted folder, which `serve` serves.
#   docker build -t game-server -f tool/Dockerfile .
FROM mwader/static-ffmpeg:9.0.2 AS ffmpeg

FROM oven/bun:1.3.0
RUN apt-get update && apt-get install -y --no-install-recommends python3 7zip ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY --from=ffmpeg /ffmpeg /usr/local/bin/ffmpeg
WORKDIR /app
COPY src/package.json src/bun.lock ./
RUN bun install --frozen-lockfile
COPY src/ ./
# the page (code + physics wasm); public/game holds only the CPU drivers' training files here
# (.dockerignore), which `prepare` copies next to the converted levels. The page loads /game/… and
# the server's CPU drivers read public/game/…: both point at the converted folder in /out
RUN bun run build && mv public/game training && rm -rf dist/game \
  && ln -s /out/game public/game && ln -s /out/game dist/game
COPY convert/convert.py tool/prepare.py tool/entry.sh tool/udpcheck.ts /tool/
RUN chmod +x /tool/entry.sh
# runs as the user's own id (start.sh), so the port inside is above 1024
ENV APP=/app OUT=/out PORT=8080 HOME=/tmp
EXPOSE 8080
ENTRYPOINT ["/tool/entry.sh"]
CMD ["serve"]
