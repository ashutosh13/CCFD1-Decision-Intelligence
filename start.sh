#!/bin/sh
# Build and run the dashboard on this machine. Opens at http://localhost:8000
cd "$(dirname "$0")"
if ! grep -q '^ANTHROPIC_API_KEY=.' .env 2>/dev/null; then
  printf 'Paste your Anthropic API key (or press Enter to skip the assistant): '
  read -r key
  [ -n "$key" ] && echo "ANTHROPIC_API_KEY=$key" >> .env
fi
docker compose up -d --build && echo "Running at http://localhost:${PORT:-8000}"
