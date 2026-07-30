//! Cross-platform, ignore-aware file walker (PRD Phase 50).

use anyhow::Result;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::fs_safety::{
    canonicalize_root, contained_file, path_string, walk_no_links, MAX_RETURNED_PATH_BYTES,
    MAX_WALK_FILES,
};

#[derive(Deserialize)]
struct WalkParams {
    root: String,
    #[serde(default)]
    max_results: Option<usize>,
}

/// RPC handler for `walk`: returns canonical files contained by a canonical root.
pub async fn walk(params: Value) -> Result<Value> {
    let p: WalkParams = serde_json::from_value(params)?;
    let cap = p.max_results.unwrap_or(MAX_WALK_FILES).min(MAX_WALK_FILES);

    let (root, files) = tokio::task::spawn_blocking(move || -> Result<(String, Vec<String>)> {
        let canonical_root = canonicalize_root(&p.root)?;
        let root_string = path_string(&canonical_root)?;
        let mut out = Vec::new();
        let mut returned_bytes = 0usize;

        for entry in walk_no_links(&canonical_root) {
            if out.len() >= cap || returned_bytes >= MAX_RETURNED_PATH_BYTES {
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
            let Ok(file) = contained_file(&canonical_root, entry.path()) else {
                continue;
            };
            let Ok(path) = path_string(&file.path) else {
                continue;
            };
            if returned_bytes.saturating_add(path.len()) > MAX_RETURNED_PATH_BYTES {
                break;
            }
            returned_bytes += path.len();
            out.push(path);
        }
        Ok((root_string, out))
    })
    .await??;

    let count = files.len();
    Ok(json!({ "root": root, "files": files, "count": count }))
}
