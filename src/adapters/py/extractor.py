"""
ContextZero — Python Language Adapter

Symbol extraction using LibCST. Extracts symbols, relations, behavior hints,
and contract hints from Python source code, outputting an
AdapterExtractionResult JSON to stdout.

Uses:
- LibCST CSTVisitor with metadata for positional information
- LibCST node matching for behavioral side-effect detection
- SHA-256 hashing for AST and body fingerprints
- Alpha-renaming normalization for structural similarity detection
"""

import libcst as cst
from libcst.metadata import PositionProvider
import hashlib
import sys
import json
import re
import os
from typing import List, Dict, Optional, Any, Set, Tuple


# ---------------------------------------------------------------------------
# Behavior pattern definitions
# ---------------------------------------------------------------------------

BEHAVIOR_PATTERNS: List[Dict[str, str]] = [
    # DB reads
    {"pattern": r"\.query\s*\(", "hint_type": "db_read", "detail": "query()"},
    {"pattern": r"\.execute\s*\(", "hint_type": "db_read", "detail": "execute()"},
    {"pattern": r"\.fetchone\s*\(", "hint_type": "db_read", "detail": "fetchone()"},
    {"pattern": r"\.fetchall\s*\(", "hint_type": "db_read", "detail": "fetchall()"},
    {"pattern": r"\.fetchmany\s*\(", "hint_type": "db_read", "detail": "fetchmany()"},
    {"pattern": r"\.select\s*\(", "hint_type": "db_read", "detail": "select()"},
    {"pattern": r"\.filter\s*\(", "hint_type": "db_read", "detail": "filter()"},
    {"pattern": r"(session|cursor|queryset|objects)\.get\s*\(", "hint_type": "db_read", "detail": "get()"},
    {"pattern": r"(\.objects\.all\s*\(|session\.query.*\.all\s*\()", "hint_type": "db_read", "detail": "all()"},
    {"pattern": r"(\.objects\.first\s*\(|session\.query.*\.first\s*\(|queryset\.first\s*\()", "hint_type": "db_read", "detail": "first()"},
    {"pattern": r"session\.query\s*\(", "hint_type": "db_read", "detail": "sqlalchemy_query"},
    # DB writes
    {"pattern": r"\.insert\s*\(", "hint_type": "db_write", "detail": "insert()"},
    {"pattern": r"\.update\s*\(", "hint_type": "db_write", "detail": "update()"},
    {"pattern": r"\.delete\s*\(", "hint_type": "db_write", "detail": "delete()"},
    {"pattern": r"\.commit\s*\(", "hint_type": "db_write", "detail": "commit()"},
    {"pattern": r"(session\.add\s*\(|\.objects\.add\s*\()", "hint_type": "db_write", "detail": "add()"},
    {"pattern": r"\.merge\s*\(", "hint_type": "db_write", "detail": "merge()"},
    {"pattern": r"(\.save\s*\(\s*\)|session\.save\s*\()", "hint_type": "db_write", "detail": "save()"},
    {"pattern": r"\.bulk_create\s*\(", "hint_type": "db_write", "detail": "bulk_create()"},
    {"pattern": r"\.bulk_update\s*\(", "hint_type": "db_write", "detail": "bulk_update()"},
    # Network calls
    {"pattern": r"requests\.(get|post|put|patch|delete|head|options)\s*\(", "hint_type": "network_call", "detail": "requests"},
    {"pattern": r"urllib\.(request|urlopen)", "hint_type": "network_call", "detail": "urllib"},
    {"pattern": r"aiohttp\.", "hint_type": "network_call", "detail": "aiohttp"},
    {"pattern": r"httpx\.(get|post|put|patch|delete|head|options|AsyncClient|Client)", "hint_type": "network_call", "detail": "httpx"},
    {"pattern": r"socket\.", "hint_type": "network_call", "detail": "socket"},
    {"pattern": r"grpc\.", "hint_type": "network_call", "detail": "grpc"},
    {"pattern": r"\.fetch\s*\(", "hint_type": "network_call", "detail": "fetch"},
    # File I/O
    {"pattern": r"\bopen\s*\(", "hint_type": "file_io", "detail": "open()"},
    {"pattern": r"Path\.(read_text|read_bytes|write_text|write_bytes)\s*\(", "hint_type": "file_io", "detail": "pathlib"},
    {"pattern": r"\.(read|write|readline|readlines|writelines)\s*\(", "hint_type": "file_io", "detail": "file_method"},
    {"pattern": r"os\.path\.", "hint_type": "file_io", "detail": "os.path"},
    {"pattern": r"os\.(remove|rename|makedirs|mkdir|rmdir|listdir|walk)\s*\(", "hint_type": "file_io", "detail": "os_fs"},
    {"pattern": r"shutil\.", "hint_type": "file_io", "detail": "shutil"},
    {"pattern": r"tempfile\.", "hint_type": "file_io", "detail": "tempfile"},
    {"pattern": r"torch\.(save|load)\s*\(", "hint_type": "file_io", "detail": "torch_io"},
    {"pattern": r"pickle\.(dump|load)\s*\(", "hint_type": "file_io", "detail": "pickle"},
    {"pattern": r"json\.(dump|load)\s*\(", "hint_type": "file_io", "detail": "json_io"},
    {"pattern": r"np\.(save|load|savez|loadtxt|savetxt)\s*\(", "hint_type": "file_io", "detail": "numpy_io"},
    {"pattern": r"pd\.(read_csv|read_excel|read_json|to_csv|to_excel)\s*\(", "hint_type": "file_io", "detail": "pandas_io"},
    # Cache operations
    {"pattern": r"cache\.(get|set|delete|clear|invalidate)\s*\(", "hint_type": "cache_op", "detail": "cache_operation"},
    {"pattern": r"redis\.(get|set|hget|hset|del|setex|expire)\s*\(", "hint_type": "cache_op", "detail": "redis"},
    {"pattern": r"memcache\.", "hint_type": "cache_op", "detail": "memcache"},
    {"pattern": r"@cache", "hint_type": "cache_op", "detail": "cache_decorator"},
    {"pattern": r"@lru_cache", "hint_type": "cache_op", "detail": "lru_cache"},
    # Auth
    {"pattern": r"@login_required", "hint_type": "auth_check", "detail": "login_required"},
    {"pattern": r"@requires_auth", "hint_type": "auth_check", "detail": "requires_auth"},
    {"pattern": r"@permission_required", "hint_type": "auth_check", "detail": "permission_required"},
    {"pattern": r"check_permission\s*\(", "hint_type": "auth_check", "detail": "check_permission"},
    {"pattern": r"authenticate\s*\(", "hint_type": "auth_check", "detail": "authenticate"},
    {"pattern": r"\.is_authenticated", "hint_type": "auth_check", "detail": "is_authenticated"},
    {"pattern": r"verify_token\s*\(", "hint_type": "auth_check", "detail": "verify_token"},
    {"pattern": r"@requires_permission", "hint_type": "auth_check", "detail": "requires_permission"},
    # Validation
    {"pattern": r"@validator\b", "hint_type": "validation", "detail": "pydantic_validator"},
    {"pattern": r"@validates\b", "hint_type": "validation", "detail": "sqlalchemy_validates"},
    {"pattern": r"@field_validator\b", "hint_type": "validation", "detail": "pydantic_field_validator"},
    {"pattern": r"@model_validator\b", "hint_type": "validation", "detail": "pydantic_model_validator"},
    {"pattern": r"pydantic\.", "hint_type": "validation", "detail": "pydantic"},
    {"pattern": r"marshmallow\.", "hint_type": "validation", "detail": "marshmallow"},
    {"pattern": r"cerberus\.", "hint_type": "validation", "detail": "cerberus"},
    {"pattern": r"\.validate\s*\(", "hint_type": "validation", "detail": "validate()"},
    {"pattern": r"Schema\s*\(", "hint_type": "validation", "detail": "schema"},
    # Throws
    {"pattern": r"\braise\s+\w+", "hint_type": "throws", "detail": "raise"},
    # Catches
    {"pattern": r"\bexcept\s+", "hint_type": "catches", "detail": "except"},
    {"pattern": r"\bexcept\s*:", "hint_type": "catches", "detail": "bare_except"},
    # State mutation
    {"pattern": r"self\.\w+\s*=", "hint_type": "state_mutation", "detail": "self_assignment"},
    {"pattern": r"\bsetattr\s*\(", "hint_type": "state_mutation", "detail": "setattr"},
    {"pattern": r"\bglobal\s+\w+", "hint_type": "state_mutation", "detail": "global_mutation"},
    {"pattern": r"\bnonlocal\s+\w+", "hint_type": "state_mutation", "detail": "nonlocal_mutation"},
    # PyTorch / ML state mutations
    {"pattern": r"\.data\.copy_\s*\(", "hint_type": "state_mutation", "detail": "tensor_inplace_copy"},
    {"pattern": r"\.eval\s*\(\s*\)", "hint_type": "state_mutation", "detail": "model_eval"},
    {"pattern": r"\.train\s*\(\s*\)", "hint_type": "state_mutation", "detail": "model_train"},
    {"pattern": r"\w+_\s*\(", "hint_type": "state_mutation", "detail": "inplace_operation"},
    {"pattern": r"\.zero_\s*\(", "hint_type": "state_mutation", "detail": "gradient_zero"},
    {"pattern": r"\.backward\s*\(", "hint_type": "state_mutation", "detail": "backprop"},
    {"pattern": r"\.step\s*\(", "hint_type": "state_mutation", "detail": "optimizer_step"},
    {"pattern": r"\.load_state_dict\s*\(", "hint_type": "state_mutation", "detail": "load_state"},
    {"pattern": r"\.copy_\s*\(", "hint_type": "state_mutation", "detail": "inplace_copy"},
    {"pattern": r"\.clamp_\s*\(", "hint_type": "state_mutation", "detail": "inplace_clamp"},
    {"pattern": r"\.fill_\s*\(", "hint_type": "state_mutation", "detail": "inplace_fill"},
    {"pattern": r"\.lerp_\s*\(", "hint_type": "state_mutation", "detail": "inplace_lerp"},
    # Transaction
    {"pattern": r"@atomic", "hint_type": "transaction", "detail": "atomic_decorator"},
    {"pattern": r"\.begin\s*\(", "hint_type": "transaction", "detail": "begin()"},
    {"pattern": r"with\s+transaction", "hint_type": "transaction", "detail": "transaction_context"},
    {"pattern": r"session\.begin\s*\(", "hint_type": "transaction", "detail": "session_begin"},
    {"pattern": r"\.rollback\s*\(", "hint_type": "transaction", "detail": "rollback()"},
    {"pattern": r"BEGIN|COMMIT|ROLLBACK", "hint_type": "transaction", "detail": "sql_transaction"},
    # Logging
    {"pattern": r"logging\.(debug|info|warning|error|critical|exception)\s*\(", "hint_type": "logging", "detail": "logging"},
    {"pattern": r"logger\.(debug|info|warning|error|critical|exception)\s*\(", "hint_type": "logging", "detail": "logger"},
    {"pattern": r"log\.(debug|info|warning|error|critical|exception)\s*\(", "hint_type": "logging", "detail": "log"},
    {"pattern": r"\bprint\s*\(", "hint_type": "logging", "detail": "print"},
]

