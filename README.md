# WhatsApp Bot — NestJS

Bot de WhatsApp con OpenAI Responses API para clasificados de El Deber.

## Variables de entorno

Crea un archivo `.env` en la raíz del proyecto:

```env
# Meta WhatsApp
ACCESS_TOKEN=
APP_ID=
APP_SECRET=
VERSION=v25.0
PHONE_NUMBER_ID=
VERIFY_TOKEN=

# OpenAI
OPENAI_API_KEY=
OPENAI_MODEL=gpt-4o-mini

# Servidor
PORT=8000
```

## Endpoints

| Método | Ruta | Descripción |
|--------|------|-------------|
| GET | `/` | Health check |
| GET | `/health` | Health check |
| GET | `/webhook` | Verificación de webhook Meta |
| POST | `/webhook` | Recibir mensajes WhatsApp |

## Comandos

```bash
# Desarrollo
npm run start:dev

# Producción
npm run build
npm run start:prod
```

## Dokploy

- **Puerto**: 8000
- **Comando de inicio**: `node dist/main`
- **Build**: `npm run build`
