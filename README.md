# OIP Lite

A standalone, minimal deployment of the [Open Index Protocol](https://oip.io) — everything you need to index, publish, and query OIP records without the AI/voice features.

## What It Does

- **Arweave indexing** — `keepDBUpToDate` continuously scrapes and indexes records, templates, creators, and organizations from the Arweave blockchain into Elasticsearch
- **Arweave publishing** — publish new records, templates, creators, and organizations to the Arweave blockchain (and instantly index them)
- **GUN publishing** — publish records to GUN for real-time peer sync
- **GUN cross-node sync** — pull OIP records from other GUN nodes specified in `.env`
- **Canonical template resolution** — resolves field type conflicts between template versions
- **dref resolution** — deep resolution of decentralized references (`did:arweave:...`) across records
- **File uploads** — local file upload support with web accessibility via `data/media/web/`
- **BitTorrent seeding** — uploaded media files are seeded via WebTorrent

## Interfaces

| Interface | URL | Purpose |
|-----------|-----|---------|
| Reference Client | `http://localhost:3005/reference-client.html` | Browse and publish OIP records |
| Creator Registration | `http://localhost:3005/register.html` | Register as an OIP creator (v0.9 DID) |
| Debug Interface | `http://localhost:3005/onion-press/debug.html` | Step through the OIP signing workflow |

## Quick Start

### Prerequisites
- [Docker](https://docs.docker.com/get-docker/) and Docker Compose
- An [Arweave wallet](https://arweave.app/) keyfile (for publishing)

### Setup

```bash
# 1. Clone and enter directory
git clone https://github.com/DevonJames/oip-lite.git
cd oip-lite

# 2. Configure environment
cp .env.example .env
# Edit .env — at minimum set:
#   JWT_SECRET          (any long random string)
#   ARWEAVE_KEY_FILE    (path to your Arweave wallet JSON)

# 3. Add your Arweave wallet
mkdir -p config
cp /path/to/your/wallet.json config/arweave-keyfile.json

# 4. Start
make up
```

The API will be available at `http://localhost:3005`.

### With Public Tunnel (Ngrok)

To expose your node publicly:

```bash
# In .env, set:
NGROK_AUTH_TOKEN=your_ngrok_auth_token
NGROK_DOMAIN=yournode.ngrok-free.app   # or your custom domain
PUBLIC_API_BASE_URL=https://yournode.ngrok-free.app

make up-ngrok
```

Ngrok dashboard: `http://localhost:4040`

## Make Commands

```
make up          Start all services
make up-ngrok    Start all services + ngrok tunnel
make down        Stop all services
make rebuild     Rebuild OIP image and restart
make logs        Follow all logs
make logs-oip    Follow OIP service logs
make shell       Open shell in OIP container
make status      Show service status
make test        Test service endpoints
make clean       Remove all containers and volumes (destructive)
make help        Show all commands
```

## API Endpoints

### Records
- `GET  /api/records` — query records with filtering, search, dref resolution
- `POST /api/records/newRecord` — publish a record to Arweave or GUN

### Templates
- `GET  /api/templates` — list all indexed templates
- `GET  /api/templates/:name` — get a template by name or txid

### Creators & Organizations
- `GET  /api/creators` — list creators
- `POST /api/publish/newCreator` — publish a creator record
- `GET  /api/organizations` — list organizations
- `POST /api/publish/newOrganization` — publish an organization record

### Publishing
- `POST /api/publish/newRecord` — generic record publishing (Arweave + GUN)
- `POST /api/publish/newTemplate` — publish a template

### Media
- `POST /api/media/upload` — upload a file (stored in `data/media/`)
- `GET  /media/:filename` — serve uploaded files

### Auth
- `POST /api/user/register` — register a user (HD wallet)
- `POST /api/user/login` — login and get JWT

### Health
- `GET  /health` — service health check
- `GET  /api/health/elasticsearch` — Elasticsearch status
- `GET  /api/health/gun-sync` — GUN sync status

## Configuration

See `.env.example` for all available options. Key settings:

| Variable | Default | Description |
|----------|---------|-------------|
| `JWT_SECRET` | (required) | Secret for JWT signing |
| `ARWEAVE_KEY_FILE` | `config/arweave-keyfile.json` | Arweave wallet path |
| `ARWEAVE_SYNC_ENABLED` | `true` | Enable blockchain indexing |
| `GUN_SYNC_ENABLED` | `false` | Enable cross-node GUN sync |
| `GUN_SYNC_TRUSTED_NODES` | (empty) | Comma-separated GUN node URLs to sync from |
| `RECORD_TYPE_INDEX_MODE` | `all` | `all`, `whitelist`, or `blacklist` |
| `PUBLIC_API_BASE_URL` | (empty) | Your public domain (used for media URLs) |
| `COMPOSE_PROJECT_NAME` | `oip-lite` | Docker namespace (change for multi-stack) |

## Directory Structure

```
oip-lite/
├── index.js              Entry point
├── package.json          Dependencies
├── Dockerfile            Container definition
├── docker-compose.yml    Service orchestration
├── Makefile              Management commands
├── .env.example          Environment template
├── config/               Templates, ES mappings, Arweave config
├── helpers/              Core logic (indexing, publishing, GUN, drefs)
├── routes/               API route handlers
├── middleware/           Auth, logging
├── services/             Media seeder (BitTorrent)
├── public/               HTML interfaces + CSS
├── remapTemplates/       Template field remapping rules
├── wallets/              Arweave wallet storage
└── data/media/           Uploaded file storage
```

## GUN Cross-Node Sync

To sync records from other OIP nodes:

```bash
# In .env:
GUN_SYNC_ENABLED=true
GUN_SYNC_TRUSTED_NODES=https://node1.oip.io/gun-relay,https://node2.oip.io/gun-relay
GUN_SYNC_INTERVAL=300000   # sync every 5 minutes
```

## Multi-Stack Deployment

Run multiple isolated OIP Lite instances on the same machine by changing port offsets and the project name:

```bash
# Second instance (.env):
COMPOSE_PROJECT_NAME=oip-lite-2
PORT=3105
ELASTICSEARCH_PORT=9300
KIBANA_PORT=5701
GUN_RELAY_PORT=8865
IPFS_API_PORT=5101
IPFS_GATEWAY_PORT=8180
NGROK_DASHBOARD_PORT=4140
```

## License

ISC