# Compile patterns once for performance
COMPILED_BEHAVIOR_PATTERNS = [
    {"regex": re.compile(bp["pattern"]), "hint_type": bp["hint_type"], "detail": bp["detail"]}
    for bp in BEHAVIOR_PATTERNS
]


# ---------------------------------------------------------------------------
# AST Normalization (Python-specific)
# ---------------------------------------------------------------------------

def normalize_for_comparison(code: str) -> str:
    """
    Regex-based normalization for structural similarity detection.
    Steps:
    1. Remove comments (# ...)
    2. Remove docstrings
    3. Collapse whitespace
    4. Alpha-rename local variable assignments to v0, v1, ...
    5. Alpha-rename parameter names to p0, p1, ...
    6. Hash the normalized form with SHA-256
    """
    normalized = code

    # 1. Remove single-line comments
    normalized = re.sub(r'#[^\n]*', '', normalized)

    # 2. Remove docstrings (triple-quoted strings at start of function body)
    normalized = re.sub(r'"""[\s\S]*?"""', '', normalized)
    normalized = re.sub(r"'''[\s\S]*?'''", '', normalized)

    # 3. Collapse whitespace
    normalized = re.sub(r'\s+', ' ', normalized).strip()

    # 4. Alpha-rename local variable assignments
    var_counter = 0
    var_map: Dict[str, str] = {}

    def rename_var(match: re.Match) -> str:
        nonlocal var_counter
        name = match.group(1)
        if name not in var_map:
            var_map[name] = f"v{var_counter}"
            var_counter += 1
        return f"{var_map[name]} ="

    normalized = re.sub(r'\b([a-zA-Z_][a-zA-Z0-9_]*)\s*=(?!=)', rename_var, normalized)

    # 5. Alpha-rename parameter names in def signatures
    param_counter = 0
    param_map: Dict[str, str] = {}

    def rename_param(match: re.Match) -> str:
        nonlocal param_counter
        full = match.group(0)
        params_str = match.group(1)

        def sub_param(pm: re.Match) -> str:
            nonlocal param_counter
            pname = pm.group(1)
            annotation = pm.group(2) or ""
            if pname in ('self', 'cls', 'args', 'kwargs'):
                return pm.group(0)
            if pname not in param_map:
                param_map[pname] = f"p{param_counter}"
                param_counter += 1
            return f"{param_map[pname]}{annotation}"

        renamed = re.sub(
            r'([a-zA-Z_][a-zA-Z0-9_]*)(\s*:\s*[^,)=]*)?',
            sub_param, params_str
        )
        return f"({renamed})"

    normalized = re.sub(r'\(([^)]*)\)\s*(?:->|:)', rename_param, normalized)

    # 6. Replace all renamed variable usages
    for original, replacement in var_map.items():
        escaped = re.escape(original)
        normalized = re.sub(rf'\b{escaped}\b', replacement, normalized)
    for original, replacement in param_map.items():
        escaped = re.escape(original)
        normalized = re.sub(rf'\b{escaped}\b', replacement, normalized)

    # Hash the result
    return hashlib.sha256(normalized.encode('utf-8')).hexdigest()


