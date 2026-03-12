#!/bin/bash

# OIP GUN Sync Setup Script
# Configures and initializes the GUN record synchronization system

set -e

echo "🚀 OIP GUN Sync Setup"
echo "===================="

# Check if .env exists
if [ ! -f ".env" ]; then
    echo "📝 Creating .env from example..."
    cp "example env" .env
    echo "✅ Created .env file"
else
    echo "✅ .env file already exists"
fi

# Check required environment variables
echo ""
echo "🔧 Checking GUN sync configuration..."

check_env_var() {
    local var_name=$1
    local default_value=$2
    
    if grep -q "^${var_name}=" .env; then
        local current_value=$(grep "^${var_name}=" .env | cut -d'=' -f2)
        echo "✅ ${var_name}=${current_value}"
    else
        echo "⚠️  ${var_name} not found, adding default..."
        echo "${var_name}=${default_value}" >> .env
        echo "✅ Added ${var_name}=${default_value}"
    fi
}

# Ensure sync configuration exists
check_env_var "GUN_SYNC_ENABLED" "true"
check_env_var "GUN_SYNC_INTERVAL" "30000"
check_env_var "GUN_REGISTRY_ROOT" "oip:registry"
check_env_var "GUN_SYNC_PRIVATE_RECORDS" "true"

# Prompt for node ID
echo ""
read -p "🏷️  Enter a unique node ID (or press Enter for auto-generated): " node_id
if [ ! -z "$node_id" ]; then
    if grep -q "^GUN_NODE_ID_OVERRIDE=" .env; then
        sed -i.bak "s/^GUN_NODE_ID_OVERRIDE=.*/GUN_NODE_ID_OVERRIDE=${node_id}/" .env
    else
        echo "GUN_NODE_ID_OVERRIDE=${node_id}" >> .env
    fi
    echo "✅ Set node ID: ${node_id}"
fi

# Prompt for external peers
echo ""
read -p "🌐 Enter external GUN peers (comma-separated, or press Enter to skip): " external_peers
if [ ! -z "$external_peers" ]; then
    if grep -q "^GUN_EXTERNAL_PEERS=" .env; then
        sed -i.bak "s/^GUN_EXTERNAL_PEERS=.*/GUN_EXTERNAL_PEERS=${external_peers}/" .env
    else
        echo "GUN_EXTERNAL_PEERS=${external_peers}" >> .env
    fi
    echo "✅ Set external peers: ${external_peers}"
fi

# Start services
echo ""
echo "🐳 Starting Docker services..."
docker-compose --profile standard up -d

# Wait for services to be ready
echo ""
echo "⏳ Waiting for services to start..."
sleep 10

# Check service health
echo ""
echo "🏥 Checking service health..."

# Check main API
if curl -s http://localhost:3005/api/health >/dev/null; then
    echo "✅ Main API is healthy"
else
    echo "❌ Main API is not responding"
fi

# Check Elasticsearch
if curl -s http://localhost:9200/_cluster/health >/dev/null; then
    echo "✅ Elasticsearch is healthy"
else
    echo "❌ Elasticsearch is not responding"
fi

# Check GUN relay
if curl -s http://localhost:8765 >/dev/null; then
    echo "✅ GUN relay is accessible"
else
    echo "❌ GUN relay is not responding"
fi

# Wait a bit more for sync service to initialize
sleep 5

# Check GUN sync service
echo ""
echo "🔄 Checking GUN sync service..."
if curl -s http://localhost:3005/api/health/gun-sync >/dev/null; then
    echo "✅ GUN sync service is running"
    
    # Show sync status
    echo ""
    echo "📊 Sync Service Status:"
    curl -s http://localhost:3005/api/health/gun-sync | jq '.' 2>/dev/null || curl -s http://localhost:3005/api/health/gun-sync
else
    echo "❌ GUN sync service is not responding"
fi

# Offer to run migration
echo ""
read -p "🔄 Run migration of existing GUN records? (y/N): " run_migration
if [[ $run_migration =~ ^[Yy]$ ]]; then
    echo "🔄 Running migration (dry run first)..."
    node scripts/migrate-existing-gun-records.js --dry-run
    
    echo ""
    read -p "📝 Proceed with actual migration? (y/N): " proceed_migration
    if [[ $proceed_migration =~ ^[Yy]$ ]]; then
        echo "🔄 Running actual migration..."
        node scripts/migrate-existing-gun-records.js
        echo "✅ Migration completed!"
    else
        echo "⏭️ Migration skipped"
    fi
fi

echo ""
echo "🎉 GUN Sync Setup Complete!"
echo ""
echo "📋 Next Steps:"
echo "  1. Check sync status: curl http://localhost:3005/api/health/gun-sync"
echo "  2. Force sync cycle: curl -X POST http://localhost:3005/api/health/gun-sync/force"
echo "  3. Monitor logs: docker-compose logs -f oip | grep SYNC"
echo "  4. Test publishing: Use /api/records/newRecord?storage=gun"
echo ""
echo "📚 Documentation:"
echo "  - Full deployment guide: docs/GUN_SYNC_DEPLOYMENT_GUIDE.md"
echo "  - Technical details: docs/toBuild/PRIVATE_GUN_RECORD_SYNCING_BETWEEN_OIP_NODES.md"
echo ""
