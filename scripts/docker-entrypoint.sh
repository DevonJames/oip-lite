#!/bin/bash
# ═══════════════════════════════════════════════════════════════════════════════
# OIP DAEMON SERVICE - Docker Entrypoint
# ═══════════════════════════════════════════════════════════════════════════════

set -e

echo "═══════════════════════════════════════════════════════════════"
echo "  OIP DAEMON SERVICE - Starting"
echo "═══════════════════════════════════════════════════════════════"
echo ""

# Wait for Elasticsearch to be ready
if [ -n "$ELASTICSEARCH_HOST" ]; then
    echo "⏳ Waiting for Elasticsearch at ${ELASTICSEARCH_HOST}:${ELASTICSEARCH_PORT:-9200}..."
    ./wait-for-it.sh "${ELASTICSEARCH_HOST}:${ELASTICSEARCH_PORT:-9200}" -t 120 -- echo "✅ Elasticsearch is ready"
fi

# Wait for GUN relay to be ready (only if GUN sync is enabled)
# Note: Some profiles (like onion-press-server) don't include gun-relay service
# so we check if GUN sync is enabled AND if the service is actually available
if [ "${GUN_SYNC_ENABLED:-true}" = "false" ]; then
    echo "⏭️  Skipping GUN relay wait (GUN_SYNC_ENABLED=false)"
elif [ -n "$GUN_PEERS" ]; then
    GUN_HOST=$(echo $GUN_PEERS | sed 's|http://||' | sed 's|/gun||' | cut -d: -f1)
    GUN_PORT=$(echo $GUN_PEERS | sed 's|http://||' | sed 's|/gun||' | cut -d: -f2)
    if [ -n "$GUN_HOST" ] && [ -n "$GUN_PORT" ]; then
        echo "⏳ Waiting for GUN relay at ${GUN_HOST}:${GUN_PORT}..."
        # wait-for-it.sh returns 0 on success, non-zero on timeout/failure
        # Suppress stderr to avoid "bad address" errors when service doesn't exist
        if ./wait-for-it.sh "${GUN_HOST}:${GUN_PORT}" -t 10 -- echo "✅ GUN relay is ready" 2>/dev/null; then
            : # Success - message already printed by wait-for-it.sh
        else
            echo "⚠️  GUN relay not available (service not in this profile or not running)"
            echo "   Continuing anyway - GUN sync will be disabled"
        fi
    fi
fi

# Ensure data directories exist with correct permissions
echo "📁 Ensuring data directories..."
mkdir -p ./data/media/web ./data/media/temp ./wallets

# Set up node_modules if they were moved during build
if [ -d "../node_modules" ] && [ ! -d "./node_modules" ]; then
    echo "🔗 Linking node_modules..."
    ln -s ../node_modules ./node_modules
fi

# Environment info
echo ""
echo "📋 Environment:"
echo "   PORT: ${PORT:-3005}"
echo "   NODE_ENV: ${NODE_ENV:-development}"
echo "   ELASTICSEARCH: ${ELASTICSEARCH_HOST:-localhost}:${ELASTICSEARCH_PORT:-9200}"
echo "   GUN_PEERS: ${GUN_PEERS:-not set}"
echo "   GUN_SYNC: ${GUN_SYNC_ENABLED:-true}"
echo "   ARWEAVE_SYNC: ${ARWEAVE_SYNC_ENABLED:-true}"
echo ""

# Memory settings
export NODE_OPTIONS="${NODE_OPTIONS:---expose-gc --max-old-space-size=4096}"
echo "💾 Memory: NODE_OPTIONS=$NODE_OPTIONS"
echo ""

# Start the daemon
echo "🚀 Starting OIP Daemon Service..."

# Check if Arweave syncing is disabled
if [ "${ARWEAVE_SYNC_ENABLED:-true}" = "false" ]; then
    echo "⚠️  Arweave syncing is DISABLED (ARWEAVE_SYNC_ENABLED=false)"
    echo "   Running in web server + login service mode only"
    echo "   No blockchain indexing will occur"
    # Override CMD to remove --keepDBUpToDate flag
    # Replace the command arguments, removing --keepDBUpToDate and its parameters
    NEW_CMD=()
    SKIP_NEXT=0
    for arg in "$@"; do
        if [ "$SKIP_NEXT" -eq 1 ]; then
            SKIP_NEXT=0
            continue
        fi
        if [ "$arg" = "--keepDBUpToDate" ]; then
            # Skip this flag and the next two arguments (delay and interval)
            SKIP_NEXT=2
            continue
        fi
        NEW_CMD+=("$arg")
    done
    exec "${NEW_CMD[@]}"
else
    echo "✅ Arweave syncing is ENABLED (default)"
    exec "$@"
fi

