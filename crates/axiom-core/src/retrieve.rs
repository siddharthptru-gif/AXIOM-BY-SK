//! Bounded baseline semantic retrieval over canonical workspace files.

use std::cmp::Ordering;

use anyhow::{bail, Result};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::embed::{cosine, embed_text, DEFAULT_DIM};
use crate::fs_safety::{
    canonicalize_root, contained_file, path_string, read_text_bounded, walk_no_links,
};

const MAX_QUERY_BYTES: usize = 16 * 1024;
const MAX_TOP_K: usize = 100;
const MAX_DIM: usize = 4_096;
const MAX_WINDOW_LINES: usize = 500;
const MAX_RETRIEVE_FILES: usize = 20_000;
const MAX_RETRIEVE_FILE_BYTES: u64 = 4 * 1024 * 1024;
const MAX_RETRIEVE_TOTAL_BYTES: u64 = 128 * 1024 * 1024;
const MAX_LINES_PER_FILE: usize = 200_000;
const MAX_CHUNKS: usize = 200_000;

#[derive(Deserialize)]
struct RetrieveParams {
    root: String,
    query: String,
    #[serde(default)]
    top_k: Option<usize>,
    #[serde(default)]
    max_lines: Option<usize>,
    #[serde(default)]
    dim: Option<usize>,
}

struct Hit {
    score: f32,
    path: String,
    start: usize,
    end: usize,
    preview: String,
}

fn retain_hit(hits: &mut Vec<Hit>, hit: Hit, top_k: usize) {
    if hits.len() < top_k {
        hits.push(hit);
        return;
    }
    let (lowest_index, lowest) = hits
        .iter()
        .enumerate()
        .min_by(|(_, left), (_, right)| {
            left.score
                .partial_cmp(&right.score)
                .unwrap_or(Ordering::Equal)
        })
        .expect("top-k hit set is non-empty");
    if hit.score > lowest.score {
        hits[lowest_index] = hit;
    }
}

/// RPC handler for `retrieve`: rank workspace chunks by similarity to `query`.
pub async fn retrieve(params: Value) -> Result<Value> {
    let p: RetrieveParams = serde_json::from_value(params)?;
    if p.query.len() > MAX_QUERY_BYTES {
        bail!("retrieval query exceeds the {MAX_QUERY_BYTES}-byte safety limit");
    }
    let query = p.query.clone();

    let (root, mut hits) = tokio::task::spawn_blocking(move || -> Result<(String, Vec<Hit>)> {
        let canonical_root = canonicalize_root(&p.root)?;
        let root_string = path_string(&canonical_root)?;
        let dim = p.dim.unwrap_or(DEFAULT_DIM).clamp(1, MAX_DIM);
        let top_k = p.top_k.unwrap_or(10).clamp(1, MAX_TOP_K);
        let window = p.max_lines.unwrap_or(60).clamp(1, MAX_WINDOW_LINES);
        let query_vector = embed_text(&p.query, dim);

        let mut hits = Vec::with_capacity(top_k);
        let mut files_seen = 0usize;
        let mut total_bytes = 0u64;
        let mut chunks_seen = 0usize;

        'files: for entry in walk_no_links(&canonical_root) {
            if files_seen >= MAX_RETRIEVE_FILES
                || total_bytes >= MAX_RETRIEVE_TOTAL_BYTES
                || chunks_seen >= MAX_CHUNKS
            {
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
            files_seen += 1;
            let Ok(file) = contained_file(&canonical_root, entry.path()) else {
                continue;
            };
            if file.len > MAX_RETRIEVE_FILE_BYTES
                || total_bytes.saturating_add(file.len) > MAX_RETRIEVE_TOTAL_BYTES
            {
                continue;
            }
            let Ok((path, text)) =
                read_text_bounded(&canonical_root, &file.path, MAX_RETRIEVE_FILE_BYTES)
            else {
                continue;
            };
            total_bytes += text.len() as u64;
            let lines: Vec<&str> = text.lines().take(MAX_LINES_PER_FILE).collect();
            if lines.is_empty() {
                continue;
            }
            let path = path_string(&path)?;

            let mut start = 0usize;
            while start < lines.len() {
                if chunks_seen >= MAX_CHUNKS {
                    break 'files;
                }
                let end = (start + window).min(lines.len());
                let chunk = lines[start..end].join("\n");
                let score = cosine(&query_vector, &embed_text(&chunk, dim));
                retain_hit(
                    &mut hits,
                    Hit {
                        score,
                        path: path.clone(),
                        start: start + 1,
                        end,
                        preview: chunk.chars().take(240).collect(),
                    },
                    top_k,
                );
                chunks_seen += 1;
                if end == lines.len() {
                    break;
                }
                start = end;
            }
        }
        Ok((root_string, hits))
    })
    .await??;

    hits.sort_by(|left, right| {
        right
            .score
            .partial_cmp(&left.score)
            .unwrap_or(Ordering::Equal)
    });
    let results: Vec<Value> = hits
        .iter()
        .map(|hit| {
            json!({
                "path": hit.path,
                "startLine": hit.start,
                "endLine": hit.end,
                "score": hit.score,
                "preview": hit.preview,
            })
        })
        .collect();
    let count = results.len();
    Ok(json!({ "root": root, "query": query, "count": count, "results": results }))
}
