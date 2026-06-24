# Space-Agent shell — the Node.js adaptive browser shell + API gateway.
#
# Stateless presentation/proxy tier: it serves the browser app and proxies to
# Benny (/api/runtime, /api/agent-runtime) and Memo-Ray (/api/memoray). The
# shell runs on Node built-ins (the root package.json declares no runtime deps),
# so there is nothing to `npm install` for production.
#
# Scope-binding credentials (BENNY_API_KEY, BENNY_AGENT_API_KEY) are REQUIRED at
# runtime — see ADR-003. With NODE_ENV=production the shell fails fast at startup
# if either is missing, so they must be injected (compose env / secrets), never
# baked into the image.
FROM node:20-slim

WORKDIR /app

COPY . .

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    CUSTOMWARE_PATH=/data/customware \
    RUNTIME_BASE_URL=http://benny:8005 \
    MEMORAY_BASE_URL=http://memoray:3030 \
    MEMORAY_ENABLED=true

EXPOSE 3000

# L2 user state lives here; back this with a shared/HA volume for multi-replica
# deployments (see ADR-003 residual gap + StorageProvider, server/lib/storage).
VOLUME ["/data/customware"]

CMD ["node", "space", "serve"]
