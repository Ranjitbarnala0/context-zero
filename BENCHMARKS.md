# ContextZero v1 — Performance Benchmarks

Real-world benchmarks from production codebases. All numbers are reproducible — run the same ingestion on your own machine and compare.

---

## Ingestion Performance

Benchmarked on a single-core Node.js process with PostgreSQL 16 running locally.

| Codebase | Files | Symbols Extracted | Relations | Behavioral Profiles | Contract Profiles | Duration |
|----------|-------|-------------------|-----------|--------------------|--------------------|----------|
| ContextZero (TypeScript + Python, 50 files) | 50 | 2,211 | 1,317 | 1,569 | 321 | 7.1s |
| FORGE-Sigma (Python ML, 87 files) | 87 | 528 | 238 | 528 | 285 | 4.2s |

**Throughput**: ~300 symbols/second on commodity hardware.

### Per-Phase Breakdown (ContextZero self-ingestion)

| Phase | Duration | What It Does |
|-------|----------|-------------|
| File discovery | 12ms | Walk directory tree, filter by extension, skip symlinks |
| TypeScript extraction | 1,354ms | Full AST parse via TypeScript Compiler API |
| Python extraction | 780ms | LibCST parse with metadata providers |
| Symbol persistence | 890ms | Batch INSERT with ON CONFLICT deduplication |
| Behavioral profiling | 1,120ms | Side-effect pattern matching + purity classification |
| Contract extraction | 340ms | Type annotations, decorators, exception analysis |
| Relation resolution | 680ms | Call graph construction + batch INSERT |
| Invariant mining | 450ms | Behavioral inference + contract-based derivation |
| Semantic embedding | 1,476ms | TF-IDF + MinHash + LSH banding for all 5 views |

---

## Analysis Quality

### Behavioral Profiler Accuracy

Tested against ground truth from manual code review of 528 symbols in a production ML codebase.

| Metric | Result |
|--------|--------|
| Purity classification accuracy | 96.2% (508/528 correct) |
| State mutation detection | 100% (all PyTorch mutations detected: `model_eval`, `inplace_lerp`, `tensor_inplace_copy`, `gradient_zero`, `backprop`) |
| File I/O detection | 100% (`torch.save`, `pickle.dump`, `json.dump`, `numpy.save`, `pandas.read_csv`) |
| False positive rate (phantom DB ops) | 0% (tightened ORM-specific receiver patterns) |
| Behavioral profile coverage | 100% (every symbol gets a profile, including pure functions) |

### Purity Classification Breakdown

| Purity Class | Description | Example |
|-------------|-------------|---------|
| `pure` | No I/O, no state mutation | `computeNameSimilarity(a, b)` |
| `read_only` | Reads from DB/cache/auth, no writes | `getProfile(symbolVersionId)` |
| `read_write` | Writes to DB, mutates state, or file I/O | `save_checkpoint(model, path)` |
| `side_effecting` | Network calls or transaction operations | `ingestRepo(path, name, sha)` |

### Blast Radius Performance

| Depth | Avg Symbols Analyzed | Avg Response Time | Dimensions Computed |
|-------|---------------------|-------------------|-------------------|
| 1 | 8 | 45ms | 5 (structural, behavioral, contract, homolog, historical) |
| 2 | 23 | 120ms | 5 |
| 3 | 47 | 280ms | 5 |
| 5 (max) | 89 | 650ms | 5 |

### Context Capsule Token Efficiency

| Mode | Avg Token Usage | Avg Context Nodes | Budget Compliance |
|------|----------------|-------------------|-------------------|
| `minimal` | 1,200 tokens | 5 nodes | 100% within budget |
| `standard` | 3,000 tokens | 12 nodes | 100% within budget |
| `strict` | 8,500 tokens | 24 nodes | 100% within budget |

Previous versions exceeded token budgets by up to 49%. The current implementation enforces exact budget compliance with line-by-line truncation and prioritized context inclusion.

### Homolog Detection

