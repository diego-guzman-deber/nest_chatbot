# ─────────────────────────────────────────────
# Stage 1: Builder
# ─────────────────────────────────────────────
FROM node:22-alpine AS builder

WORKDIR /app

# Copiar manifiestos primero para aprovechar el cache de capas
COPY package*.json ./
COPY nest-cli.json ./
COPY tsconfig*.json ./

# Instalar TODAS las dependencias (incluyendo devDependencies para compilar)
RUN npm ci

# Copiar el código fuente
COPY src/ ./src/

# Compilar el proyecto TypeScript -> dist/
RUN npm run build

# ─────────────────────────────────────────────
# Stage 2: Production
# ─────────────────────────────────────────────
FROM node:22-alpine AS production

# Metadatos
LABEL maintainer="chatbot-whatsapp"
LABEL description="WhatsApp Chatbot NestJS"

WORKDIR /app

# Copiar manifiestos de dependencias
COPY package*.json ./

# Instalar SOLO dependencias de producción
RUN npm ci --omit=dev && npm cache clean --force

# Copiar el build generado en la etapa anterior
COPY --from=builder /app/dist ./dist

# Exponer el puerto que usa la app (ver main.ts: PORT ?? 8000)
EXPOSE 8000

# Usuario no-root por seguridad
USER node

# Comando de inicio en producción
CMD ["node", "dist/main"]
