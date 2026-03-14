# ContextZero

**Production-grade code cognition and change orchestration engine.**

ContextZero builds a deep, versioned understanding of codebases — symbols, relations, behavioral fingerprints, contracts, invariants, and homolog relationships — then uses that understanding to power safe, validated code changes.

Unlike traditional code search or chunk-based RAG, ContextZero operates on **exact versioned symbols**, **evidence-backed inference**, and **transactional editing** — giving AI coding agents the precision substrate they need to modify code safely at scale.

### Why ContextZero

| Problem | How ContextZero solves it |
|---|---|
| **AI reads too much code** | Context capsules deliver the minimum sufficient code for a task — not whole files, not arbitrary chunks. Typical 60-80% reduction in tokens sent to the model. |
| **AI edits break things silently** | 5-dimensional blast radius analysis catches structural, behavioral, contract, homolog, and historical impacts before code ships. |
| **Duplicate logic hides across the codebase** | 7-dimension homolog detection finds parallel validators, mirrored auth logic, and copy-pasted business rules — even when they share no structural link. |
| **Edits are fire-and-forget** | Transactional change engine with 9-state lifecycle, 6-level validation, sandbox execution, and rollback. Every edit is a tracked, validated, reversible operation. |
| **Context costs scale with repo size** | Native TF-IDF + MinHash + LSH embeddings — zero external API calls. No OpenAI, no Cohere, no embedding costs. All computation is local. |
| **Code search is fuzzy and imprecise** | Symbol resolution returns exact AST-bound symbols with line ranges, signatures, and types — not text matches. |

### What ContextZero replaces

ContextZero is not a search engine. It replaces the entire stack of `grep` + embeddings + chunk retrieval + file edits with a single, coherent system that understands code at the symbol level. One ingestion pass gives you:

- **535+ symbols** extracted with exact line ranges, signatures, and type information
- **Behavioral fingerprints** for every function (pure / read-only / read-write / side-effecting)
- **Contract profiles** (input types, output types, error contracts, security contracts)
- **Structural relations** (calls, imports, inherits, typed_as, overrides)
- **Homolog detection** across disconnected code
- **Blast radius** before and after any change
- **Minimal context capsules** that fit any token budget

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│               API Layer (REST + MCP Stdio Bridge)                │
│         25+ endpoints · 22 MCP tools · auth · rate limiting      │
├─────────────┬─────────────┬─────────────┬───────────────────────┤
│  Ingestor   │  Analysis   │  Homolog    │  Transactional        │
│  Pipeline   │  Engines    │  Inference  │  Change Engine        │
├─────────────┼─────────────┼─────────────┼───────────────────────┤
│ TS Adapter  │ Structural  │ 7-dim       │ 9-state lifecycle     │
│ PY Adapter  │ Behavioral  │ Weighted    │ 6-level validation    │
│ C++ Adapter │ Contract    │ Scoring     │ Sandbox execution     │
│ Go Adapter  │ Blast Rad.  │ LSH         │ Persistent rollback   │
│ (tree-sit.) │ Capsule     │ Banding     │                       │
│             │ Uncertainty │             │                       │
├─────────────┼─────────────┼─────────────┴───────────────────────┤
│             │ Semantic Engine (TF-IDF · MinHash · Cosine)       │
├─────────────┴─────────────┴─────────────────────────────────────┤
│              PostgreSQL (pg_trgm · UUID · JSONB · LSH)           │
└──────────────────────────────────────────────────────────────────┘
```

### Core Subsystems

| Subsystem | Purpose |
|---|---|
| **Symbol Spine** | Versioned code symbols extracted via AST — TypeScript Compiler API, Python LibCST, tree-sitter (C++, Go) |
| **Behavioral Engine** | 4-tier purity classification (`pure` / `read_only` / `read_write` / `side_effecting`), resource tracking |
| **Contract Engine** | Input/output/error contracts, security contracts, invariant mining from tests |
| **Semantic Engine** | Native TF-IDF + MinHash + LSH embeddings — zero external API dependencies |
| **Homolog Engine** | 7-dimension weighted scoring for detecting parallel logic across disconnected code |
| **Blast Radius** | 5-dimensional impact analysis (structural, behavioral, contract, homolog, historical) |
| **Capsule Compiler** | Token-budgeted minimal context packages (minimal/standard/strict modes) |
| **Transactional Editor** | 9-state lifecycle with 6-level progressive validation and sandboxed execution |
| **MCP Bridge** | Native stdio bridge for Claude Code and Claude Desktop — 22 tools over JSON-RPC |

### Supported Languages

| Language | Adapter | Parser |
|---|---|---|
| TypeScript | `adapters/ts` | TypeScript Compiler API (full type resolution) |
| JavaScript | `adapters/ts` | TypeScript Compiler API |
| Python | `adapters/py` | LibCST with metadata providers |
| C++ | `adapters/universal` | tree-sitter |
| Go | `adapters/universal` | tree-sitter |

---

## Quick Start

### Prerequisites

- **Node.js** >= 20.0.0
- **PostgreSQL** >= 14 (with `pg_trgm` extension)
- **Python 3** (optional, for Python file analysis)

### Option 1: Docker (Recommended)

```bash
git clone https://github.com/Ranjitbarnala0/context-zero.git
cd context-zero

