/**
 * ContextZero — Canonical Type Definitions
 *
 * Shared TypeScript interfaces and enums for all entities in the system.
 * Every engine, adapter, and API endpoint imports types from here.
 */

// ENUMS

export type SymbolKind =
    | 'function' | 'method' | 'class' | 'interface'
    | 'route_handler' | 'validator' | 'serializer'
    | 'query_builder' | 'schema_object' | 'test_case'
    | 'config_object' | 'variable' | 'type_alias' | 'enum' | 'module';

export type Visibility = 'public' | 'private' | 'protected' | 'internal';

export type StructuralRelationType =
    | 'calls' | 'called_by'
    | 'references' | 'defines'
    | 'imports' | 'exports'
    | 'implements' | 'inherits'
    | 'typed_as' | 'overrides';

export type InferredRelationType =
    | 'validator_homolog' | 'serializer_homolog'
    | 'auth_policy_peer' | 'near_duplicate_logic'
    | 'business_rule_parallel' | 'normalization_homolog'
    | 'contract_sibling' | 'co_changed_with'
    | 'query_logic_duplicate' | 'error_mapping_peer';

export type PurityClass = 'pure' | 'read_only' | 'read_write' | 'side_effecting';

export type TransactionState =
    | 'planned' | 'prepared' | 'patched' | 'reindexed'
    | 'validated' | 'propagation_pending'
    | 'committed' | 'rolled_back' | 'failed';

export type IndexStatus = 'pending' | 'indexing' | 'complete' | 'failed' | 'partial';
export type ParseStatus = 'parsed' | 'error' | 'skipped';
export type ValidationMode = 'quick' | 'standard' | 'strict';
export type CapsuleMode = 'minimal' | 'standard' | 'strict';
export type ReviewState = 'unreviewed' | 'confirmed' | 'rejected';
export type RelationSource = 'static_analysis' | 'runtime_trace' | 'heuristic' | 'manual';
export type InvariantSourceType = 'explicit_test' | 'derived' | 'manual' | 'assertion' | 'schema';
export type InvariantScopeLevel = 'global' | 'module' | 'symbol';

// DATABASE ENTITIES

export interface Repository {
    repo_id: string;
    name: string;
    default_branch: string;
    visibility: 'public' | 'private';
    language_set: string[];
    created_at: Date;
    updated_at: Date;
}

export interface Snapshot {
    snapshot_id: string;
    repo_id: string;
    commit_sha: string;
    branch: string;
    parent_snapshot_id: string | null;
    indexed_at: Date;
    index_status: IndexStatus;
}

export interface FileRecord {
    file_id: string;
    snapshot_id: string;
    path: string;
    content_hash: string;
    language: string;
    parse_status: ParseStatus;
}

export interface SymbolRecord {
    symbol_id: string;
    repo_id: string;
    stable_key: string;
    canonical_name: string;
    kind: SymbolKind;
    logical_namespace: string | null;
}

export interface SymbolVersion {
    symbol_version_id: string;
    symbol_id: string;
    snapshot_id: string;
    file_id: string;
    range_start_line: number;
    range_start_col: number;
    range_end_line: number;
    range_end_col: number;
    signature: string;
    ast_hash: string;
    body_hash: string;
    summary: string;
    visibility: Visibility;
    language: string;
    uncertainty_flags: string[];
}

export interface StructuralRelation {
    relation_id: string;
    src_symbol_version_id: string;
    dst_symbol_version_id: string;
    relation_type: StructuralRelationType;
    strength: number;
    source: RelationSource;
    confidence: number;
}

export interface BehavioralProfile {
    behavior_profile_id: string;
    symbol_version_id: string;
    purity_class: PurityClass;
    resource_touches: string[];
    db_reads: string[];
    db_writes: string[];
    network_calls: string[];
    cache_ops: string[];
    file_io: string[];
    auth_operations: string[];
    validation_operations: string[];
    exception_profile: string[];
    state_mutation_profile: string[];
    transaction_profile: string[];
}

