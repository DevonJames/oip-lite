# ═══════════════════════════════════════════════════════════════════════════════
# OIP LITE - Makefile
# ═══════════════════════════════════════════════════════════════════════════════

.PHONY: up down rebuild logs logs-oip logs-gun logs-es shell status test clean help \
        up-ngrok down-ngrok

GREEN  := \033[0;32m
YELLOW := \033[1;33m
BLUE   := \033[0;34m
RED    := \033[0;31m
NC     := \033[0m

# ═══════════════════════════════════════════════════════════════════════════════
# PRIMARY TARGETS
# ═══════════════════════════════════════════════════════════════════════════════

up: ## Start all services (elasticsearch, kibana, gun-relay, ipfs, oip)
	@echo "$(BLUE)Starting OIP Lite...$(NC)"
	docker compose --env-file .env up -d
	@echo ""
	@echo "$(GREEN)✅ OIP Lite is running$(NC)"
	@echo "  • OIP API:       http://localhost:$${PORT:-3005}"
	@echo "  • Kibana:        http://localhost:$${KIBANA_PORT:-5601}"
	@echo "  • GUN Relay:     http://localhost:$${GUN_RELAY_PORT:-8765}"
	@echo "  • IPFS API:      http://localhost:$${IPFS_API_PORT:-5001}"
	@echo ""
	@echo "$(YELLOW)Run 'make logs' to follow logs$(NC)"

up-ngrok: ## Start all services + ngrok tunnel (requires NGROK_AUTH_TOKEN and NGROK_DOMAIN in .env)
	@echo "$(BLUE)Starting OIP Lite with Ngrok tunnel...$(NC)"
	docker compose --env-file .env --profile ngrok up -d
	@echo ""
	@echo "$(GREEN)✅ OIP Lite + Ngrok running$(NC)"
	@echo "  • OIP API:       http://localhost:$${PORT:-3005}"
	@echo "  • Ngrok Dashboard: http://localhost:$${NGROK_DASHBOARD_PORT:-4040}"
	@echo "  • Public URL:    https://$${NGROK_DOMAIN:-<random>}.ngrok-free.app"

down: ## Stop all services
	@echo "$(BLUE)Stopping OIP Lite...$(NC)"
	docker compose --env-file .env --profile ngrok down
	@echo "$(GREEN)✅ Services stopped$(NC)"

rebuild: ## Rebuild OIP image and restart (--no-cache)
	@echo "$(BLUE)Rebuilding OIP Lite...$(NC)"
	docker compose --env-file .env build --no-cache oip
	docker compose --env-file .env up -d
	@echo "$(GREEN)✅ OIP Lite rebuilt and restarted$(NC)"

# ═══════════════════════════════════════════════════════════════════════════════
# LOGS
# ═══════════════════════════════════════════════════════════════════════════════

logs: ## Follow all logs
	docker compose --env-file .env logs -f

logs-oip: ## Follow oip service logs
	docker compose --env-file .env logs -f oip

logs-gun: ## Follow gun-relay logs
	docker compose --env-file .env logs -f gun-relay

logs-es: ## Follow elasticsearch logs
	docker compose --env-file .env logs -f elasticsearch

# ═══════════════════════════════════════════════════════════════════════════════
# SERVICE MANAGEMENT
# ═══════════════════════════════════════════════════════════════════════════════

restart: ## Restart the oip service
	@echo "$(BLUE)Restarting OIP...$(NC)"
	docker compose --env-file .env restart oip
	@echo "$(GREEN)✅ OIP restarted$(NC)"

shell: ## Open shell in oip container
	docker compose --env-file .env exec oip /bin/sh

shell-es: ## Open shell in elasticsearch container
	docker compose --env-file .env exec elasticsearch /bin/bash

status: ## Show service status
	@echo "$(BLUE)OIP Lite Status:$(NC)"
	docker compose --env-file .env ps

# ═══════════════════════════════════════════════════════════════════════════════
# TESTING
# ═══════════════════════════════════════════════════════════════════════════════

test: ## Test all service endpoints
	@echo "$(BLUE)Testing OIP Lite services...$(NC)"
	@echo ""
	@echo "Health check..."
	@curl -s http://localhost:$${PORT:-3005}/health | python3 -m json.tool 2>/dev/null || echo "$(RED)Health check failed$(NC)"
	@echo ""
	@echo "Records endpoint..."
	@curl -s "http://localhost:$${PORT:-3005}/api/records?limit=1" | python3 -m json.tool 2>/dev/null | head -5 || echo "$(RED)Records endpoint failed$(NC)"
	@echo ""
	@echo "Elasticsearch direct..."
	@curl -s http://localhost:$${ELASTICSEARCH_PORT:-9200}/_cluster/health | python3 -m json.tool 2>/dev/null || echo "$(RED)Elasticsearch not reachable$(NC)"
	@echo ""
	@echo "$(GREEN)✅ Tests complete$(NC)"

# ═══════════════════════════════════════════════════════════════════════════════
# CLEANUP
# ═══════════════════════════════════════════════════════════════════════════════

clean: ## Remove all containers and volumes (WARNING: destroys indexed data)
	@echo "$(RED)⚠️  This will remove all containers and volumes including indexed Arweave data$(NC)"
	@read -p "Are you sure? [y/N] " confirm && [ "$$confirm" = "y" ] || exit 1
	docker compose --env-file .env --profile ngrok down -v --remove-orphans
	@echo "$(GREEN)✅ Cleanup complete$(NC)"

# ═══════════════════════════════════════════════════════════════════════════════
# HELP
# ═══════════════════════════════════════════════════════════════════════════════

help: ## Show this help
	@echo "$(BLUE)═══════════════════════════════════════════════════════════$(NC)"
	@echo "$(BLUE)  OIP LITE$(NC)"
	@echo "$(BLUE)═══════════════════════════════════════════════════════════$(NC)"
	@echo ""
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  $(GREEN)%-20s$(NC) %s\n", $$1, $$2}'
	@echo ""
	@echo "$(YELLOW)First time setup:$(NC)"
	@echo "  cp .env.example .env"
	@echo "  # Edit .env: set JWT_SECRET, ARWEAVE_KEY_FILE, etc."
	@echo "  make up"

.DEFAULT_GOAL := help
