//! Bounded file-level dependency graph over a canonical workspace root.

use std::collections::{HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

use anyhow::Result;
use regex::Regex;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::fs_safety::{
    canonicalize_root, contained_file, path_string, read_text_bounded, truncate_utf8, walk_no_links,
};

const SRC_EXTS: &[&str] = &["ts", "tsx", "js", "jsx", "mjs", "cjs"];
const RESOLVE_EXTS: &[&str] = &["ts", "tsx", "d.ts", "js", "jsx", "mjs", "cjs", "json"];
const FILE_CAP: usize = 50_000;
const MAX_SOURCE_BYTES: u64 = 4 * 1024 * 1024;
const MAX_TOTAL_SOURCE_BYTES: u64 = 128 * 1024 * 1024;
const MAX_IMPORTS_PER_FILE: usize = 2_048;
const MAX_GRAPH_EDGES: usize = 250_000;
const MAX_EXTERNAL_PACKAGES: usize = 256;
const MAX_EXTERNAL_ENTRIES: usize = 100_000;
const MAX_SPECIFIER_BYTES: usize = 2_048;
const MAX_QUERY_RESULTS: usize = 10_000;
const MAX_CYCLES: usize = 25;
const MAX_CYCLE_LENGTH: usize = 512;
const MAX_CACHED_ROOTS: usize = 4;

struct GraphData {
    imports: HashMap<String, Vec<String>>,
    imported_by: HashMap<String, Vec<String>>,
    external: HashMap<String, Vec<String>>,
}

fn import_regex() -> &'static Regex {
    static REGEX: OnceLock<Regex> = OnceLock::new();
    REGEX.get_or_init(|| {
        Regex::new(
            r#"(?m)(?:\bfrom\s*|\brequire\s*\(\s*|\bimport\s*\(\s*|^\s*import\s+)['"]([^'"\n]+)['"]"#,
        )
        .expect("import regex is valid")
    })
}

fn append_ext(path: &Path, extension: &str) -> PathBuf {
    let mut value = path.as_os_str().to_os_string();
    value.push(".");
    value.push(extension);
    PathBuf::from(value)
}

fn resolve_import(from_file: &Path, specifier: &str, root: &Path) -> Option<PathBuf> {
    if specifier.len() > MAX_SPECIFIER_BYTES
        || !(specifier.starts_with("./")
            || specifier.starts_with("../")
            || specifier == "."
            || specifier == "..")
    {
        return None;
    }
    let base = from_file.parent()?.join(specifier);
    let contained = |candidate: &Path| contained_file(root, candidate).ok().map(|file| file.path);
    if let Some(path) = contained(&base) {
        return Some(path);
    }
    for extension in RESOLVE_EXTS {
        if let Some(path) = contained(&append_ext(&base, extension)) {
            return Some(path);
        }
    }
    for extension in RESOLVE_EXTS {
        if let Some(path) = contained(&base.join(format!("index.{extension}"))) {
            return Some(path);
        }
    }
    None
}

fn external_package_name(specifier: &str) -> String {
    let package = if let Some(rest) = specifier.strip_prefix('@') {
        let mut parts = rest.splitn(2, '/');
        let scope = parts.next().unwrap_or("");
        match parts.next() {
            Some(name) => format!("@{scope}/{}", name.split('/').next().unwrap_or(name)),
            None => format!("@{scope}"),
        }
    } else {
        specifier.split('/').next().unwrap_or(specifier).to_string()
    };
    truncate_utf8(&package, 512)
}