export interface ContractProfile {
    contract_profile_id: string;
    symbol_version_id: string;
    input_contract: string;
    output_contract: string;
    error_contract: string;
    schema_refs: string[];
    api_contract_refs: string[];
    serialization_contract: string;
    security_contract: string;
    derived_invariants_count: number;
}

export interface Invariant {
    invariant_id: string;
    repo_id: string;
    scope_symbol_id: string | null;
    scope_level: InvariantScopeLevel;
    expression: string;
    source_type: InvariantSourceType;
    strength: number;
    validation_method: string;
    last_verified_snapshot_id: string | null;
}

export interface EvidenceBundle {
    evidence_bundle_id: string;
    semantic_score: number;
    structural_score: number;
    behavioral_score: number;
    contract_score: number;
    test_score: number;
    history_score: number;
    contradiction_flags: string[];
    feature_payload: Record<string, unknown>;
    generated_at: Date;
}

export interface InferredRelation {
    inferred_relation_id: string;
    src_symbol_version_id: string;
    dst_symbol_version_id: string;
    relation_type: InferredRelationType;
    confidence: number;
    review_state: ReviewState;
    evidence_bundle_id: string;
    valid_from_snapshot_id: string;
    valid_to_snapshot_id: string | null;
}

export interface TestArtifact {
    test_artifact_id: string;
    symbol_version_id: string;
    framework: string;
    related_symbols: string[];
    assertion_summary: string;
    coverage_hints: Record<string, unknown> | null;
}

export interface ChangeTransaction {
    txn_id: string;
    repo_id: string;
    base_snapshot_id: string;
    created_by: string;
    state: TransactionState;
    target_symbol_versions: string[];
    patches: PatchSet;
    impact_report_ref: string | null;
    validation_report_ref: string | null;
    propagation_report_ref: string | null;
    created_at: Date;
    updated_at: Date;
}

// ENGINE OUTPUT TYPES

export interface PatchEntry {
    file_path: string;
    new_content: string;
}

export type PatchSet = PatchEntry[];

export interface SymbolCandidate {
    symbol_id: string;
    name: string;
    stable_key: string;
    kind: SymbolKind;
    rank: number;
}

export interface BlastRadiusImpact {
    symbol_id: string;
    symbol_name: string;
    impact_type: 'structural' | 'behavioral' | 'contract' | 'homolog' | 'historical';
    relation_type: string;
    confidence: number;
    severity: 'low' | 'medium' | 'high' | 'critical';
    evidence: string;
    recommended_action: 'propagation' | 'manual_review' | 'rerun_test' | 'validate_contract' | 'no_action';
}

export interface BlastRadiusReport {
    target_symbols: string[];
    structural_impacts: BlastRadiusImpact[];
    behavioral_impacts: BlastRadiusImpact[];
    contract_impacts: BlastRadiusImpact[];
    homolog_impacts: BlastRadiusImpact[];
    historical_impacts: BlastRadiusImpact[];
    total_impact_count: number;
    recommended_validation_scope: ValidationMode;
}

export interface ContextCapsule {
    target_symbol: {
        symbol_id: string;
        name: string;
        code: string;
        signature: string;
        location: { file_path: string; start_line: number; end_line: number };
    };
    context_nodes: ContextNode[];
    omission_rationale: string[];
    uncertainty_notes: string[];
    token_estimate: number;
}

export interface ContextNode {
    type: 'dependency' | 'caller' | 'test' | 'contract' | 'invariant'
        | 'homolog' | 'type_context' | 'related_change';
    symbol_id: string | null;
    name: string;
    code: string | null;
    summary: string | null;
    relevance: number;
}

export interface HomologCandidate {
    symbol_id: string;
    symbol_version_id: string;
    symbol_name: string;
    relation_type: InferredRelationType;
    confidence: number;
    evidence: EvidenceScores;
    contradiction_flags: string[];
}

