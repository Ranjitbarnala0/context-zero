# ContextZero

**Code cognition and change orchestration engine.**

ContextZero builds a deep, versioned understanding of codebases — symbols, relations, behavioral fingerprints, contracts, invariants, and homolog relationships — then uses that understanding to power safe, validated code changes.

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    API Interface (REST)                   │
│              22 endpoints · auth · rate limiting          │
├────────────┬────────────┬────────────┬──────────────────┤
│  Ingestor  │  Analysis  │  Homolog   │  Transactional   │
│  Pipeline  │  Engines   │  Inference │  Change Engine   │
├────────────┼────────────┼────────────┼──────────────────┤
│            │ Structural │ 7-dim      │ 9-state          │
│ TS Adapter │ Behavioral │ Weighted   │ Lifecycle        │
│ PY Adapter │ Contract   │ Scoring    │ 6-level          │
│            │ Blast Rad. │            │ Validation       │
│            │ Capsule    │            │ Sandbox          │
│            │ Uncertainty│            │                  │
├────────────┴────────────┴────────────┴──────────────────┤
│              PostgreSQL (pg_trgm · UUID · JSONB)         │
└─────────────────────────────────────────────────────────┘
```

### Core Subsystems

| Subsystem | Purpose |
|---|---|
| **Symbol Spine** | Versioned code symbols extracted via AST (TypeScript Compiler API, Python LibCST) |
| **Behavioral Engine** | Purity classification (`pure` → `read_only` → `read_write` → `side_effecting`), resource tracking |
| **Contract Engine** | Input/output/error contracts, security contracts, invariant mining from tests |
| **Homolog Engine** | 7-dimension weighted scoring for detecting parallel logic across a codebase |
| **Blast Radius** | 5-dimensional impact analysis (structural, behavioral, contract, homolog, historical) |
| **Capsule Compiler** | Token-budgeted minimal context packages (minimal/standard/strict modes) |
| **Transactional Editor** | 9-state lifecycle with 6-level progressive validation and sandboxed execution |

---

## Quick Start

### Prerequisites

- **Node.js** >= 20.0.0
- **PostgreSQL** >= 14 (with `pg_trgm` extension)
- **Python 3** (optional, for Python file analysis)

### Option 1: Docker (Recommended)

```bash
git clone <repo-url> contextzero
cd contextzero

# Set your API key
echo "SCG_API_KEYS=your-secret-key" > .env

# Start PostgreSQL + ContextZero server
docker compose up -d

# Verify
curl -H "X-API-Key: your-secret-key" http://localhost:3100/health
```

### Option 2: Local Development

```bash
git clone <repo-url> contextzero
cd contextzero

npm install

cp .env.example .env
# Edit .env with your database credentials and API key

createdb scg_v2
npm run db:migrate

npm run dev
```

---

## Configuration

All configuration is via environment variables (see `.env.example`):

| Variable | Default | Description |
|---|---|---|
| `DB_HOST` | `localhost` | PostgreSQL host |
| `DB_PORT` | `5432` | PostgreSQL port |
| `DB_NAME` | `scg_v2` | Database name |
| `DB_USER` | `postgres` | Database user |
| `DB_PASSWORD` | `postgres` | Database password |
| `DB_MAX_CONNECTIONS` | `20` | Connection pool size |
| `SCG_PORT` | `3100` | HTTP server port |
| `SCG_API_KEYS` | *(none)* | Comma-separated API keys. **If empty, all requests are rejected.** |
| `LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` / `fatal` |

---

## API Reference

All endpoints accept `POST` with JSON body. Authenticate with `Authorization: Bearer <key>` or `X-API-Key: <key>`.

### Core Query Tools

| Endpoint | Description |
|---|---|
| `POST /scg_resolve_symbol` | Fuzzy symbol search by name (pg_trgm) |
| `POST /scg_get_symbol_details` | Symbol details with `view_mode` (code/summary/signature) |
| `POST /scg_get_symbol_relations` | Structural relations (callers, callees, imports) |
| `POST /scg_get_behavioral_profile` | Purity class, resource touches, side effects |
| `POST /scg_get_contract_profile` | Input/output/error/security contracts |
| `POST /scg_get_invariants` | Invariants scoped to a symbol |
| `POST /scg_get_uncertainty` | Uncertainty report for a snapshot |

### Analysis Tools

| Endpoint | Description |
|---|---|
| `POST /scg_find_homologs` | Find parallel logic (7-dimension scoring) |
| `POST /scg_blast_radius` | 5-dimensional impact analysis with `depth` |
| `POST /scg_compile_context_capsule` | Token-budgeted context with `mode` and `token_budget` |

### Change Management Tools

| Endpoint | Description |
|---|---|
| `POST /scg_create_change_transaction` | Create transaction with `task_description` |
| `POST /scg_apply_patch` | Apply file patches |
| `POST /scg_validate_change` | 6-level progressive validation (`quick`/`standard`/`strict`) |
| `POST /scg_commit_change` | Commit validated transaction |
| `POST /scg_rollback_change` | Rollback with file restoration |
| `POST /scg_propagation_proposals` | Homolog co-change proposals |
| `POST /scg_get_transaction` | Transaction status |

### Ingestion

| Endpoint | Description |
|---|---|
| `POST /scg_ingest_repo` | Full codebase ingestion |

### Utility

| Endpoint | Description |
|---|---|
| `POST /scg_list_repos` | List repositories |
| `POST /scg_list_snapshots` | List snapshots for a repo |
| `POST /scg_snapshot_stats` | File/symbol/relation counts + uncertainty |
| `POST /scg_persist_homologs` | Discover and persist homologs |
| `GET /health` | Health check (no auth required) |
| `GET /ready` | Readiness probe (no auth required) |
| `GET /metrics` | Prometheus metrics (no auth required) |

### Example: Ingest a Repository

```bash
curl -X POST http://localhost:3100/scg_ingest_repo \
  -H "Content-Type: application/json" \
  -H "X-API-Key: your-key" \
  -d '{
    "repo_path": "/path/to/your/repo",
    "repo_name": "my-project",
    "commit_sha": "abc123",
    "branch": "main"
  }'
