# syntax=docker/dockerfile:1
FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/build ./build

RUN addgroup -S app && adduser -S app -G app
USER app

# Bloxity Legion injects PORT; @colyseus/tools listen() binds to it (falls back to 2567).
EXPOSE 2567
CMD ["node", "build/index.js"]
