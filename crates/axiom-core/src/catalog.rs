//! Bounded SQLite file catalog tied to one canonical workspace root.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use anyhow::{anyhow, bail, Result};
use rusqlite::{Connection, OptionalExtension};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::fs_safety::{
    canonical_database_path, canonicalize_root, contained_file, path_string, truncate_utf8,
    walk_no_links, MAX_WALK_FILES,
};

const MAX_QUERY_RESULTS: usize = 1_000;
const MAX_QUERY_SCAN: usize = 10_000;
const MAX_PATTERN_BYTES: usize = 4 * 1024;

#[derive(Deserialize)]
struct RebuildParams {
    root: String,
    db: String,
}

#[derive(Deserialize)]
struct StatsParams {
    db: String,
}

#[derive(Deserialize)]
struct QueryParams {
    db: String,
    #[serde(default)]
    pattern: Option<String>,
    #[serde(default)]
    limit: Option<usize>,
}

fn open(db: &Path) -> Result<Connection> {
    let connection = Connection::open(db)?;
    connection.execute_batch(
        "PRAGMA journal_mode=WAL;
         CREATE TABLE IF NOT EXISTS files (
            path  TEXT PRIMARY KEY,
            ext   TEXT NOT NULL,
            size  INTEGER NOT NULL,
            mtime INTEGER NOT NULL
         );
         CREATE INDEX IF NOT EXISTS idx_files_ext ON files(ext);
         CREATE TABLE IF NOT EXISTS catalog_meta (
            key   TEXT PRIMARY KEY,
            value TEXT NOT NULL
         );",
    )?;
    Ok(connection)
}

fn catalog_root(connection: &Connection) -> Result<PathBuf> {
    let stored: Option<String> = connection
        .query_row(
            "SELECT value FROM catalog_meta WHERE key = 'root'",
            [],
            |row| row.get(0),
        )
        .optional()?;
    let stored = stored.ok_or_else(|| anyhow!("catalog has no authorized root; rebuild it"))?;
    canonicalize_root(stored)
}

/// RPC handler for `catalog/rebuild`: repopulate from a bounded, no-link walk.
pub async fn rebuild(params: Value) -> Result<Value> {
    let p: RebuildParams = serde_json::from_value(params)?;
    tokio::task::spawn_blocking(move || -> Result<Value> {
        let root = canonicalize_root(&p.root)?;
        let root_string = path_string(&root)?;
        let db = canonical_database_path(Path::new(&p.db))?;
        let db_string = path_string(&db)?;
        let mut connection = open(&db)?;
        let transaction = connection.transaction()?;
        transaction.execute("DELETE FROM files", [])?;
        transaction.execute(
            "INSERT OR REPLACE INTO catalog_meta (key, value) VALUES ('root', ?1)",
            [&root_string],
        )?;

        let mut indexed = 0usize;
        {
            let mut statement = transaction.prepare(
                "INSERT OR REPLACE INTO files (path, ext, size, mtime) VALUES (?1, ?2, ?3, ?4)",
            )?;
            for entry in walk_no_links(&root) {
                if indexed >= MAX_WALK_FILES {
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
                let Ok(file) = contained_file(&root, entry.path()) else {
                    continue;
                };
                if file.path == db {
                    continue;
                }
                let Ok(metadata) = fs::symlink_metadata(&file.path) else {
                    continue;
                };
                let size = i64::try_from(file.len).unwrap_or(i64::MAX);
                let mtime = metadata
                    .modified()
                    .ok()
                    .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                    .and_then(|duration| i64::try_from(duration.as_secs()).ok())
                    .unwrap_or(0);
                let extension = file
                    .path
                    .extension()
                    .and_then(|value| value.to_str())
                    .map(|value| truncate_utf8(value, 64))
                    .unwrap_or_default();
                let path = path_string(&file.path)?;
                statement.execute(rusqlite::params![path, extension, size, mtime])?;
                indexed += 1;
            }
        }
        transaction.commit()?;
        Ok(json!({ "root": root_string, "db": db_string, "indexed": indexed }))
    })
    .await?
}

/// RPC handler for `catalog/stats`: bounded aggregate data for an authorized catalog.
pub async fn stats(params: Value) -> Result<Value> {
    let p: StatsParams = serde_json::from_value(params)?;
    tokio::task::spawn_blocking(move || -> Result<Value> {
        let db = canonical_database_path(Path::new(&p.db))?;
        let connection = open(&db)?;
        let root = catalog_root(&connection)?;
        let root = path_string(&root)?;
        let files: i64 =
            connection.query_row("SELECT COUNT(*) FROM files", [], |row| row.get(0))?;
        let bytes: i64 =
            connection.query_row("SELECT COALESCE(SUM(size), 0) FROM files", [], |row| {
                row.get(0)
            })?;
        let mut statement = connection.prepare(
            "SELECT ext, COUNT(*) AS count FROM files GROUP BY ext ORDER BY count DESC LIMIT 20",
        )?;
        let by_extension: Vec<Value> = statement
            .query_map([], |row| {
                let extension: String = row.get(0)?;
                Ok(json!({
                    "ext": truncate_utf8(&extension, 64),
                    "count": row.get::<_, i64>(1)?
                }))
            })?
            .filter_map(|row| row.ok())
            .collect();
        Ok(json!({ "root": root, "files": files, "bytes": bytes, "byExt": by_extension }))
    })
    .await?
}

/// RPC handler for `catalog/query`: return only live canonical files under the stored root.
pub async fn query(params: Value) -> Result<Value> {
    let p: QueryParams = serde_json::from_value(params)?;
    tokio::task::spawn_blocking(move || -> Result<Value> {
        let db = canonical_database_path(Path::new(&p.db))?;
        let connection = open(&db)?;
        let root = catalog_root(&connection)?;
        let root_string = path_string(&root)?;
        let pattern = p.pattern.unwrap_or_else(|| "%".to_string());
        if pattern.len() > MAX_PATTERN_BYTES {
            bail!("catalog pattern exceeds the {MAX_PATTERN_BYTES}-byte safety limit");
        }
        let limit = p.limit.unwrap_or(200).min(MAX_QUERY_RESULTS);
        let scan_limit = if limit == 0 { 0 } else { MAX_QUERY_SCAN };
        let mut statement = connection.prepare(
            "SELECT path, ext, size, mtime FROM files WHERE path LIKE ?1 ORDER BY path LIMIT ?2",
        )?;
        let mut rows = statement.query(rusqlite::params![pattern, scan_limit as i64])?;
        let mut files = Vec::with_capacity(limit);
        while files.len() < limit {
            let Some(row) = rows.next()? else { break };
            let stored_path: String = row.get(0)?;
            let Ok(file) = contained_file(&root, Path::new(&stored_path)) else {
                continue;
            };
            files.push(json!({
                "path": path_string(&file.path)?,
                "ext": truncate_utf8(&row.get::<_, String>(1)?, 64),
                "size": row.get::<_, i64>(2)?,
                "mtime": row.get::<_, i64>(3)?,
            }));
        }
        let count = files.len();
        Ok(json!({ "root": root_string, "count": count, "files": files }))
    })
    .await?
}