```

### Example: Find Homologs

```bash
curl -X POST http://localhost:3100/scg_find_homologs \
  -H "Content-Type: application/json" \
  -H "X-API-Key: your-key" \
  -d '{
    "symbol_version_id": "<uuid>",
    "snapshot_id": "<uuid>",
    "confidence_threshold": 0.70
  }'
```

---

## Development

```bash
npm run typecheck    # Type check
npm run lint         # Lint
npm test             # Run tests
npm run test:ci      # Tests with coverage
npm run test:watch   # Watch mode
npm run build        # Build for production
npm start            # Start production server
```

### Project Structure

```
src/
├── types.ts                    # Shared interfaces, enums, constants
├── logger.ts                   # Structured JSON logger
├── cache/
│   └── index.ts                # LRU cache with TTL and prefix invalidation
├── db-driver/
│   ├── index.ts                # PostgreSQL connection pool
│   ├── core_data.ts            # CRUD for core entities
│   └── batch-loader.ts         # Chunked batch query layer
├── adapters/
│   ├── ts/index.ts             # TypeScript Compiler API adapter
│   └── py/extractor.py         # Python LibCST adapter
├── analysis-engine/
│   ├── index.ts                # Structural graph engine
│   ├── behavioral.ts           # Purity classification + fingerprints
│   ├── contracts.ts            # Contract extraction + invariant mining
│   ├── blast-radius.ts         # 5-dimension impact analysis
│   ├── capsule-compiler.ts     # Token-budgeted context compilation
│   └── uncertainty.ts          # 12-source uncertainty tracking
├── semantic-engine/
│   ├── index.ts                # Multi-view embedding + LSH indexing
│   └── similarity.ts           # TF-IDF, MinHash, cosine similarity
├── homolog-engine/
│   └── index.ts                # 7-dimension weighted inference
├── transactional-editor/
│   ├── index.ts                # 9-state change lifecycle
│   └── sandbox.ts              # Process isolation for validation
├── ingestor/
│   └── index.ts                # Full ingestion pipeline
├── metrics/
│   └── index.ts                # Prometheus metrics exposition
├── middleware/
│   ├── auth.ts                 # API key auth (constant-time comparison)
│   ├── rate-limiter.ts         # Sliding window rate limiting
│   └── validation.ts           # Request body validation
└── mcp-interface/
    └── index.ts                # Express HTTP server (22 endpoints)

db/
├── schema.sql                  # PostgreSQL schema (14 tables)
├── migrations/                 # Versioned SQL migrations
└── migrate.ts                  # Migration runner
```

### Database Migrations

```bash
npm run db:migrate                    # Apply pending migrations
npx ts-node db/migrate.ts --status    # Check migration status
```

---

## Security

- **Authentication**: API key required on all endpoints (fail-closed). Constant-time comparison via `crypto.timingSafeEqual`.
- **Brute-Force Protection**: Per-IP exponential backoff with bounded tracking (10K max entries).
- **Rate Limiting**: Per-route sliding window limits. Expensive endpoints have lower thresholds.
- **Path Traversal Protection**: All file reads validate paths against repository base directory. Symlinks blocked.
- **Command Injection Prevention**: Python adapter uses `execFileSync` with array args (no shell interpolation).
- **Sandbox Execution**: Validation commands run in isolated subprocesses with environment sanitization, resource limits (ulimit), timeout enforcement, and SIGKILL escalation.
- **Error Sanitization**: API responses never leak stack traces or internal paths.
- **CORS**: Fail-closed — no configured origins means no CORS headers emitted.
- **Body Size Limits**: Per-route enforcement (10mb ingest, 5mb patches, 100kb queries).

---

## License

ISC
