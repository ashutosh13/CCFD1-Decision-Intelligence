#!/bin/sh
# Run the dashboard on this machine (needs only Docker). Opens at http://localhost:8000
#   ./start.sh          pull the pre-built multi-architecture image and run it
#   ./start.sh --dev    build the image from this working copy first, then run it the same way
#   PORT=9000 ./start.sh   use another port;  IMAGE=...  use another image
cd "$(dirname "$0")"
PORT=${PORT:-8000}
IMAGE=${IMAGE:-ghcr.io/ashutosh13/ccfd1:latest}
case "$1" in
  --dev) IMAGE=ccfd1:dev; docker build -q -t "$IMAGE" -f docker/Dockerfile . >/dev/null || exit 1 ;;
  "") ;;
  *) echo "usage: ./start.sh [--dev]" >&2; exit 2 ;;
esac
if ! grep -q '^ANTHROPIC_API_KEY=.' .env 2>/dev/null; then
  printf 'Paste your Anthropic API key (or press Enter to skip the assistant): '
  read -r key
  [ -n "$key" ] && echo "ANTHROPIC_API_KEY=$key" >> .env
fi
if [ -f ccfd1-image.tar ]; then docker load -i ccfd1-image.tar        # offline copy, if you were given one
elif [ "$1" != "--dev" ]; then docker pull "$IMAGE"; fi
docker rm -f ccfd1 >/dev/null 2>&1
# Private incident rows (if this machine has them) are mounted read-only, never copied into the image.
[ -d datasets.private ] && PRIVATE="-v $PWD/datasets.private:/private:ro"
# Only the API key goes into the container, not the other .env values.
grep '^ANTHROPIC_API_KEY=' .env | docker run -d --name ccfd1 -p "$PORT:8000" -e "PUBLIC_ORIGIN=http://localhost:$PORT" \
  ${PRIVATE:-} --env-file /dev/stdin "$IMAGE" >/dev/null && echo "Running at http://localhost:$PORT  (stop with ./stop.sh)"
