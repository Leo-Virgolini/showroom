# syntax=docker/dockerfile:1.7

# ============================================================
# Build stage: build de Angular en producción (genera SW)
# ============================================================
FROM node:22-alpine AS build
WORKDIR /build

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

# ============================================================
# Runtime stage: nginx sirve los estáticos + proxy a /api
# ============================================================
FROM nginx:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /build/dist/showroom-frontend/browser /usr/share/nginx/html

EXPOSE 80
