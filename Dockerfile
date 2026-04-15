# syntax=docker/dockerfile:1

FROM node:20-alpine AS builder
WORKDIR /app

COPY package.json package-lock.json tsconfig.json ./
RUN npm ci --ignore-scripts

COPY src ./src
RUN npm run build

FROM node:20-alpine
WORKDIR /app

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package.json ./package.json

RUN mkdir -p /fixture/src && \
    printf 'module.exports = {\n  sources: { codebase: { root: "./src", patterns: ["**/*.ts"], ignore: [] } },\n  governance: { sourceOfTruth: "codebase", onConflict: "warn" },\n  output: { path: "./primitiv.contract.json" }\n}\n' > /fixture/primitiv.config.js

WORKDIR /fixture
RUN node /app/dist/cli.js build /fixture/primitiv.config.js || true

CMD ["node", "/app/dist/cli.js", "serve", "/fixture/primitiv.config.js"]