| Metric | Result |
|--------|--------|
| Near-duplicate detection (identical AST) | 0.85+ confidence with structural identity override |
| Evidence dimensions | 7 (semantic, logic, signature, behavioral, contract, test, historical) |
| Candidate generation buckets | 7 (body_hash, ast_hash, normalized_ast_hash, name similarity, behavioral overlap, semantic LSH, kind match) |
| Contradiction detection | 4 flags (side_effects_differ, exception_semantics_differ, security_context_differs, io_shape_diverges) |

### Semantic Engine

| Component | Specification |
|-----------|--------------|
| Embedding type | Sparse TF-IDF vectors (5 views: name, body, signature, behavior, contract) |
| MinHash permutations | 128 (BigInt arithmetic for overflow safety) |
| LSH bands | 16 bands x 8 rows per band |
| Similarity metric | Weighted multi-view cosine similarity |
| External API calls | Zero. Fully local computation. |

---

## Competitive Analysis

### Capabilities That No Other Tool Provides

| Capability | ContextZero v1 | Nearest Alternative | Gap |
|-----------|---------------|-------------------|-----|
| Function-level purity analysis | 4-tier classification with mutation types | None | No tool classifies functions as pure/read_only/read_write/side_effecting |
| Automated blast radius with scoring | 5-dimension, depth-weighted, confidence-decayed | CodeScene (change coupling only) | CodeScene requires git history; ContextZero works from a single snapshot |
| Token-budgeted context capsules | 3 modes, exact budget compliance, omission rationale | None | No tool generates LLM-optimized context with token budgets |
| Semantic homolog detection | 7-dimension weighted scoring with contradiction flags | SonarQube (textual clones only) | SonarQube finds copy-paste; ContextZero finds behaviorally equivalent code |
| State mutation profiling | Per-operation types (model_eval, inplace_lerp, etc.) | None | No tool tracks specific mutation operations at the function level |

### Cost Comparison

| Tool | Price | Self-Hosted | Behavioral Analysis | Blast Radius |
|------|-------|-------------|--------------------|----|
| **ContextZero** | **Free** | **Yes** | **Yes** | **Yes** |
| Sourcegraph + Cody | $19-59/user/mo | Enterprise only | No | Manual ref search |
| CodeScene | ~$18/author/mo | Yes | File-level only | Change coupling |
| Greptile | $30/dev/mo | No (SaaS) | No | No |
| SonarQube | Free community | Yes | No | No |
| Semgrep | Free tier | Yes (CLI) | No | No |

### When to Use ContextZero vs. Alternatives

| Your Situation | Best Tool |
|---------------|-----------|
| Deep analysis of a single codebase | **ContextZero** |
| Cross-repo search across 500+ repos | Sourcegraph |
| Security vulnerability scanning | Semgrep + SonarQube |
| Team process intelligence (who changes what) | CodeScene |
| Library documentation for LLMs | Context7 |
| AI code editing | Cursor / Aider / Claude Code |

ContextZero is complementary to all of these. Use it alongside your existing tools — it fills a gap none of them cover.

---

## Test Suite

| Metric | Value |
|--------|-------|
| Test suites | 12 |
| Test cases | 218 |
| Pass rate | 100% |
| CI pipeline | TypeCheck + Lint + Tests (PostgreSQL 16) + Docker Build |
| Coverage collection | Jest with artifact upload |

---

## Database Schema

| Metric | Value |
|--------|-------|
| Tables | 17 |
| Indexes | 21 (including GIN trigram + array indexes) |
| Migrations | 4 (versioned, checksummed, idempotent) |
| Constraints | 13 unique, full FK with ON DELETE CASCADE |

---

## Security Posture

| Control | Implementation |
|---------|---------------|
| Authentication | Fail-closed API keys, constant-time comparison |
| Path traversal | Symlink-aware realpathSync, URL-encoding rejection, backslash rejection |
| Command injection | execFileSync with array args (no shell) |
| Sandbox execution | ulimit, SIGKILL escalation, env sanitization |
| Rate limiting | Per-route sliding window |
| Error sanitization | No stack traces or internal paths in responses |
| CORS | Fail-closed (no origins = no headers) |

---

*Benchmarks collected March 2026 on Ubuntu Linux, Node.js 22, PostgreSQL 16, commodity hardware (8-core, 16GB RAM). All numbers are single-process, no clustering or caching warm-up.*
