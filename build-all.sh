#!/bin/sh
# Build every image for Intel/AMD (amd64) and ARM (arm64).
#   ./build-all.sh                       build both platforms
#   REGISTRY=ghcr.io/you ./build-all.sh  also push the multi-arch images
cd "$(dirname "$0")"
P=linux/amd64,linux/arm64
R=${REGISTRY:+$REGISTRY/}
docker buildx create --use --name ccfd1 >/dev/null 2>&1 || docker buildx use ccfd1
for name in web assistant; do
  if [ -n "$REGISTRY" ]; then
    docker buildx build --platform $P -f docker/$name.Dockerfile -t ${R}ccfd1-$name:latest --push .
  else
    docker buildx build --platform $P -f docker/$name.Dockerfile -t ccfd1-$name:latest .
  fi
done
