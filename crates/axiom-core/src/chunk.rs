//! Bounded semantic chunking for a file under an authorized workspace root.

use anyhow::Result;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::fs_safety::{canonicalize_root, path_string, read_text_bounded, MAX_FILE_BYTES};

const MAX_WINDOW_LINES: usize = 1_000;
const MAX_INPUT_LINES: usize = 500_000;
const MAX_CHUNKS: usize = 10_000;
const MAX_CHUNK_OUTPUT_BYTES: usize = 16 * 1024 * 1024;

#[derive(Deserialize)]
struct ChunkParams {
    root: String,
    path: String,
    #[serde(default = "default_max_lines")]
    max_lines: usize,
    #[serde(default = "default_overlap")]
    overlap: usize,
}

fn default_max_lines() -> usize {
    80
}
fn default_overlap() -> usize {
    10
}

/// RPC handler for `chunk`: window one canonical, contained file.
pub async fn chunk(params: Value) -> Result<Value> {
    let p: ChunkParams = serde_json::from_value(params)?;

    let (root, path, chunks) =
        tokio::task::spawn_blocking(move || -> Result<(String, String, Vec<Value>)> {
            let root = canonicalize_root(&p.root)?;
            let root_string = path_string(&root)?;
            let (path, text) = read_text_bounded(&root, p.path.as_ref(), MAX_FILE_BYTES)?;
            let path_string = path_string(&path)?;
            let max_lines = p.max_lines.clamp(1, MAX_WINDOW_LINES);
            let overlap = p.overlap.min(max_lines - 1);
            let step = max_lines - overlap;
            let lines: Vec<&str> = text.lines().take(MAX_INPUT_LINES).collect();
            let mut chunks = Vec::new();
            let mut returned_bytes = 0usize;
            let mut start = 0usize;

            while start < lines.len() && chunks.len() < MAX_CHUNKS {
                let end = (start + max_lines).min(lines.len());
                let chunk = lines[start..end].join("\n");
                if returned_bytes.saturating_add(chunk.len()) > MAX_CHUNK_OUTPUT_BYTES {
                    break;
                }
                returned_bytes += chunk.len();
                chunks.push(json!({
                    "index": chunks.len(),
                    "startLine": start + 1,
                    "endLine": end,
                    "text": chunk,
                }));
                if end == lines.len() {
                    break;
                }
                start += step;
            }
            Ok((root_string, path_string, chunks))
        })
        .await??;

    let count = chunks.len();
    Ok(json!({ "root": root, "path": path, "count": count, "chunks": chunks }))
}
