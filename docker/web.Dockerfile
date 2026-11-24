FROM python:3.12-slim AS build
WORKDIR /src
COPY build_site.py index.html config.json ./
COPY shared ./shared
COPY assistant ./assistant
COPY datasets ./datasets
COPY assets ./assets
COPY data/facts.json ./data/facts.json
RUN python build_site.py

FROM nginx:alpine
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /src/site /usr/share/nginx/html
