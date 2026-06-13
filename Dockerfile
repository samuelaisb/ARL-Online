# Multi-stage production image for ARL Online (Vite build + Express API).

FROM node:22-alpine AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY index.html vite.config.js svelte.config.js ./
COPY public ./public
COPY locales ./locales
COPY content ./content
COPY src ./src
COPY scripts ./scripts

# Baked into the client bundle at build time (Vite envPrefix: SUPABASE_, VITE_, SITE_).
# Runtime /config.js also serves these from Cloud Run env — build args are a fallback.
ARG SUPABASE_URL=
ARG SUPABASE_API=
ARG VITE_SUPABASE_URL=
ARG VITE_SUPABASE_ANON_KEY=
ARG SITE_URL=
ARG VITE_SITE_URL=
ENV SUPABASE_URL=${SUPABASE_URL} \
    SUPABASE_API=${SUPABASE_API} \
    VITE_SUPABASE_URL=${VITE_SUPABASE_URL} \
    VITE_SUPABASE_ANON_KEY=${VITE_SUPABASE_ANON_KEY} \
    SITE_URL=${SITE_URL} \
    VITE_SITE_URL=${VITE_SITE_URL}

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
