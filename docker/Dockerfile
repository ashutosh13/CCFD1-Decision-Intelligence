FROM python:3.12-slim AS site
WORKDIR /src
COPY build_site.py index.html config.json ./
COPY shared ./shared
COPY assistant ./assistant
COPY datasets ./datasets
COPY assets ./assets
COPY data/facts.json ./data/facts.json
RUN python build_site.py

FROM node:22-slim
WORKDIR /app
COPY worker/package.json worker/package-lock.json ./worker/
RUN cd worker && npm ci --omit=dev --ignore-scripts
COPY worker/src ./worker/src
COPY shared ./shared
COPY docker/server.mjs ./docker/
COPY --from=site /src/site ./site
USER node
EXPOSE 8000
CMD ["node", "docker/server.mjs"]