# Set your API key
echo "SCG_API_KEYS=your-secret-key" > .env

# Start PostgreSQL + ContextZero server
docker compose up -d

# Verify
curl -H "X-API-Key: your-secret-key" http://localhost:3100/health
```

### Option 2: Local Development

```bash
git clone https://github.com/Ranjitbarnala0/context-zero.git
cd context-zero

npm install

cp .env.example .env
# Edit .env with your database credentials and API key

createdb scg_v2
npm run db:migrate

npm run dev
```

### Option 3: MCP Integration (Claude Code / Claude Desktop)

Add to your MCP configuration:

```json
{
  "mcpServers": {
    "contextzero": {
      "command": "node",
      "args": ["/path/to/context-zero/dist/mcp-bridge/index.js"],
      "env": {
        "DB_HOST": "localhost",
        "DB_NAME": "scg_v2",
        "DB_USER": "postgres",
        "DB_PASSWORD": "your-db-password"
      }
    }
  }
}
```

Build first: `npm run build`

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
| `SCG_ALLOWED_BASE_PATHS` | *(none)* | Comma-separated allowed repository directories |
| `SCG_CORS_ORIGINS` | *(none)* | Comma-separated CORS origins (fail-closed) |
| `LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` / `fatal` |

---

## API Reference

All endpoints accept `POST` with JSON body. Authenticate with `Authorization: Bearer <key>` or `X-API-Key: <key>`.

### Repository Management

| Endpoint | Description |
|---|---|
| `POST /scg_register_repo` | Register a repository with its filesystem path |
| `POST /scg_ingest_repo` | Full codebase ingestion (requires prior registration) |
| `POST /scg_incremental_index` | Re-index only changed files |
| `POST /scg_batch_embed` | Generate semantic embeddings for a snapshot |

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
| `POST /scg_blast_radius` | 5-dimensional impact analysis |
| `POST /scg_compile_context_capsule` | Token-budgeted context compilation |
| `POST /scg_persist_homologs` | Discover and persist homolog relations |

### Change Management Tools

| Endpoint | Description |
|---|---|
| `POST /scg_create_change_transaction` | Create a tracked change transaction |
| `POST /scg_apply_patch` | Apply file patches to a transaction |
| `POST /scg_validate_change` | 6-level progressive validation |
| `POST /scg_commit_change` | Commit a validated transaction |
| `POST /scg_rollback_change` | Rollback with persistent file restoration |
| `POST /scg_propagation_proposals` | Homolog co-change proposals |
| `POST /scg_get_transaction` | Transaction status |

### Utility

| Endpoint | Description |
|---|---|
| `POST /scg_list_repos` | List registered repositories |
| `POST /scg_list_snapshots` | List snapshots for a repo |
| `POST /scg_snapshot_stats` | File/symbol/relation counts + uncertainty |
| `GET /health` | Health check (no auth) |
| `GET /ready` | Readiness probe (no auth) |
| `GET /metrics` | Prometheus metrics (no auth) |

### Example: Register and Ingest a Repository

```bash
# Step 1: Register the repository
curl -X POST http://localhost:3100/scg_register_repo \
  -H "Content-Type: application/json" \
  -H "X-API-Key: your-key" \
  -d '{
    "repo_name": "my-project",
    "repo_path": "/home/user/projects/my-project"
  }'