fn build_graph(root: &Path) -> GraphData {
    let regex = import_regex();
    let mut imports: HashMap<String, Vec<String>> = HashMap::new();
    let mut imported_by: HashMap<String, Vec<String>> = HashMap::new();
    let mut external: HashMap<String, Vec<String>> = HashMap::new();
    let mut files_seen = 0usize;
    let mut total_bytes = 0u64;
    let mut total_edges = 0usize;
    let mut total_external_entries = 0usize;

    for entry in walk_no_links(root) {
        if files_seen >= FILE_CAP || total_bytes >= MAX_TOTAL_SOURCE_BYTES {
            break;
        }
        let Ok(entry) = entry else { continue };
        if !entry
            .file_type()
            .map(|kind| kind.is_file())
            .unwrap_or(false)
        {
            continue;
        }
        let Ok(file) = contained_file(root, entry.path()) else {
            continue;
        };
        let extension = file
            .path
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        if !SRC_EXTS.contains(&extension.as_str()) {
            continue;
        }
        files_seen += 1;
        if file.len > MAX_SOURCE_BYTES
            || total_bytes.saturating_add(file.len) > MAX_TOTAL_SOURCE_BYTES
        {
            continue;
        }
        let Ok((path, text)) = read_text_bounded(root, &file.path, MAX_SOURCE_BYTES) else {
            continue;
        };
        total_bytes += text.len() as u64;
        let Ok(node) = path_string(&path) else {
            continue;
        };
        let mut dependencies = Vec::new();
        let mut external_packages = Vec::new();

        for capture in regex.captures_iter(&text).take(MAX_IMPORTS_PER_FILE) {
            let Some(specifier) = capture.get(1).map(|value| value.as_str()) else {
                continue;
            };
            if total_edges >= MAX_GRAPH_EDGES {
                break;
            }
            if let Some(resolved) = resolve_import(&path, specifier, root) {
                let Ok(target) = path_string(&resolved) else {
                    continue;
                };
                if target != node && !dependencies.contains(&target) {
                    dependencies.push(target);
                    total_edges += 1;
                }
            } else if !specifier.starts_with('.')
                && specifier.len() <= MAX_SPECIFIER_BYTES
                && external_packages.len() < MAX_EXTERNAL_PACKAGES
                && total_external_entries < MAX_EXTERNAL_ENTRIES
            {
                let package = external_package_name(specifier);
                if !external_packages.contains(&package) {
                    external_packages.push(package);
                    total_external_entries += 1;
                }
            }
        }

        for target in &dependencies {
            imported_by
                .entry(target.clone())
                .or_default()
                .push(node.clone());
        }
        imports.insert(node.clone(), dependencies);
        if !external_packages.is_empty() {
            external.insert(node, external_packages);
        }
    }

    GraphData {
        imports,
        imported_by,
        external,
    }
}

fn cache() -> &'static Mutex<HashMap<String, Arc<GraphData>>> {
    static CACHE: OnceLock<Mutex<HashMap<String, Arc<GraphData>>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn cache_graph(root: String, graph: Arc<GraphData>) {
    let Ok(mut cache) = cache().lock() else {
        return;
    };
    if !cache.contains_key(&root) && cache.len() >= MAX_CACHED_ROOTS {
        if let Some(oldest) = cache.keys().next().cloned() {
            cache.remove(&oldest);
        }
    }
    cache.insert(root, graph);
}

fn get_or_build(root: &Path, root_key: &str) -> Arc<GraphData> {
    if let Ok(cache) = cache().lock() {
        if let Some(graph) = cache.get(root_key) {
            return graph.clone();
        }
    }
    let graph = Arc::new(build_graph(root));
    cache_graph(root_key.to_string(), graph.clone());
    graph
}

fn canonical_context(root: &str) -> Result<(PathBuf, String)> {
    let root = canonicalize_root(root)?;
    let key = path_string(&root)?;
    Ok((root, key))
}

fn find_cycles(data: &GraphData, cap: usize) -> Vec<Vec<String>> {
    let mut cycles = Vec::new();
    let mut visited = HashSet::new();
    let mut stack = Vec::new();
    let mut on_stack = HashSet::new();
    let mut nodes: Vec<String> = data.imports.keys().cloned().collect();
    nodes.sort();
    for node in &nodes {
        if cycles.len() >= cap {
            break;
        }
        if !visited.contains(node) {
            dfs_cycles(
                node,
                data,
                &mut visited,
                &mut stack,
                &mut on_stack,
                &mut cycles,
                cap,
            );
        }
    }
    cycles
}

fn dfs_cycles(
    node: &str,
    data: &GraphData,
    visited: &mut HashSet<String>,
    stack: &mut Vec<String>,
    on_stack: &mut HashSet<String>,
    cycles: &mut Vec<Vec<String>>,
    cap: usize,
) {
    if cycles.len() >= cap || stack.len() >= MAX_CYCLE_LENGTH {
        return;
    }
    visited.insert(node.to_string());
    stack.push(node.to_string());
    on_stack.insert(node.to_string());
    if let Some(dependencies) = data.imports.get(node) {
        for dependency in dependencies {
            if cycles.len() >= cap {
                break;
            }
            if on_stack.contains(dependency) {
                if let Some(position) = stack.iter().position(|entry| entry == dependency) {
                    cycles.push(stack[position..].to_vec());
                }
            } else if !visited.contains(dependency) {
                dfs_cycles(dependency, data, visited, stack, on_stack, cycles, cap);
            }
        }
    }
    stack.pop();
    on_stack.remove(node);
}

