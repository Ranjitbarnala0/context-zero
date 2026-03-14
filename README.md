**[Read the Performance Benchmarks & Competitive Analysis vs. Sourcegraph, Cursor, and CodeScene](BENCHMARKS.md)**

<p align="center">
  <strong>ContextZero</strong><br>
  <em>The code cognition engine that tells you what your code actually does.</em>
</p>

<p align="center">
  <a href="#quick-start">Quick Start</a> &middot;
  <a href="BENCHMARKS.md">Benchmarks</a> &middot;
  <a href="ARCHITECTURE.md">Architecture</a> &middot;
  <a href="#mcp-integration">MCP Integration</a> &middot;
  <a href="#enterprise">Enterprise</a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/version-1.0.0-blue" alt="Version">
  <img src="https://img.shields.io/badge/license-ISC-green" alt="License">
  <img src="https://img.shields.io/badge/node-%3E%3D20-brightgreen" alt="Node">
  <img src="https://img.shields.io/badge/tests-218%20passing-brightgreen" alt="Tests">
  <img src="https://img.shields.io/badge/languages-TS%20%7C%20JS%20%7C%20Python%20%7C%20C%2B%2B%20%7C%20Go-orange" alt="Languages">
  <img src="https://img.shields.io/badge/MCP-22%20tools-purple" alt="MCP Tools">
</p>

---

ContextZero is a **free, self-hosted code analysis engine** that gives AI coding agents deep understanding of your codebase. It doesn't search code — it *understands* it. Every function gets a behavioral fingerprint. Every change gets a blast radius. Every symbol gets a contract.

Built for developers who use Claude Code, Cursor, or any MCP-compatible tool and want their AI to stop guessing about what code does.

### The Problem

AI coding agents read files and grep for patterns. They don't know that `save_checkpoint()` writes to disk, that `_dts_newton_step()` mutates model weights in-place, or that changing `validate_input()` breaks 12 downstream callers. They guess. ContextZero eliminates the guessing.

### What You Get

| Capability | What It Does | Why It Matters |
|-----------|-------------|---------------|
| **Behavioral Profiling** | Classifies every function: `pure`, `read_only`, `read_write`, `side_effecting` — with specific mutation types | Know that `model.eval()` changes model state without reading 120 lines |
| **Blast Radius** | 5-dimension impact analysis at configurable depth with confidence scoring | See the full chain of what breaks before you ship |
| **Homolog Detection** | Finds parallel logic across disconnected code using 7-dimension weighted scoring | Catch the validator you forgot to update in the other module |
| **Context Capsules** | Token-budgeted code packages with dependencies, callers, tests, contracts | Feed your AI exactly what it needs — nothing more |
| **Contract Profiles** | Input/output types, error contracts, security contracts, invariants | Understand function promises without reading the implementation |
| **Transactional Edits** | 9-state lifecycle with 6-level validation and persistent rollback | Every code change is tracked, validated, and reversible |

### What Makes ContextZero Different

```
Other tools:  "save_checkpoint is defined on line 45 of utils.py"
ContextZero:  "save_checkpoint is read_write, touches file:torch_io,
               has 3 callers, blast radius impacts 8 symbols at depth 2,
               and has a near-duplicate in sigma3/ with 0.85 confidence"
```

This is not a search engine. It's an analysis engine. [See full benchmarks](BENCHMARKS.md).

---

## Quick Start

### Docker (Recommended)

```bash
git clone https://github.com/Ranjitbarnala0/context-zero.git
cd context-zero

echo "SCG_API_KEYS=your-secret-key" > .env

docker compose up -d

curl -H "X-API-Key: your-secret-key" http://localhost:3100/health
```

### Local Development

```bash
git clone https://github.com/Ranjitbarnala0/context-zero.git
cd context-zero && npm install

cp .env.example .env   # Edit with your DB credentials

createdb scg_v2 && npm run db:migrate
npm run dev
```

### MCP Integration

Add to your Claude Code or Claude Desktop MCP configuration:

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

Then in Claude Code, you can use all 22 tools:

```
> Use contextzero to find what save_checkpoint does
> What's the blast radius of changing ingestRepo?
> Find homologs of resolveSafePath
> Compile a context capsule for the behavioral engine
```

---

## Architecture

```
                        ContextZero Engine
    ┌─────────────────────────────────────────────────┐
    │          MCP Bridge (22 tools, stdio)            │
    │          REST API (25+ endpoints, HTTP)          │
    ├────────────┬────────────┬────────────┬───────────┤
    │  Ingestor  │  Analysis  │  Homolog   │ Transact. │
    │  Pipeline  │  Engines   │  Inference │ Editor    │
    ├────────────┼────────────┼────────────┼───────────┤
    │ TypeScript │ Behavioral │ 7-dim      │ 9-state   │
    │ Python     │ Contract   │ Weighted   │ 6-level   │
    │ C++        │ Blast Rad  │ Scoring    │ Sandbox   │
    │ Go         │ Capsule    │ LSH        │ Rollback  │
    │            │ Uncertainty│ Banding    │           │
    ├────────────┴────────────┴────────────┴───────────┤
    │     Semantic Engine (TF-IDF + MinHash + LSH)     │
    ├──────────────────────────────────────────────────┤
    │        PostgreSQL (pg_trgm, JSONB, GIN)          │
    └──────────────────────────────────────────────────┘
```