# ---------------------------------------------------------------------------
# LibCST Helpers
# ---------------------------------------------------------------------------

def get_dotted_name(node) -> str:
    """Extract dotted name string from a LibCST Name or Attribute node."""
    if isinstance(node, cst.Name):
        return node.value
    if isinstance(node, cst.Attribute):
        base = get_dotted_name(node.value)
        return f"{base}.{node.attr.value}" if base else node.attr.value
    if isinstance(node, cst.Call):
        return get_dotted_name(node.func)
    return ""


def get_annotation_string(annotation) -> str:
    """Convert a LibCST annotation node to a readable string."""
    if annotation is None:
        return ""
    # If it's an Annotation wrapper, extract the inner annotation
    if isinstance(annotation, cst.Annotation):
        return get_annotation_string(annotation.annotation)
    if isinstance(annotation, cst.Name):
        return annotation.value
    if isinstance(annotation, cst.Attribute):
        return get_dotted_name(annotation)
    if isinstance(annotation, cst.Subscript):
        base = get_annotation_string(annotation.value)
        slices = []
        for s in annotation.slice:
            if isinstance(s, cst.SubscriptElement):
                slices.append(get_annotation_string(s.slice))
            else:
                slices.append(get_annotation_string(s))
        return f"{base}[{', '.join(slices)}]"
    if isinstance(annotation, cst.Index):
        return get_annotation_string(annotation.value)
    if isinstance(annotation, cst.Tuple):
        elts = [get_annotation_string(e.value) if isinstance(e, cst.Element) else get_annotation_string(e) for e in annotation.elements]
        return f"Tuple[{', '.join(elts)}]"
    if isinstance(annotation, cst.BinaryOperation):
        left = get_annotation_string(annotation.left)
        right = get_annotation_string(annotation.right)
        if isinstance(annotation.operator, cst.BitOr):
            return f"{left} | {right}"
        return f"{left} | {right}"
    if isinstance(annotation, cst.Ellipsis):
        return "..."
    # Fallback: try to get some string representation
    try:
        code = cst.parse_module("").code_for_node(annotation)
        return code.strip()
    except Exception:
        return "Any"


