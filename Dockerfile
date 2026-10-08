# decidus serve, to run your own. The hosted version is at decidus.ai.
#   docker build -t decidus . && docker run -p 7700:7700 -v decidus:/data -e DECIDUS_API_KEY=... -e OPENAI_API_KEY=... decidus
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci --ignore-scripts
COPY src ./src
RUN npm run build

# no runtime dependencies: the server is node:http + node:sqlite
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=7700 DECIDUS_DB=/data/decidus.db
COPY package.json ./
COPY ui ./ui
COPY --from=build /app/dist ./dist
RUN mkdir /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 7700
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:7700/healthz || exit 1
CMD ["node", "dist/cli.js", "serve"]