# Step 2: Ingest at a specific commit
curl -X POST http://localhost:3100/scg_ingest_repo \
  -H "Content-Type: application/json" \
  -H "X-API-Key: your-key" \
  -d '{
    "repo_id": "<repo-uuid-from-step-1>",
    "commit_sha": "abc123def",
    "branch": "main"
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
npm start            # Start production server (REST API)
npm run mcp          # Start MCP stdio bridge
npm run mcp:dev      # Start MCP bridge (dev mode)
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
│   ├── core_data.ts            # CRUD for all core entities
│   └── batch-loader.ts         # Chunked batch query layer
├── adapters/
│   ├── ts/
│   │   ├── index.ts            # TypeScript Compiler API adapter
│   │   └── ast-normalizer.ts   # Rename/whitespace-invariant AST hashing
│   ├── py/
│   │   └── extractor.py        # Python LibCST adapter
│   └── universal/
│       └── index.ts            # tree-sitter adapter (C++, Go, TS, JS, Python)
├── semantic-engine/
│   ├── index.ts                # Multi-view embedding + LSH indexing
│   ├── similarity.ts           # TF-IDF, MinHash, cosine, LSH band hashing
│   └── tokenizer.ts            # Code-aware 5-view tokenizer
├── analysis-engine/
│   ├── index.ts                # Structural graph engine
│   ├── behavioral.ts           # Purity classification + fingerprints
│   ├── contracts.ts            # Contract extraction + invariant mining
│   ├── blast-radius.ts         # 5-dimension impact analysis
│   ├── capsule-compiler.ts     # Token-budgeted context compilation
│   └── uncertainty.ts          # 12-source uncertainty tracking
├── homolog-engine/
│   └── index.ts                # 7-dimension weighted inference
├── transactional-editor/
│   ├── index.ts                # 9-state change lifecycle
│   └── sandbox.ts              # Process isolation for validation
├── ingestor/
│   └── index.ts                # Full + incremental ingestion pipeline
├── metrics/
│   └── index.ts                # Prometheus metrics exposition
├── middleware/
│   ├── auth.ts                 # API key auth (constant-time comparison)
│   ├── rate-limiter.ts         # Sliding window rate limiting
│   └── validation.ts           # Request body validation
├── mcp-interface/
│   └── index.ts                # Express HTTP server (25+ endpoints)
└── mcp-bridge/
    ├── index.ts                # MCP stdio server (22 tools)
    └── handlers.ts             # Direct-call tool handlers

db/
├── schema.sql                  # PostgreSQL schema (15 tables)
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
- **Path Traversal Protection**: All file operations resolve symlinks via `realpathSync` before containment checks. URL-encoded and backslash path injection blocked at validation layer.
- **Command Injection Prevention**: All subprocess execution uses `execFileSync`/`spawn` with array args (no shell interpolation).
- **Sandbox Execution**: Validation commands run in isolated subprocesses with environment sanitization, resource limits (ulimit), timeout enforcement, and SIGKILL escalation.
- **Error Sanitization**: API responses never leak stack traces or internal paths.
- **CORS**: Fail-closed — no configured origins means no CORS headers emitted.
- **Body Size Limits**: Per-route enforcement (10MB ingest, 5MB patches, 100KB queries).
- **Input Validation**: Every route uses centralized `validateBody()` — UUID format, string length, numeric bounds, path safety.

---

## Bug Reports

We treat every bug report as a P0. If you find an issue — wrong analysis, missing data, crashes, incorrect classifications — we fix it natively, not with patches. Permanent, root-cause fixes only.

**Report bugs**: [Open an issue](https://github.com/Ranjitbarnala0/context-zero/issues) with:
- The tool name and input you used
- What ContextZero returned
- What the correct result should be
- Source code snippet if possible

We respond to bug reports and ship fixes rapidly.

---

## Enterprise

ContextZero is **free and open source** under the ISC license. Individual developers, startups, and open-source projects can use it without any restrictions.

For enterprises deploying ContextZero on production codebases, we offer:

- **Priority Support** — Direct engineering support with SLA guarantees
- **Custom Language Adapters** — tree-sitter grammar development for proprietary or niche languages
- **Private Deployment** — On-premise, air-gapped, or private cloud deployment with security hardening
- **Custom Integrations** — CI/CD pipelines, code review systems, IDE extensions, internal toolchains
- **Advanced Features** — Runtime trace ingestion, framework-specific plugins (NestJS, Django, FastAPI, Prisma), and custom homolog classification models
- **Training & Architecture** — Team onboarding, codebase analysis workshops, and architecture consulting
- **Dedicated Engineering** — Custom feature development for your specific codebase and workflow needs

**Contact**: [ranjitbarnala0@gmail.com](mailto:ranjitbarnala0@gmail.com)

---

## License

ISC License — free for everyone, forever. See [LICENSE](LICENSE) for details.

Use ContextZero however you want — personal projects, commercial products, enterprise infrastructure. No restrictions, no usage limits, no tracking. Enterprise services (support, deployment, custom development) are available separately for organizations that need them.