def get_decorator_name(decorator: cst.Decorator) -> str:
    """Extract decorator name from a Decorator node."""
    dec = decorator.decorator
    if isinstance(dec, cst.Name):
        return f"@{dec.value}"
    if isinstance(dec, cst.Attribute):
        return f"@{get_dotted_name(dec)}"
    if isinstance(dec, cst.Call):
        func_name = get_dotted_name(dec.func)
        return f"@{func_name}"
    return "@unknown"


# ---------------------------------------------------------------------------
# Main Extractor Visitor
# ---------------------------------------------------------------------------

class FullExtractor(cst.CSTVisitor):
    """
    Production-grade LibCST visitor that extracts:
    - Symbols (functions, classes, methods)
    - Relations (calls, imports, inherits, references)
    - Behavior hints (side-effect patterns)
    - Contract hints (type annotations, decorators, exceptions)
    """
    METADATA_DEPENDENCIES = (PositionProvider,)

    def __init__(self, filename: str, source_code: str):
        self.filename = filename
        self.source_code = source_code
        self.source_lines = source_code.splitlines()
        self.symbols: List[Dict[str, Any]] = []
        self.relations: List[Dict[str, str]] = []
        self.behavior_hints: List[Dict[str, Any]] = []
        self.contract_hints: List[Dict[str, Any]] = []
        self.uncertainty_flags: List[str] = []

        # Scope tracking
        self._class_stack: List[str] = []  # stack of class names for nesting
        self._function_stack: List[str] = []  # stack of function stable_keys
        self._function_name_stack: List[str] = []  # stack of function names for stable key construction
        self._known_symbol_names: Set[str] = set()

    def _make_stable_key(self, name: str) -> str:
        """Build a stable key like filename#ClassName.method_name or filename#outerFunc.innerFunc."""
        parts: List[str] = []
        if self._class_stack:
            parts.extend(self._class_stack)
        if self._function_name_stack:
            parts.extend(self._function_name_stack)
        if parts:
            return f"{self.filename}#{'.'.join(parts)}.{name}"
        return f"{self.filename}#{name}"

    def _get_node_text(self, pos) -> str:
        """Extract source text for a node using its position range."""
        start_line = pos.start.line - 1
        end_line = pos.end.line - 1
        if start_line < 0 or end_line >= len(self.source_lines):
            return ""
        if start_line == end_line:
            return self.source_lines[start_line][pos.start.column:pos.end.column]
        lines = []
        lines.append(self.source_lines[start_line][pos.start.column:])
        for i in range(start_line + 1, end_line):
            if i < len(self.source_lines):
                lines.append(self.source_lines[i])
        if end_line < len(self.source_lines):
            lines.append(self.source_lines[end_line][:pos.end.column])
        return "\n".join(lines)

    def _get_visibility(self, name: str) -> str:
        """Determine Python visibility from naming convention."""
        if name.startswith("__") and name.endswith("__"):
            return "public"  # dunder methods are public
        if name.startswith("__"):
            return "private"  # name-mangled
        if name.startswith("_"):
            return "protected"  # convention-private
        return "public"

    def _extract_behavior_hints(self, node_text: str, stable_key: str, base_line: int):
        """Scan function body text for behavioral side-effect patterns."""
        lines = node_text.split('\n')
        seen: Set[Tuple[str, str]] = set()  # deduplicate per (hint_type, detail)
        for i, line in enumerate(lines):
            for bp in COMPILED_BEHAVIOR_PATTERNS:
                if bp["regex"].search(line):
                    key = (bp["hint_type"], bp["detail"])
                    if key not in seen:
                        seen.add(key)
                        self.behavior_hints.append({
                            "symbol_key": stable_key,
                            "hint_type": bp["hint_type"],
                            "detail": bp["detail"],
                            "line": base_line + i,
                        })

    def _extract_contract_hint(self, node, stable_key: str):
        """Extract type annotations, return types, raised exceptions, decorators."""
        input_types: List[str] = []
        output_type = ""
        thrown_types: List[str] = []
        decorators: List[str] = []

        # Parameter type annotations
        if isinstance(node, cst.FunctionDef):
            for param in node.params.params:
                if param.annotation:
                    ann = get_annotation_string(param.annotation)
                    if ann:
                        input_types.append(ann)
                elif param.name and param.name.value != "self" and param.name.value != "cls":
                    input_types.append("Any")

            # *args
            if node.params.star_arg and isinstance(node.params.star_arg, cst.Param):
                if node.params.star_arg.annotation:
                    input_types.append(f"*{get_annotation_string(node.params.star_arg.annotation)}")

            # **kwargs
            if node.params.star_kwarg:
                if node.params.star_kwarg.annotation:
                    input_types.append(f"**{get_annotation_string(node.params.star_kwarg.annotation)}")

            # Return type annotation
            if node.returns:
                output_type = get_annotation_string(node.returns)

            # Decorators
            for dec in node.decorators:
                decorators.append(get_decorator_name(dec))

            # Thrown types: walk body looking for Raise nodes
            thrown_types = self._collect_raised_exceptions(node.body)

        self.contract_hints.append({
            "symbol_key": stable_key,
            "input_types": input_types,
            "output_type": output_type,
            "thrown_types": list(set(thrown_types)),
            "decorators": decorators,
        })

    def _collect_raised_exceptions(self, node) -> List[str]:
        """Recursively collect exception type names from raise statements."""
        raised: List[str] = []

        class RaiseCollector(cst.CSTVisitor):
            def visit_Raise(self, raise_node: cst.Raise):
                if raise_node.exc is not None:
                    if isinstance(raise_node.exc, cst.Call):
                        name = get_dotted_name(raise_node.exc.func)
                        if name:
                            raised.append(name)
                    elif isinstance(raise_node.exc, cst.Name):
                        raised.append(raise_node.exc.value)
                    elif isinstance(raise_node.exc, cst.Attribute):
                        raised.append(get_dotted_name(raise_node.exc))

        try:
            # node.body is an IndentedBlock; wrap and visit
            if isinstance(node, cst.IndentedBlock):
                # Visit the indented block as a subtree
                temp_module = cst.parse_module("")
                collector = RaiseCollector()
                # We can walk the node directly since CSTVisitor supports it
                node_wrapper_code = self.source_code
                # Simpler approach: regex scan on the source text
                pass
        except Exception:
            pass

        # Fallback: regex-based raise detection on the source text of the function
        # This is more reliable than trying to re-parse sub-trees
        return raised

    def _extract_calls_from_node(self, node, source_key: str):
        """Walk a function body to find call expressions and references."""

        class CallVisitor(cst.CSTVisitor):
            def __init__(self, extractor: 'FullExtractor'):
                self.extractor = extractor
                self.seen_calls: Set[str] = set()
                self.seen_refs: Set[str] = set()

            def visit_Call(self, call_node: cst.Call):
                target = get_dotted_name(call_node.func)
                if target and target not in self.seen_calls:
                    self.seen_calls.add(target)
                    self.extractor.relations.append({
                        "source_key": source_key,
                        "target_name": target,
                        "relation_type": "calls",
                    })

            def visit_Attribute(self, attr_node: cst.Attribute):
                # Only count as reference if not already part of a Call
                name = get_dotted_name(attr_node)
                if name and name not in self.seen_refs and name not in self.seen_calls:
                    self.seen_refs.add(name)
                    self.extractor.relations.append({
                        "source_key": source_key,
                        "target_name": name,
                        "relation_type": "references",
                    })

        try:
            visitor = CallVisitor(self)
            node.walk(visitor)
        except Exception:
            self.uncertainty_flags.append("call_extraction_failure")

    # -------------------------------------------------------------------
    # Import handling
    # -------------------------------------------------------------------

    def visit_Import(self, node: cst.Import):
        """Handle 'import x' and 'import x.y.z' statements."""
        if isinstance(node.names, cst.ImportStar):
            return
        if isinstance(node.names, (list, tuple)):
            for alias in node.names:
                if isinstance(alias, cst.ImportAlias):
                    module_name = get_dotted_name(alias.name)
                    if module_name:
                        source_key = self._function_stack[-1] if self._function_stack else self.filename
                        self.relations.append({
                            "source_key": source_key,
                            "target_name": module_name,
                            "relation_type": "imports",
                        })

    def visit_ImportFrom(self, node: cst.ImportFrom):
        """Handle 'from x import y' statements."""
        if isinstance(node.module, (cst.Name, cst.Attribute)):
            module_name = get_dotted_name(node.module)
        else:
            module_name = ""

        if isinstance(node.names, cst.ImportStar):
            if module_name:
                source_key = self._function_stack[-1] if self._function_stack else self.filename
                self.relations.append({
                    "source_key": source_key,
                    "target_name": f"{module_name}.*",
                    "relation_type": "imports",
                })
            return

        if isinstance(node.names, (list, tuple)):
            for alias in node.names:
                if isinstance(alias, cst.ImportAlias):
                    imported_name = get_dotted_name(alias.name)
                    target = f"{module_name}.{imported_name}" if module_name else imported_name
                    source_key = self._function_stack[-1] if self._function_stack else self.filename
                    self.relations.append({
                        "source_key": source_key,
                        "target_name": target,
                        "relation_type": "imports",
                    })

    # -------------------------------------------------------------------
    # Class handling
    # -------------------------------------------------------------------

    def visit_ClassDef(self, node: cst.ClassDef):
        pos = self.get_metadata(PositionProvider, node)
        name = node.name.value
        stable_key = self._make_stable_key(name)
        self._known_symbol_names.add(name)

        node_text = self._get_node_text(pos)
        signature_line = node_text.split('\n')[0].rstrip() if node_text else f"class {name}:"
        ast_hash = hashlib.sha256(node_text.encode('utf-8')).hexdigest()

        # Body text: everything after the first line
        body_lines = node_text.split('\n')[1:] if '\n' in node_text else []
        body_text = '\n'.join(body_lines)
        body_hash = hashlib.sha256(body_text.encode('utf-8')).hexdigest()

        # Normalized AST hash
        normalized_ast_hash = None
        try:
            if body_text.strip():
                normalized_ast_hash = normalize_for_comparison(body_text)
        except Exception:
            self.uncertainty_flags.append("normalization_failure")

        self.symbols.append({
            "stable_key": stable_key,
            "canonical_name": name,
            "kind": "class",
            "range_start_line": pos.start.line,
            "range_start_col": pos.start.column + 1,
            "range_end_line": pos.end.line,
            "range_end_col": pos.end.column + 1,
            "signature": signature_line.strip(),
            "ast_hash": ast_hash,
            "body_hash": body_hash,
            "normalized_ast_hash": normalized_ast_hash,
            "visibility": self._get_visibility(name),
        })

        # Extract class decorators for contract hint
        decorators = [get_decorator_name(d) for d in node.decorators]
        if decorators:
            self.contract_hints.append({
                "symbol_key": stable_key,
                "input_types": [],
                "output_type": "",
                "thrown_types": [],
                "decorators": decorators,
            })

        # Extract inheritance relations
        if node.bases:
            for base_arg in node.bases:
                base_name = get_dotted_name(base_arg.value)
                if base_name:
                    self.relations.append({
                        "source_key": stable_key,
                        "target_name": base_name,
                        "relation_type": "inherits",
                    })

        self._class_stack.append(name)
        return True  # Continue visiting children (methods)

    def leave_ClassDef(self, node: cst.ClassDef):
        if self._class_stack:
            self._class_stack.pop()

    # -------------------------------------------------------------------
    # Function / method handling
    # -------------------------------------------------------------------

    def visit_FunctionDef(self, node: cst.FunctionDef):
        pos = self.get_metadata(PositionProvider, node)
        name = node.name.value
        stable_key = self._make_stable_key(name)
        self._known_symbol_names.add(name)

        node_text = self._get_node_text(pos)

        # Determine kind
        kind = "function"
        if self._class_stack:
            kind = "method"
            # Check for route handler patterns in decorators
            for dec in node.decorators:
                dec_name = get_decorator_name(dec)
                if any(verb in dec_name.lower() for verb in
                       ['route', 'get', 'post', 'put', 'delete', 'patch']):
                    kind = "route_handler"
                    break

        # Signature: first line up to the colon
        sig_line = node_text.split('\n')[0].rstrip() if node_text else f"def {name}():"
        # For multi-line signatures, collect up to the colon
        if ':' not in sig_line:
            sig_lines = []
            for line in node_text.split('\n'):
                sig_lines.append(line.rstrip())
                if ':' in line:
                    break
            sig_line = ' '.join(sig_lines)

        ast_hash = hashlib.sha256(node_text.encode('utf-8')).hexdigest()

        # Body text: everything after signature
        colon_idx = node_text.find(':')
        body_text = node_text[colon_idx + 1:] if colon_idx >= 0 else node_text
        body_hash = hashlib.sha256(body_text.encode('utf-8')).hexdigest()

        # Normalized AST hash
        normalized_ast_hash = None
        try:
            if body_text.strip():
                normalized_ast_hash = normalize_for_comparison(body_text)
        except Exception:
            self.uncertainty_flags.append("normalization_failure")

        # Nested functions (inside another function, outside a class) are private
        if self._function_name_stack and not self._class_stack:
            visibility = "private"
        else:
            visibility = self._get_visibility(name)

        self.symbols.append({
            "stable_key": stable_key,
            "canonical_name": name,
            "kind": kind,
            "range_start_line": pos.start.line,
            "range_start_col": pos.start.column + 1,
            "range_end_line": pos.end.line,
            "range_end_col": pos.end.column + 1,
            "signature": sig_line.strip(),
            "ast_hash": ast_hash,
            "body_hash": body_hash,
            "normalized_ast_hash": normalized_ast_hash,
            "visibility": visibility,
        })

        # Behavior hints: scan function body text for side-effect patterns
        self._extract_behavior_hints(node_text, stable_key, pos.start.line)

        # Contract hint: parameter types, return type, exceptions, decorators
        self._extract_contract_hint(node, stable_key)

        # Relations: calls, references within the function body
        self._function_stack.append(stable_key)
        self._function_name_stack.append(name)
        self._extract_calls_from_body(node, stable_key)

        return True  # Continue visiting children

    def leave_FunctionDef(self, node: cst.FunctionDef):
        if self._function_stack:
            self._function_stack.pop()
        if self._function_name_stack:
            self._function_name_stack.pop()

    def _extract_calls_from_body(self, node: cst.FunctionDef, source_key: str):
        """Walk a FunctionDef body to find call expressions.

        Uses two strategies:
        1. Primary: LibCST visitor walk on the function body subtree
        2. Fallback: Regex-based call extraction from source text

        If the visitor walk fails (some LibCST versions have issues with
        subtree walking), the regex fallback ensures we still extract calls.
        """
        if node.body is None:
            return

        seen_calls: Set[str] = set()
        extraction_succeeded = False

        class BodyCallVisitor(cst.CSTVisitor):
            def __init__(self, extractor: 'FullExtractor'):
                self.extractor = extractor

            def visit_Call(self, call_node: cst.Call):
                target = get_dotted_name(call_node.func)
                if target and target not in seen_calls:
                    seen_calls.add(target)
                    self.extractor.relations.append({
                        "source_key": source_key,
                        "target_name": target,
                        "relation_type": "calls",
                    })

            # Don't recurse into nested function/class definitions
            def visit_FunctionDef(self, nested_node: cst.FunctionDef):
                return False

            def visit_ClassDef(self, nested_node: cst.ClassDef):
                return False

        try:
            visitor = BodyCallVisitor(self)
            node.body.walk(visitor)
            extraction_succeeded = True
        except Exception:
            pass  # Fall through to regex fallback

        # Fallback: regex-based call extraction from source text
        if not extraction_succeeded:
            try:
                pos = self.get_metadata(PositionProvider, node)
                body_text = self._get_node_text(pos)
                # Match function calls: identifier( or dotted.name(
                call_pattern = re.compile(r'(?<!\bdef\s)(?<!\bclass\s)\b([a-zA-Z_][a-zA-Z0-9_.]*)\s*\(')
                for m in call_pattern.finditer(body_text):
                    target = m.group(1)
                    # Skip keywords and built-in control flow
                    if target in ('if', 'for', 'while', 'with', 'assert', 'return',
                                  'yield', 'raise', 'except', 'print', 'not', 'and',
                                  'or', 'in', 'is', 'lambda', 'del'):
                        continue
                    if target not in seen_calls:
                        seen_calls.add(target)
                        self.relations.append({
                            "source_key": source_key,
                            "target_name": target,
                            "relation_type": "calls",
                        })
            except Exception:
                # Only flag as failure if BOTH strategies failed
                self.uncertainty_flags.append("call_extraction_failure")

    def _collect_raised_exceptions(self, node) -> List[str]:
        """Collect exception type names from raise statements using a visitor."""
        raised: List[str] = []

        class RaiseCollector(cst.CSTVisitor):
            def visit_Raise(self, raise_node: cst.Raise):
                if raise_node.exc is not None:
                    if isinstance(raise_node.exc, cst.Call):
                        name = get_dotted_name(raise_node.exc.func)
                        if name:
                            raised.append(name)
                    elif isinstance(raise_node.exc, cst.Name):
                        raised.append(raise_node.exc.value)
                    elif isinstance(raise_node.exc, cst.Attribute):
                        raised.append(get_dotted_name(raise_node.exc))

            # Don't recurse into nested functions
            def visit_FunctionDef(self, nested_node: cst.FunctionDef):
                return False

        try:
            collector = RaiseCollector()
            node.walk(collector)
        except Exception:
            pass

        return raised

    def _extract_contract_hint(self, node: cst.FunctionDef, stable_key: str):
        """Extract type annotations, return type, raised exceptions, decorators."""
        input_types: List[str] = []
        output_type = ""
        thrown_types: List[str] = []
        decorators: List[str] = []

        try:
            # Parameter type annotations (skip self/cls)
            for param in node.params.params:
                param_name = param.name.value if param.name else ""
                if param_name in ("self", "cls"):
                    continue
                if param.annotation:
                    ann = get_annotation_string(param.annotation)
                    input_types.append(ann if ann else "Any")
                else:
                    input_types.append("Any")

            # Keyword-only params
            for param in node.params.kwonly_params:
                if param.annotation:
                    ann = get_annotation_string(param.annotation)
                    input_types.append(ann if ann else "Any")
                else:
                    input_types.append("Any")

            # *args
            if node.params.star_arg and isinstance(node.params.star_arg, cst.Param):
                if node.params.star_arg.annotation:
                    input_types.append(f"*{get_annotation_string(node.params.star_arg.annotation)}")

            # **kwargs
            if node.params.star_kwarg:
                if node.params.star_kwarg.annotation:
                    input_types.append(f"**{get_annotation_string(node.params.star_kwarg.annotation)}")

            # Return type annotation
            if node.returns:
                output_type = get_annotation_string(node.returns)
            else:
                # BUG-004 fix: If no return type annotation, scan body for return
                # statements to infer whether the function returns a value.
                # This catches nested functions that return dicts, lists, etc.
                # without type annotations.
                try:
                    pos = self.get_metadata(PositionProvider, node)
                    body_text = self._get_node_text(pos)
                    # Look for "return {" (dict), "return [" (list), "return (" (tuple),
                    # or "return <identifier>" (variable)
                    return_matches = re.findall(
                        r'\breturn\s+(\{[^}]*|[\[(\w])',
                        body_text
                    )
                    if return_matches:
                        # Infer type from what follows return
                        first = return_matches[0].strip()
                        if first.startswith('{'):
                            output_type = "dict"
                        elif first.startswith('['):
                            output_type = "list"
                        elif first.startswith('('):
                            output_type = "tuple"
                        elif first == 'True' or first == 'False':
                            output_type = "bool"
                        elif first == 'None':
                            output_type = ""  # stays void
                        else:
                            output_type = "Any"
                except Exception:
                    pass  # Keep output_type as ""

            # Decorators
            for dec in node.decorators:
                decorators.append(get_decorator_name(dec))

            # Thrown types from body
            if node.body:
                thrown_types = self._collect_raised_exceptions(node.body)

        except Exception:
            self.uncertainty_flags.append("type_inference_failure")

        self.contract_hints.append({
            "symbol_key": stable_key,
            "input_types": input_types,
            "output_type": output_type,
            "thrown_types": list(set(thrown_types)),
            "decorators": decorators,
        })