export interface EvidenceScores {
    semantic_intent_similarity: number;
    normalized_logic_similarity: number;
    signature_type_similarity: number;
    behavioral_overlap: number;
    contract_overlap: number;
    test_overlap: number;
    history_co_change: number;
    weighted_total: number;
    evidence_family_count: number;
    rationale: string;
}

export interface ValidationReport {
    transaction_id: string;
    mode: ValidationMode;
    overall_passed: boolean;
    levels: {
        level: number;
        name: string;
        passed: boolean;
        details: string;
        failures: string[];
    }[];
    executed_at: Date;
}

export interface SemanticChangeSummary {
    transaction_id: string;
    side_effects_changed: boolean;
    return_type_changed: boolean;
    exception_behavior_changed: boolean;
    auth_behavior_changed: boolean;
    serialization_changed: boolean;
    persistence_expanded: boolean;
    details: string;
    before_profiles: Record<string, unknown>;
    after_profiles: Record<string, unknown>;
}

export interface ContractDeltaSummary {
    transaction_id: string;
    broken_contracts: { symbol_id: string; contract_field: string; before: string; after: string }[];
    weakened_invariants: { invariant_id: string; expression: string; issue: string }[];
    new_contracts: { symbol_id: string; contract_field: string; value: string }[];
}

export interface PropagationCandidate {
    homolog_symbol_id: string;
    homolog_name: string;
    relation_type: InferredRelationType;
    confidence: number;
    is_safe: boolean;
    patch_proposal: PatchEntry | null;
    risk_notes: string[];
}

export interface UncertaintyAnnotation {
    source: string;
    affected_symbol_id: string | null;
    description: string;
    confidence_impact: number;
    recommended_evidence: string;
}

// ADAPTER OUTPUT TYPES

export interface ExtractedSymbol {
    stable_key: string;
    canonical_name: string;
    kind: string;
    range_start_line: number;
    range_start_col: number;
    range_end_line: number;
    range_end_col: number;
    signature: string;
    ast_hash: string;
    body_hash: string;
    normalized_ast_hash?: string;
    visibility: string;
}

export interface ExtractedRelation {
    source_key: string;
    target_name: string;
    relation_type: StructuralRelationType;
}

export interface BehaviorHint {
    symbol_key: string;
    hint_type: 'db_read' | 'db_write' | 'network_call' | 'file_io' | 'cache_op'
             | 'auth_check' | 'validation' | 'throws' | 'catches' | 'state_mutation'
             | 'transaction' | 'logging';
    detail: string;
    line: number;
}

export interface ContractHint {
    symbol_key: string;
    input_types: string[];
    output_type: string;
    thrown_types: string[];
    decorators: string[];
}

export interface AdapterExtractionResult {
    symbols: ExtractedSymbol[];
    relations: ExtractedRelation[];
    behavior_hints: BehaviorHint[];
    contract_hints: ContractHint[];
    parse_confidence: number;
    uncertainty_flags: string[];
}

export interface IngestionResult {
    repo_id: string;
    snapshot_id: string;
    files_processed: number;
    files_failed: number;
    symbols_extracted: number;
    relations_extracted: number;
    behavior_hints_extracted: number;
    contract_hints_extracted: number;
    duration_ms: number;
}

// CONSTANTS

export const HOMOLOG_WEIGHTS = {
    semantic_intent_similarity: 0.20,
    normalized_logic_similarity: 0.20,
    signature_type_similarity: 0.15,
    behavioral_overlap: 0.15,
    contract_overlap: 0.15,
    test_overlap: 0.10,
    history_co_change: 0.05,
} as const;

export const MIN_EVIDENCE_FAMILIES = 2;
export const DEFAULT_HOMOLOG_CONFIDENCE_THRESHOLD = 0.70;

// Express Request type extension for correlation IDs
declare global {
    // eslint-disable-next-line @typescript-eslint/no-namespace
    namespace Express {
        interface Request {
            correlationId?: string;
        }
    }
}
