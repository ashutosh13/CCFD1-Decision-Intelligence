FROM node:22-slim
WORKDIR /app
COPY worker/package.json worker/package-lock.json ./worker/
RUN cd worker && npm ci --omit=dev --ignore-scripts
COPY worker/src ./worker/src
COPY shared ./shared
COPY docker/assistant-server.mjs ./docker/
CMD ["node", "docker/assistant-server.mjs"]