### Language Support

| Language | Parser | Depth |
|----------|--------|-------|
| TypeScript / JavaScript | TypeScript Compiler API | Full type resolution, AST normalization |
| Python | LibCST with metadata providers | Full AST, nested functions, PyTorch patterns |
| C++ | tree-sitter | Symbols + structure |
| Go | tree-sitter | Symbols + structure |

---

## 22 MCP Tools

### Discovery
| Tool | Description |
|------|-------------|
| `scg_resolve_symbol` | Fuzzy symbol search with similarity ranking |
| `scg_get_symbol_details` | Full symbol data with behavioral + contract profiles |
| `scg_get_symbol_relations` | Call graph — callers, callees, imports, inheritance |

### Analysis
| Tool | Description |
|------|-------------|
| `scg_get_behavioral_profile` | Purity class, mutations, DB ops, network calls, file I/O |
| `scg_get_contract_profile` | Input/output types, error contracts, security contracts |
| `scg_get_invariants` | Derived constraints and assertions for a symbol |
| `scg_get_uncertainty` | Where analysis confidence is low and why |
| `scg_blast_radius` | 5-dimension impact analysis at configurable depth |
| `scg_compile_context_capsule` | Token-budgeted context with priorities and omission rationale |
| `scg_find_homologs` | Parallel logic detection with 7-dimension evidence |
| `scg_persist_homologs` | Discover and save homolog relations |

### Repository
| Tool | Description |
|------|-------------|
| `scg_ingest_repo` | Full codebase ingestion with semantic embedding |
| `scg_list_repos` | List registered repositories |
| `scg_list_snapshots` | List snapshots for a repository |
| `scg_snapshot_stats` | Symbol/relation counts + uncertainty report |

### Change Management
| Tool | Description |
|------|-------------|
| `scg_create_change_transaction` | Start a tracked code change |
| `scg_apply_patch` | Apply file patches to a transaction |
| `scg_validate_change` | 6-level progressive validation |
| `scg_commit_change` | Finalize validated changes |
| `scg_rollback_change` | Revert all patches with file restoration |
| `scg_propagation_proposals` | Suggest parallel changes for homologs |
| `scg_get_transaction` | Transaction status and details |

---

## Configuration

All configuration via environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `DB_HOST` | `localhost` | PostgreSQL host |
| `DB_PORT` | `5432` | PostgreSQL port |
| `DB_NAME` | `scg_v2` | Database name |
| `DB_USER` | `postgres` | Database user |
| `DB_PASSWORD` | `postgres` | Database password |
| `SCG_PORT` | `3100` | HTTP server port |
| `SCG_API_KEYS` | *(none)* | API keys. **Empty = all requests rejected.** |
| `SCG_ALLOWED_BASE_PATHS` | *(none)* | Allowed repository directories |
| `LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` |

---

## Security

| Control | How |
|---------|-----|
| Authentication | Fail-closed API keys, constant-time comparison |
| Path traversal | Symlink-aware `realpathSync`, URL-encoding rejection |
| Command injection | `execFileSync` with array args (no shell) |
| Sandbox | ulimit, SIGKILL escalation, env sanitization |
| Rate limiting | Per-route sliding window |
| Error responses | No stack traces, no internal paths |

---

## Development

```bash
npm run typecheck    # Type check
npm run lint         # Lint
npm test             # Run tests (218 cases)
npm run test:ci      # Tests with coverage
npm run build        # Build for production
npm start            # Start REST API
npm run mcp          # Start MCP bridge
```

---

## Benchmarks

Full benchmark data with competitive analysis: **[BENCHMARKS.md](BENCHMARKS.md)**

Highlights:
- **2,211 symbols** extracted from a 50-file TypeScript + Python codebase in **7.1 seconds**
- **100% behavioral profile coverage** — every function classified
- **Zero false positives** on DB operation detection
- **Exact token budget compliance** on context capsules
- **Zero external API calls** — all computation is local
- **Free and self-hosted** — no per-seat pricing, no data leaves your machine

---

## What's Next

**ContextZero v2** is in development. The next version will introduce significantly deeper analysis capabilities, broader language coverage, and enterprise-scale features that go well beyond what any existing tool offers today. v1 already occupies a category that no other tool fills — v2 will widen that gap substantially.

Stay updated: **Watch this repository** for release announcements.

---

## Bug Reports

Every bug gets a root-cause fix, not a patch. If ContextZero gives you wrong data, that's a P0.

**Report**: [Open an issue](https://github.com/Ranjitbarnala0/context-zero/issues) with the tool name, input, actual output, and expected output.

---

## Enterprise

ContextZero is **free and open source** under the ISC license. Use it however you want — personal projects, commercial products, enterprise infrastructure. No restrictions.

For organizations that need more:

- **Priority Support** with SLA guarantees
- **Custom Language Adapters** for proprietary languages
- **Private Deployment** — on-premise, air-gapped, private cloud
- **Custom Integrations** — CI/CD, code review, IDE extensions
- **Advanced Features** — runtime traces, framework plugins, custom models
- **Dedicated Engineering** for your specific workflow

**Contact**: [ranjitbarnala0@gmail.com](mailto:ranjitbarnala0@gmail.com)

---

## License

ISC License — free for everyone, forever. See [LICENSE](LICENSE).
