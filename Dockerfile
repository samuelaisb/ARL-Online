# Multi-stage production image for ARL Online (Vite build + Express API).

FROM node:22-alpine AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY index.html vite.config.js svelte.config.js ./
COPY public ./public
COPY locales ./locales
COPY src ./src

# Baked into the client bundle at build time (Vite envPrefix: SUPABASE_, VITE_, SITE_).
ARG SUPABASE_URL=
ARG SUPABASE_API=
ARG SITE_URL=
ENV SUPABASE_URL=${SUPABASE_URL} \
    SUPABASE_API=${SUPABASE_API} \
    SITE_URL=${SITE_URL}

RUN npm run build

FROM node:22-alpine AS production

WORKDIR /app

ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server.js ./
COPY --from=build /app/dist ./dist
COPY src/lib ./src/lib
COPY src/assets ./src/assets

RUN chown -R node:node /app

USER node

EXPOSE 8080

CMD ["node", "server.js"]
