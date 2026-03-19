# OIP Lite Technical Overview

## Introduction

OIP Lite is a standalone, reduced-scope OIP node focused on the core protocol and data stack:

- Arweave indexing and publishing
- Template-driven record encoding/decoding
- Elasticsearch-backed querying
- GUN publishing and optional cross-node sync
- Local media upload/serving with BitTorrent seeding
- JWT auth with HD-wallet user identity

It intentionally excludes native AI/voice features from the full stack. Compatibility proxy routes exist for those features, but in Lite they are pass-through integrations to external services, not built-in capabilities.

## System Scope

### Included in OIP Lite

- **Public blockchain indexing and publishing** on Arweave
- **Template + record model** for compact, structured data
- **dref relationships** and recursive record resolution
- **Search and filtering** through Elasticsearch
- **GUN relay integration** for private/p2p records
- **Optional GUN peer sync** between trusted nodes
- **Media pipeline** (upload, access control, HTTP streaming, torrent seeding)
- **User auth** with registration/login and JWT
- **Creator and organization publishing**
- **Debug/admin/health APIs** for operations

### Not Included as Native Lite Features

- Native ALFRED assistant workflows
- Native speech-to-text/text-to-speech pipelines
- Built-in LLM orchestration
- Full media/AI generation stack from Alexandria profile

## Core Architecture

### 1) Template-Record Data Model

OIP Lite uses the same schema-first OIP pattern:

1. Templates define fields, types, and index mappings (`index_<field>`)
2. Records are authored as readable JSON
3. Record payloads are translated into compact indexed format for publishing
4. Indexed data is expanded at read time for API consumers

This keeps storage efficient while preserving strongly structured data and interoperability.

### 2) Index + Query Layer (Elasticsearch)

Elasticsearch is the primary read/query engine in Lite:

- Stores indexed records, templates, creators, and organizations
- Supports filtering, searching, sorting, pagination, and type-specific retrieval
- Enables efficient expansion and lookup flows for API responses
- Supports template-aware record processing and dedupe behaviors

### 3) Blockchain + P2P Storage Layer

- **Arweave**: immutable public storage for templates/records
- **GUN relay**: p2p/private record transport, optional sync across nodes
- **IPFS service**: available in deployment topology; media workflows are primarily local + torrent + URL references in Lite routes

## Data Flows

### A) Arweave Indexing Flow

```
Arweave blocks -> keepDBUpToDate scanner -> template/record normalization ->
Elasticsearch indexing -> API query availability
```

Key behaviors in Lite:

- Startup environment validation and index initialization
- Continuous indexing loop (configurable delay/refresh interval)
- Optional local gateway/failover behavior for resilient fetches
- Record-type indexing controls (`all`, `whitelist`, `blacklist`)

### B) Record Publishing Flow

```
Client record JSON -> template lookup -> field/index translation ->
signature + OIP metadata -> Arweave publish (and/or GUN) -> immediate ES indexing
```

Supported outcomes:

- New record DID creation
- Optional media references in record payloads
- Immediate query visibility via index insertion

### C) Query and Resolution Flow

```
GET /api/records -> Elasticsearch retrieval -> optional dref expansion ->
response shaping -> client consumption
```

The records API supports broad filtering and can resolve decentralized references (`did:arweave:...`) recursively to return expanded graphs.

## Template Processing and Canonical Resolution

OIP Lite includes a canonical template resolver to prevent mapping breakage when historical template versions disagree on field types.

Behavior:

- Uses configured canonical template txids
- Compares incoming template field types against canonical definitions
- Applies canonical types for Elasticsearch mapping generation
- Falls back to Arweave fetch if canonical template is not yet indexed
- Caches canonical field maps for performance

This protects long-running indexing from early-template schema drift.

## dref (Decentralized Reference) Handling

Lite supports both:

- `dref` (single reference)
- `repeated dref` (array of references)

Resolution behavior:

- Existing DID references can be preserved as-is
- Nested object references can be transformed into published sub-records
- Recursive resolution can be requested at query time
- Some publishing flows resolve related records before final publish

## GUN Integration in Lite

### Local Relay + Proxy

- Includes a GUN relay service in deployment
- Exposes relay proxy endpoints in the API layer
- Can be disabled via environment toggle

### Cross-Node Sync (Optional)

When enabled:

- Discovers peer records (HTTP-first + websocket fallback)
- Filters configured record types for sync
- Handles private/public GUN records
- Processes deletion registry semantics
- Indexes synced records into Elasticsearch
- Tracks sync health metrics and exposes health endpoints

## Media Handling in Lite

### Upload and Storage

- `POST /api/media/upload` accepts authenticated uploads
- Files are stored under `data/media/<mediaId>/original`
- `mediaId` is content-addressed via SHA-256
- Upload writes a manifest with ownership and access settings

### Distribution

- Attempts WebTorrent seeding for uploaded files
- Returns magnet URI/infohash when available
- Falls back gracefully to HTTP-only access when torrent seeding is unavailable

### Access Control + Serving

- `GET /api/media/:mediaId` supports optional auth and private ownership checks
- Range requests and streaming are supported
- Media URL generation supports local and public-domain deployments

## Authentication and User Identity

Lite includes user registration/login and JWT auth, backed by Elasticsearch.

Identity model in Lite includes:

- Password-hashed user accounts
- HD wallet generation using BIP standards
- Per-user key material handling (encrypted at rest)
- Mnemonic/key workflows for wallet import/export paths
- Auth middleware for protected routes

## API Surface (Lite)

Core mounted route groups:

- `/api` (root/utilities and publish job status)
- `/api/records`
- `/api/publish`
- `/api/templates`
- `/api/creators`
- `/api/organizations`
- `/api/health`
- `/api/user`
- `/api/wallet`
- `/api/media`
- `/api/cleanup`
- `/api/admin`
- `/api/did`
- `/api/debug` and `/api/debug/v09`

Compatibility aliases also exist (for example direct `/api/register` and `/api/login` forwarding to user routes).

## Operational and Deployment Model

### Default Services

OIP Lite Docker deployment includes:

- `oip` (core API/node process)
- `elasticsearch`
- `kibana`
- `gun-relay`
- `ipfs`
- optional `ngrok` profile

### Multi-Stack Deployment

Lite supports running multiple isolated stacks on one machine by changing:

- `COMPOSE_PROJECT_NAME`
- API/service ports
- storage paths/volumes

This isolates container, network, and volume namespaces per stack.

### Health and Diagnostics

Lite provides:

- Basic service health endpoint
- Elasticsearch health checks
- GUN sync health and forced sync endpoint
- Memory health/tracker endpoints
- Request/memory tracking middleware in the API process

## Optional Compatibility Integrations

Lite includes optional proxy/bridge surfaces for neighboring stack components:

- **Alexandria proxy routes** (`/api/alfred`, `/api/voice`, etc.) for external services
- **Onion Press browse and WordPress bridge routes** when enabled

These are integration points, not native AI/voice implementations in Lite.

## Summary

OIP Lite is the protocol-first OIP node: indexing, publishing, schema management, search, media handling, and optional p2p sync, without bundling the full AI/voice platform.

It is suitable for teams that want:

- The OIP template/record protocol
- Arweave + Elasticsearch + GUN core functionality
- Lower operational complexity than the full stack
- A clean base for custom clients and domain-specific workflows
