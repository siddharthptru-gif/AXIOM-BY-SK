//! Bounded Tree-sitter symbol extraction for a file under an authorized root.

use anyhow::{anyhow, Result};
use serde::Deserialize;
use serde_json::{json, Value};
use tree_sitter::{Language, Node, Parser};

use crate::fs_safety::{
    canonicalize_root, path_string, read_file_bounded, truncate_utf8, MAX_FILE_BYTES,
};

const MAX_SYMBOLS: usize = 20_000;
const MAX_VISITED_NODES: usize = 1_000_000;
const MAX_PENDING_NODES: usize = 200_000;
const MAX_SYMBOL_NAME_BYTES: usize = 512;

#[derive(Deserialize)]
struct SymbolParams {
    root: String,
    path: String,
}

/// `(tree-sitter node kind, emitted symbol kind)` pairs, per language.
type KindTable = &'static [(&'static str, &'static str)];

const RUST_KINDS: KindTable = &[
    ("function_item", "function"),
    ("struct_item", "struct"),
    ("enum_item", "enum"),
    ("trait_item", "trait"),
    ("impl_item", "impl"),
    ("mod_item", "module"),
    ("const_item", "const"),
    ("static_item", "static"),
    ("type_item", "type"),
    ("macro_definition", "macro"),
];

const JS_KINDS: KindTable = &[
    ("function_declaration", "function"),
    ("generator_function_declaration", "function"),
    ("class_declaration", "class"),
    ("method_definition", "method"),
];

const TS_KINDS: KindTable = &[
    ("function_declaration", "function"),
    ("generator_function_declaration", "function"),
    ("class_declaration", "class"),
    ("abstract_class_declaration", "class"),
    ("method_definition", "method"),
    ("interface_declaration", "interface"),
    ("type_alias_declaration", "type"),
    ("enum_declaration", "enum"),
];

const PY_KINDS: KindTable = &[
    ("function_definition", "function"),
    ("class_definition", "class"),
];

fn language_for(path: &str) -> Option<(&'static str, Language, KindTable)> {
    let lower = path.to_ascii_lowercase();
    let ext = lower.rsplit('.').next().unwrap_or("");
    match ext {
        "rs" => Some(("rust", tree_sitter_rust::language(), RUST_KINDS)),
        "js" | "jsx" | "mjs" | "cjs" => {
            Some(("javascript", tree_sitter_javascript::language(), JS_KINDS))
        }
        "ts" | "mts" | "cts" => Some((
            "typescript",
            tree_sitter_typescript::language_typescript(),
            TS_KINDS,
        )),
        "tsx" => Some(("tsx", tree_sitter_typescript::language_tsx(), TS_KINDS)),
        "py" | "pyi" => Some(("python", tree_sitter_python::language(), PY_KINDS)),
        _ => None,
    }
}

fn collect(root: Node, source: &[u8], kinds: KindTable) -> Vec<Value> {
    let mut symbols = Vec::new();
    let mut stack = vec![root];
    let mut visited = 0usize;
    while let Some(node) = stack.pop() {
        if symbols.len() >= MAX_SYMBOLS || visited >= MAX_VISITED_NODES {
            break;
        }
        visited += 1;
        if let Some((_, symbol_kind)) = kinds.iter().find(|(kind, _)| *kind == node.kind()) {
            let name = node
                .child_by_field_name("name")
                .or_else(|| node.child_by_field_name("type"))
                .and_then(|name| name.utf8_text(source).ok())
                .unwrap_or("");
            symbols.push(json!({
                "kind": symbol_kind,
                "name": truncate_utf8(name, MAX_SYMBOL_NAME_BYTES),
                "startLine": node.start_position().row + 1,
                "endLine": node.end_position().row + 1,
            }));
        }
        let mut cursor = node.walk();
        for child in node.children(&mut cursor) {
            if stack.len() >= MAX_PENDING_NODES {
                break;
            }
            stack.push(child);
        }
    }
    symbols
}

/// RPC handler for `symbols`: parse one canonical, contained file.
pub async fn symbols(params: Value) -> Result<Value> {
    let p: SymbolParams = serde_json::from_value(params)?;

    let (root, path, language, mut symbols) =
        tokio::task::spawn_blocking(move || -> Result<(String, String, String, Vec<Value>)> {
            let root = canonicalize_root(&p.root)?;
            let root_string = path_string(&root)?;
            let (path, source) = read_file_bounded(&root, p.path.as_ref(), MAX_FILE_BYTES)?;
            let path_string = path_string(&path)?;
            let Some((language_name, language, kinds)) = language_for(&path_string) else {
                return Ok((
                    root_string,
                    path_string,
                    String::from("unknown"),
                    Vec::new(),
                ));
            };
            let mut parser = Parser::new();
            parser
                .set_language(language)
                .map_err(|error| anyhow!("set_language failed: {error}"))?;
            let tree = parser
                .parse(&source, None)
                .ok_or_else(|| anyhow!("parse failed"))?;
            let symbols = collect(tree.root_node(), &source, kinds);
            Ok((root_string, path_string, language_name.to_string(), symbols))
        })
        .await??;

    symbols.sort_by(|left, right| {
        let left_line = left["startLine"].as_u64().unwrap_or(0);
        let right_line = right["startLine"].as_u64().unwrap_or(0);
        left_line.cmp(&right_line)
    });

    let count = symbols.len();
    Ok(json!({
        "root": root,
        "path": path,
        "language": language,
        "count": count,
        "symbols": symbols
    }))
}
