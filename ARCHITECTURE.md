# ContextZero — Architecture

## 1. Engine Boundaries & Responsibility Pattern

The main service layer is implemented in **TypeScript (Node.js)** with three language adapter tiers:

- **TypeScript/JavaScript** — TypeScript Compiler API for full type-aware AST parsing
- **Python** — LibCST for lossless concrete syntax tree extraction
- **C++ / Go** — tree-sitter universal adapter for native CST parsing

All adapters produce the same normalized output (`AdapterExtractionResult`), ensuring uniform downstream processing regardless of source language.

### Core Subsystems

1. **Core Database Abstraction (`db-driver`)**
   - PostgreSQL connection pool with transaction support, slow query logging, and pool exhaustion warnings.
   - Chunked batch loader for efficient bulk queries within PostgreSQL parameter limits.

2. **Ingestion Pipeline (`ingestor`)**
   - Full and incremental repository scanning with differential parsing.
   - Dispatches to language-specific adapters based on file extension.
   - Populates test artifacts by linking test files to the symbols they reference.

3. **Language Adapters (`adapters/ts`, `adapters/py`, `adapters/universal`)**
   - **TypeScript Adapter** — Uses `ts.createProgram` and `ts.TypeChecker` for project-level type resolution. Extracts symbols, structural relations, 30+ behavioral side-effect patterns, and contract hints (parameter types, return types, thrown exceptions, decorators).
   - **Python Adapter** — Uses LibCST with `PositionProvider` metadata. Extracts symbols, relations, 60+ behavioral patterns (Django, FastAPI, SQLAlchemy, Pydantic aware), and contract hints. Runs as a subprocess via `execFileSync` with array args (command injection safe).
   - **Universal Adapter (tree-sitter)** — Production-grade multi-language parser supporting TypeScript, JavaScript, Python, C++, and Go. Language-specific walkers for symbol/relation/contract extraction. SHA-256 hashing for AST fingerprints.

4. **AST Normalization Engine (`adapters/ts/ast-normalizer`)**
   - Produces rename-invariant, whitespace-invariant, comment-invariant normalized AST hashes.
   - Alpha-renames function names, local variables, and parameters for structural comparison.
   - Full TypeScript Compiler API normalization for functions/methods, with regex fallback for raw code.

5. **Semantic Engine (`semantic-engine`)**
   - Native multi-view TF-IDF embedding engine with zero external dependencies.
   - 5-view tokenization: name, body, signature, behavior, contract.
   - MinHash signatures (128 permutations) with LSH banding for sub-linear candidate retrieval.
   - Cosine similarity on L2-normalized sparse vectors for precise scoring.

6. **Graph & Contract Engine (`analysis-engine`)**
   - **Structural Graph** — Resolves raw adapter relations into persisted graph edges with batch resolution.
   - **Behavioral Engine** — 4-tier purity classification (pure / read_only / read_write / side_effecting).
   - **Contract Engine** — Extracts input/output/error/security contracts. Mines invariants from test files.
   - **Blast Radius** — 5-dimensional impact analysis (structural, behavioral, contract, homolog, historical), computed in parallel.
   - **Capsule Compiler** — Token-budgeted minimal context packages in 3 modes (minimal/standard/strict).
   - **Uncertainty Tracker** — 12-source uncertainty model with per-symbol and per-snapshot confidence scoring.

7. **Homolog Inference Engine (`homolog-engine`)**
   - 7-dimension weighted scoring with evidence-backed classification.
   - 7 candidate generation buckets (body hash, AST hash, normalized hash, name similarity, semantic LSH, behavioral overlap, kind match).
   - Contradiction detection (side effects differ, exception semantics differ, security context differs, I/O shape diverges).
   - Minimum 2 evidence families required. No inference on semantic score alone.

8. **Transactional Change Engine (`transactional-editor`)**
   - 9-state lifecycle: planned → prepared → patched → reindexed → validated → propagation_pending → committed / rolled_back / failed.
   - 6-level progressive validation: syntax → type check → contract delta → behavioral delta → invariant check → test execution.
   - Persistent file backups in PostgreSQL with advisory locks for concurrent access.
   - Sandboxed subprocess execution with environment sanitization, ulimit resource constraints, and SIGKILL escalation.

9. **API Layer**
   - **REST API (`mcp-interface`)** — Express HTTP server with 25+ endpoints, fail-closed API key auth, per-route rate limiting, per-route body size limits, input validation on every route, and sanitized error responses.
   - **MCP Stdio Bridge (`mcp-bridge`)** — Native Model Context Protocol server over stdio transport. 22 tools registered for direct integration with Claude Code and Claude Desktop. All logging to stderr to preserve the JSON-RPC stream.

## 2. Completed Milestones

### Milestone 1: Data Layer & Connectivity
- PostgreSQL schema with 15 tables, 20+ indexes, auto-update triggers.
- Migration runner with checksum verification.
- Connection pool with health checks and readiness probes.

### Milestone 2: Multi-Language Adapters
- TypeScript Compiler API adapter with full type resolution.
- Python LibCST adapter with 60+ behavioral patterns.
- tree-sitter universal adapter supporting C++, Go, TypeScript, JavaScript, Python.

### Milestone 3: Semantic Embeddings & Homolog Engine
- Native TF-IDF + MinHash + LSH pipeline with zero external dependencies.
- 7-dimension weighted homolog scoring with contradiction detection.
- AST normalization for rename-invariant structural similarity.

### Milestone 4: Execution Sandbox & Transactional Editing
- Process isolation with environment sanitization and resource limits.
- 9-state change lifecycle with persistent rollback.
- 6-level progressive validation.

### Milestone 5: Production Hardening
- Symlink-aware path traversal protection across all file operations.
- URL-encoded and backslash path injection prevention.
- Per-IP brute-force protection with exponential backoff.
- Prometheus metrics exposition.
- Global error boundaries preventing silent crashes.
- MCP stdio bridge for native AI integration.