#[derive(Deserialize)]
struct RootParams {
    root: String,
}

#[derive(Deserialize)]
struct PathQuery {
    root: String,
    path: String,
}

/// RPC `graph/build`: rebuild and cache a graph under the canonical root key.
pub async fn build(params: Value) -> Result<Value> {
    let p: RootParams = serde_json::from_value(params)?;
    tokio::task::spawn_blocking(move || -> Result<Value> {
        let (root, root_key) = canonical_context(&p.root)?;
        let graph = Arc::new(build_graph(&root));
        cache_graph(root_key.clone(), graph.clone());
        let edges: usize = graph.imports.values().map(Vec::len).sum();
        Ok(json!({ "root": root_key, "files": graph.imports.len(), "edges": edges }))
    })
    .await?
}

/// RPC `graph/dependencies`: bounded files and packages imported by one contained file.
pub async fn dependencies(params: Value) -> Result<Value> {
    let p: PathQuery = serde_json::from_value(params)?;
    tokio::task::spawn_blocking(move || -> Result<Value> {
        let (root, root_key) = canonical_context(&p.root)?;
        let file = contained_file(&root, Path::new(&p.path))?;
        let key = path_string(&file.path)?;
        let graph = get_or_build(&root, &root_key);
        let dependencies: Vec<String> = graph
            .imports
            .get(&key)
            .into_iter()
            .flatten()
            .take(MAX_QUERY_RESULTS)
            .cloned()
            .collect();
        let external = graph.external.get(&key).cloned().unwrap_or_default();
        let count = dependencies.len();
        Ok(json!({
            "root": root_key,
            "path": key,
            "dependencies": dependencies,
            "external": external,
            "count": count
        }))
    })
    .await?
}

/// RPC `graph/dependents`: bounded direct importers of one contained file.
pub async fn dependents(params: Value) -> Result<Value> {
    let p: PathQuery = serde_json::from_value(params)?;
    tokio::task::spawn_blocking(move || -> Result<Value> {
        let (root, root_key) = canonical_context(&p.root)?;
        let file = contained_file(&root, Path::new(&p.path))?;
        let key = path_string(&file.path)?;
        let graph = get_or_build(&root, &root_key);
        let dependents: Vec<String> = graph
            .imported_by
            .get(&key)
            .into_iter()
            .flatten()
            .take(MAX_QUERY_RESULTS)
            .cloned()
            .collect();
        let count = dependents.len();
        Ok(json!({
            "root": root_key,
            "path": key,
            "dependents": dependents,
            "count": count
        }))
    })
    .await?
}

/// RPC `graph/impact`: bounded transitive reverse-dependency traversal.
pub async fn impact(params: Value) -> Result<Value> {
    let p: PathQuery = serde_json::from_value(params)?;
    tokio::task::spawn_blocking(move || -> Result<Value> {
        let (root, root_key) = canonical_context(&p.root)?;
        let file = contained_file(&root, Path::new(&p.path))?;
        let key = path_string(&file.path)?;
        let graph = get_or_build(&root, &root_key);
        let mut visited = HashSet::new();
        visited.insert(key.clone());
        let mut queue = VecDeque::from([key.clone()]);
        let mut impacted = Vec::new();
        while impacted.len() < MAX_QUERY_RESULTS {
            let Some(current) = queue.pop_front() else {
                break;
            };
            let Some(parents) = graph.imported_by.get(&current) else {
                continue;
            };
            for parent in parents {
                if impacted.len() >= MAX_QUERY_RESULTS {
                    break;
                }
                if visited.insert(parent.clone()) {
                    impacted.push(parent.clone());
                    queue.push_back(parent.clone());
                }
            }
        }
        let count = impacted.len();
        Ok(json!({
            "root": root_key,
            "path": key,
            "impacted": impacted,
            "count": count
        }))
    })
    .await?
}

/// RPC `graph/cycles`: bounded examples with bounded cycle lengths.
pub async fn cycles(params: Value) -> Result<Value> {
    let p: RootParams = serde_json::from_value(params)?;
    tokio::task::spawn_blocking(move || -> Result<Value> {
        let (root, root_key) = canonical_context(&p.root)?;
        let graph = get_or_build(&root, &root_key);
        let cycles = find_cycles(&graph, MAX_CYCLES);
        let count = cycles.len();
        Ok(json!({ "root": root_key, "cycles": cycles, "count": count }))
    })
    .await?
}