# ---------------------------------------------------------------------------
# Top-level extraction function
# ---------------------------------------------------------------------------

def extract(filepath: str) -> Dict[str, Any]:
    """
    Extract all symbols, relations, behavior hints, and contract hints
    from a Python file. Returns an AdapterExtractionResult dict.
    """
    uncertainty_flags: List[str] = []

    try:
        with open(filepath, "r", encoding="utf-8") as f:
            source_code = f.read()
    except UnicodeDecodeError:
        # Try with latin-1 fallback
        try:
            with open(filepath, "r", encoding="latin-1") as f:
                source_code = f.read()
            uncertainty_flags.append("encoding_fallback")
        except Exception:
            print(f"Error: Cannot read file {filepath}", file=sys.stderr)
            return _empty_result(["file_read_error"])

    if not source_code.strip():
        return _empty_result([])

    try:
        module = cst.parse_module(source_code)
    except cst.ParserSyntaxError as e:
        print(f"Parse error in {filepath}: {e}", file=sys.stderr)
        return _empty_result(["parse_error"])
    except Exception as e:
        print(f"Unexpected parse error in {filepath}: {e}", file=sys.stderr)
        return _empty_result(["parse_error"])

    try:
        wrapper = cst.MetadataWrapper(module)
        extractor = FullExtractor(filepath, source_code)
        wrapper.visit(extractor)
    except Exception as e:
        print(f"Extraction error in {filepath}: {e}", file=sys.stderr)
        return _empty_result(["extraction_error"])

    # Merge uncertainty flags
    all_flags = list(set(uncertainty_flags + extractor.uncertainty_flags))

    # Compute parse confidence
    if not all_flags:
        parse_confidence = 1.0
    else:
        parse_confidence = max(0.5, 1.0 - len(all_flags) * 0.1)

    return {
        "symbols": extractor.symbols,
        "relations": extractor.relations,
        "behavior_hints": extractor.behavior_hints,
        "contract_hints": extractor.contract_hints,
        "parse_confidence": parse_confidence,
        "uncertainty_flags": all_flags,
    }


def _empty_result(flags: List[str]) -> Dict[str, Any]:
    """Return an empty AdapterExtractionResult."""
    return {
        "symbols": [],
        "relations": [],
        "behavior_hints": [],
        "contract_hints": [],
        "parse_confidence": 0.0 if flags else 1.0,
        "uncertainty_flags": flags,
    }


# ---------------------------------------------------------------------------
# CLI entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python extractor.py <filepath>", file=sys.stderr)
        sys.exit(1)

    filepath = sys.argv[1]

    if not os.path.isfile(filepath):
        print(f"Error: File not found: {filepath}", file=sys.stderr)
        result = _empty_result(["file_not_found"])
        print(json.dumps(result, indent=2))
        sys.exit(1)

    result = extract(filepath)
    print(json.dumps(result, indent=2))
