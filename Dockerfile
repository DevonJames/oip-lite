# ═══════════════════════════════════════════════════════════════════════════════
# OIP LITE - Dockerfile
# ═══════════════════════════════════════════════════════════════════════════════
# Core OIP infrastructure: indexing, publishing, GUN sync, media, dref resolution
# No AI/voice/ALFRED features (those live in the separate alexandria-service)
# ═══════════════════════════════════════════════════════════════════════════════

FROM node:18-alpine3.20

ENV NODE_ENV=production

WORKDIR /usr/src/app

# ─────────────────────────────────────────────────────────────────────────────
# System Dependencies
# ─────────────────────────────────────────────────────────────────────────────
RUN apk update && apk add --no-cache \
    bash \
    make \
    g++ \
    python3 \
    python3-dev \
    curl \
    cmake \
    openssl-dev \
    openssl-libs-static \
    libssl3 \
    libcrypto3 \
    libc6-compat \
    linux-headers \
    git \
    pkgconfig \
    ffmpeg

# ─────────────────────────────────────────────────────────────────────────────
# Sharp dependencies (thumbnail generation during media upload)
# ─────────────────────────────────────────────────────────────────────────────
RUN apk add --no-cache \
    vips-dev \
    fftw-dev

# ─────────────────────────────────────────────────────────────────────────────
# OpenSSL Configuration (required for crypto operations)
# ─────────────────────────────────────────────────────────────────────────────
ENV OPENSSL_ROOT_DIR=/usr
ENV OPENSSL_INCLUDE_DIR=/usr/include/openssl
ENV OPENSSL_CRYPTO_LIBRARY=/usr/lib/libcrypto.so.3
ENV OPENSSL_SSL_LIBRARY=/usr/lib/libssl.so.3
ENV PKG_CONFIG_PATH=/usr/lib/pkgconfig

# ─────────────────────────────────────────────────────────────────────────────
# Node.js Dependencies
# ─────────────────────────────────────────────────────────────────────────────
COPY package.json ./package.json
COPY package-lock.json ./package-lock.json

RUN echo "python=/usr/bin/python3" > .npmrc

RUN npm install --omit=optional --verbose

RUN npm rebuild bcrypt sharp 2>/dev/null || true

# ─────────────────────────────────────────────────────────────────────────────
# Application Code
# ─────────────────────────────────────────────────────────────────────────────
COPY config ./config
COPY remapTemplates ./remapTemplates
COPY helpers ./helpers
COPY routes ./routes
COPY services ./services
COPY middleware ./middleware
COPY socket ./socket
COPY public ./public
COPY index.js ./index.js
COPY gun-relay-server.js ./gun-relay-server.js
COPY socket.js ./socket.js
COPY wait-for-it.sh ./wait-for-it.sh
RUN sed -i 's/\r$//' wait-for-it.sh && chmod +x wait-for-it.sh

COPY scripts/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

COPY scripts ./scripts

# ─────────────────────────────────────────────────────────────────────────────
# Directory Structure
# ─────────────────────────────────────────────────────────────────────────────
RUN mkdir -p \
    ./data/media \
    ./data/media/web \
    ./data/media/temp \
    ./wallets

# ─────────────────────────────────────────────────────────────────────────────
# Memory Configuration
# ─────────────────────────────────────────────────────────────────────────────
ENV NODE_OPTIONS="--max-old-space-size=4096"

# ─────────────────────────────────────────────────────────────────────────────
# Expose Ports
# ─────────────────────────────────────────────────────────────────────────────
EXPOSE 3005

# ─────────────────────────────────────────────────────────────────────────────
# Health Check
# ─────────────────────────────────────────────────────────────────────────────
HEALTHCHECK --interval=60s --timeout=10s --start-period=30s --retries=3 \
    CMD sh -c 'curl -f http://localhost:${PORT:-3005}/health || exit 1'

# ─────────────────────────────────────────────────────────────────────────────
# Startup
# ─────────────────────────────────────────────────────────────────────────────
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "--expose-gc", "--optimize-for-size", "index.js", "--keepDBUpToDate", "15", "600"]
