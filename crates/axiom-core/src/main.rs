//! Axiom Rust Core sidecar (PRD Epoch C). A supervised child process that speaks
//! newline-delimited JSON-RPC over stdio with the Electron Main process. This
//! hosts file walking, search, semantic chunking, and a native filesystem
//! watcher; Tree-sitter symbols, the SQLite catalog, embeddings, and the
//! vector/knowledge graph are layered on in later phases.

mod catalog;
mod chunk;
mod embed;
mod fs_safety;
mod graph;
mod project;
mod retrieve;
mod rpc;
mod search;
mod symbols;
mod walker;
mod watcher;

use std::sync::Arc;

use anyhow::Result;
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::Mutex;

use rpc::{Notification, Request, Response, INTERNAL_ERROR, METHOD_NOT_FOUND};
use watcher::WatcherManager;

/// Shared, serialized handle to stdout so responses/notifications never interleave.
type Writer = Arc<Mutex<tokio::io::Stdout>>;

const PROTOCOL_VERSION: u32 = 1;

/// Process-wide state shared (via `Arc`) across every per-request task.
pub struct App {
    out: Writer,
    pub watcher: WatcherManager,
}

/// Cheap-to-clone shared handle to the [`App`].
pub type AppHandle = Arc<App>;

impl App {
    /// Emit a server-initiated notification (no `id`, no response expected).
    pub async fn notify(&self, method: &str, params: Value) {
        let note = Notification {
            method: method.to_string(),
            params,
        };
        write_json(&self.out, &note).await;
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_writer(std::io::stderr)
        .with_max_level(tracing::Level::INFO)
        .init();
    tracing::info!("axiom-core {} starting", env!("CARGO_PKG_VERSION"));

    let app: AppHandle = Arc::new(App {
        out: Arc::new(Mutex::new(tokio::io::stdout())),
        watcher: WatcherManager::new(),
    });
    let mut lines = BufReader::new(tokio::io::stdin()).lines();

    // Requests run on their own tasks so long operations (walk/search) never
    // block reading the next line. We track them in a JoinSet so that when stdin
    // closes we can drain in-flight work and flush every response before exit,
    // rather than dropping pending replies on the floor.
    let mut tasks = tokio::task::JoinSet::new();
    while let Some(line) = lines.next_line().await? {
        let trimmed = line.trim().to_string();
        if trimmed.is_empty() {
            continue;
        }
        let app = app.clone();
        tasks.spawn(async move {
            handle_line(trimmed, app).await;
        });
        // Reap finished handlers eagerly to bound the set's memory.
        while tasks.try_join_next().is_some() {}
    }

    // Graceful shutdown: let outstanding handlers finish writing their responses.
    while tasks.join_next().await.is_some() {}
    Ok(())
}

async fn handle_line(line: String, app: AppHandle) {
    let req: Request = match serde_json::from_str(&line) {
        Ok(r) => r,
        Err(e) => {
            tracing::warn!("invalid request: {e}");
            return;
        }
    };
    let is_notification = req.id.is_none();
    let id = req.id.clone().unwrap_or(Value::Null);

    let response = match dispatch(&app, &req.method, req.params).await {
        Ok(result) => Response::ok(id, result),
        Err(e) => {
            let code = if e.to_string().starts_with("unknown method") {
                METHOD_NOT_FOUND
            } else {
                INTERNAL_ERROR
            };
            Response::err(id, code, e.to_string())
        }
    };

    if is_notification {
        return;
    }
    write_json(&app.out, &response).await;
}

async fn dispatch(app: &AppHandle, method: &str, params: Value) -> Result<Value> {
    match method {
        "initialize" => Ok(json!({
            "name": "axiom-core",
            "version": env!("CARGO_PKG_VERSION"),
            "protocol": PROTOCOL_VERSION,
        })),
        "ping" => Ok(json!({ "pong": true })),
        "walk" => walker::walk(params).await,
        "search" => search::search(params).await,
        "chunk" => chunk::chunk(params).await,
        "symbols" => symbols::symbols(params).await,
        "embed" => embed::embed(params).await,
        "retrieve" => retrieve::retrieve(params).await,
        "graph/build" => graph::build(params).await,
        "graph/dependencies" => graph::dependencies(params).await,
        "graph/dependents" => graph::dependents(params).await,
        "graph/impact" => graph::impact(params).await,
        "graph/cycles" => graph::cycles(params).await,
        "project/understand" => project::understand(params).await,
        "catalog/rebuild" => catalog::rebuild(params).await,
        "catalog/stats" => catalog::stats(params).await,
        "catalog/query" => catalog::query(params).await,
        "watch" => watcher::watch(app.clone(), params).await,
        "unwatch" => watcher::unwatch(app.clone(), params).await,
        other => Err(anyhow::anyhow!("unknown method: {other}")),
    }
}

async fn write_json<T: serde::Serialize>(out: &Writer, msg: &T) {
    match serde_json::to_string(msg) {
        Ok(mut s) => {
            s.push('\n');
            let mut w = out.lock().await;
            if w.write_all(s.as_bytes()).await.is_err() {
                return;
            }
            let _ = w.flush().await;
        }
        Err(e) => tracing::warn!("serialize failed: {e}"),
    }
}
