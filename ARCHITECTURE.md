# ContextZero — Architecture and Build Roadmap

## 1. Engine Boundaries & Responsibility Pattern

The main service layer is implemented in **TypeScript (Node.js)**, with the TypeScript Compiler API providing native AST support. The Python adapter is a standalone parsing module using `LibCST` that reports back to the Node core.

### Core Subsystems

1. **Core Database Abstraction (`db-driver`)**
   - Interfaces with the PostgreSQL schema.
   - Enforces transaction safety directly on PostgreSQL.
2. **Ingestion Pipeline (`ingestor`)**
   - Handles repository scanning and differential parsing.
   - Dispatches to language adapters for AST processing.
3. **Language Adapters (`adapters/ts`, `adapters/py`)**
   - TypeScript Adapter loads compiler context to extract structural relations, type dependencies, and function boundaries, translating them into `SymbolVersion` entities.
   - Python Adapter uses `LibCST` to build the CST and extract equivalent entities.
4. **Graph & Contract Engine (`analysis-engine`)**
   - Resolves structural relations, behavioral profiles, contract profiles, and invariants.
5. **Homolog Inference Engine (`homolog-engine`)**
   - Multi-view semantic embeddings (TF-IDF + MinHash + LSH banding) with 7-dimension weighted scoring.
6. **Transactional Change Engine (`transactional-editor`)**
   - 9-state lifecycle with sandboxed subprocess execution for validation.
7. **API Server (`mcp-interface`)**
   - Express HTTP layer exposing all subsystems as authenticated REST endpoints.

## 2. Build Roadmap

### Milestone 1: Data Layer & Connectivity
- Configure PostgreSQL with the full schema.
- Implement the API shell to accept requests and route to subsystems.
- Implement the initial repository scanning pipeline.

### Milestone 2: TypeScript Adapter
- Write the TypeScript parser adapter using the TS Compiler API.
- Parse target projects and persist structured `SymbolVersions` and `StructuralRelations`.
- Validate precise line range allocations for symbols.

### Milestone 3: Semantic Embeddings & Homolog Scaffolding
- Bind the symbol ingestor to generate multi-view TF-IDF embeddings.
- Store MinHash signatures and sparse vectors in `semantic_vectors`.
- Implement LSH banding for sub-linear candidate retrieval.

### Milestone 4: Execution Sandbox
- Create the process isolation layer for running build/test commands.
- Implement patch application (unified diff format).
- Wire `scg_apply_patch` and `scg_validate_change` to the sandbox.

### Milestone 5: End-to-End Validation
- Execute full Plan → Prepare → Patch → Validate → Impact Analysis → Commit flow on a test repository.
- Verify all invariants pass or fail correctly based on the applied edit.
