//! Bounded regex full-text search over canonical, contained workspace files.

use anyhow::{bail, Result};
use grep_regex::RegexMatcherBuilder;
use grep_searcher::sinks::UTF8;
use grep_searcher::Searcher;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::fs_safety::{
    canonicalize_root, contained_file, path_string, truncate_utf8, walk_no_links, MAX_FILE_BYTES,
    MAX_TOTAL_READ_BYTES, MAX_WALK_FILES,
};

const MAX_SEARCH_RESULTS: usize = 5_000;
const MAX_QUERY_BYTES: usize = 16 * 1024;
const MAX_MATCH_TEXT_BYTES: usize = 4 * 1024;
const MAX_SEARCH_OUTPUT_BYTES: usize = 16 * 1024 * 1024;

#[derive(Deserialize)]
struct SearchParams {
    root: String,
    query: String,
    #[serde(default)]
    case_sensitive: bool,
    #[serde(default)]
    max_results: Option<usize>,
}

/// RPC handler for `search`: regex full-text search across the workspace.
pub async fn search(params: Value) -> Result<Value> {
    let p: SearchParams = serde_json::from_value(params)?;
    if p.query.len() > MAX_QUERY_BYTES {
        bail!("search query exceeds the {MAX_QUERY_BYTES}-byte safety limit");
    }
    let query = p.query.clone();

    let (root, matches) = tokio::task::spawn_blocking(move || -> Result<(String, Vec<Value>)> {
        let canonical_root = canonicalize_root(&p.root)?;
        let root_string = path_string(&canonical_root)?;
        let matcher = RegexMatcherBuilder::new()
            .case_insensitive(!p.case_sensitive)
            .build(&p.query)?;
        let cap = p.max_results.unwrap_or(2_000).min(MAX_SEARCH_RESULTS);
        let mut results = Vec::new();
        let mut searcher = Searcher::new();
        let mut files_seen = 0usize;
        let mut scanned_bytes = 0u64;
        let mut output_bytes = 0usize;

        for entry in walk_no_links(&canonical_root) {
            if results.len() >= cap
                || files_seen >= MAX_WALK_FILES
                || scanned_bytes >= MAX_TOTAL_READ_BYTES
                || output_bytes >= MAX_SEARCH_OUTPUT_BYTES
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
            if file.len > MAX_FILE_BYTES
                || scanned_bytes.saturating_add(file.len) > MAX_TOTAL_READ_BYTES
            {
                continue;
            }
            scanned_bytes += file.len;
            let Ok(path) = path_string(&file.path) else {
                continue;
            };
            let mut output_exhausted = false;

            // Binary/non-UTF-8 files and races are skipped; the validated path,
            // per-file size, aggregate bytes, and output are all independently capped.
            let _ = searcher.search_path(
                &matcher,
                &file.path,
                UTF8(|line_number, line| {
                    let text = truncate_utf8(line.trim_end(), MAX_MATCH_TEXT_BYTES);
                    let added = path.len().saturating_add(text.len()).saturating_add(32);
                    if output_bytes.saturating_add(added) > MAX_SEARCH_OUTPUT_BYTES {
                        output_exhausted = true;
                        return Ok(false);
                    }
                    output_bytes += added;
                    results.push(json!({
                        "path": path.clone(),
                        "line": line_number,
                        "text": text,
                    }));
                    Ok(results.len() < cap)
                }),
            );
            if output_exhausted {
                break;
            }
        }
        Ok((root_string, results))
    })
    .await??;

    let count = matches.len();
    Ok(json!({ "root": root, "query": query, "matches": matches, "count": count }))
}
