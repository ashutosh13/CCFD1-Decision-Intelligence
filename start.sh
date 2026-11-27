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
# Auto-detect the Anthropic key. If it is missing or rejected, ask for a valid one (Enter skips the assistant).
key_ok() {  # 0 = valid, 1 = rejected by Anthropic, 2 = could not check (offline), so accept it
  case "$1" in sk-ant-*) ;; *) return 1 ;; esac
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 https://api.anthropic.com/v1/models \
    -H "x-api-key: $1" -H "anthropic-version: 2023-06-01") || return 2
  case "$code" in 200) return 0 ;; 401|403) return 1 ;; *) return 2 ;; esac
}
current=$(grep '^ANTHROPIC_API_KEY=' .env 2>/dev/null | tail -1 | cut -d= -f2-)
need_key=1
if [ -n "$current" ]; then key_ok "$current"; [ $? -ne 1 ] && need_key=0 || echo "The saved Anthropic API key was rejected."; fi
if [ "$need_key" = 1 ]; then
  tries=0
  while [ $tries -lt 3 ]; do
    printf 'Paste your Anthropic API key (or press Enter to skip the assistant): '
    read -r key
    [ -z "$key" ] && break
    key_ok "$key"; rc=$?
    if [ $rc -ne 1 ]; then
      [ -f .env ] && grep -v '^ANTHROPIC_API_KEY=' .env > .env.tmp; mv .env.tmp .env 2>/dev/null
      echo "ANTHROPIC_API_KEY=$key" >> .env
      [ $rc -eq 2 ] && echo "Could not reach Anthropic to check it; saved anyway."
      break
    fi
    echo "That key was not accepted. It should start with sk-ant- and be active."
    tries=$((tries + 1))
  done
fi
if [ -f ccfd1-image.tar ]; then docker load -i ccfd1-image.tar        # offline copy, if you were given one
elif [ "$1" != "--dev" ]; then docker pull "$IMAGE"; fi
docker rm -f ccfd1 >/dev/null 2>&1
# Private incident rows (if this machine has them) are mounted read-only, never copied into the image.
[ -d datasets.private ] && PRIVATE="-v $PWD/datasets.private:/private:ro"
# Only the API key goes into the container, not the other .env values.
grep '^ANTHROPIC_API_KEY=' .env | docker run -d --name ccfd1 -p "$PORT:8000" -e "PUBLIC_ORIGIN=http://localhost:$PORT" \
  ${PRIVATE:-} --env-file /dev/stdin "$IMAGE" >/dev/null && echo "Running at http://localhost:$PORT  (stop with ./stop.sh)"
