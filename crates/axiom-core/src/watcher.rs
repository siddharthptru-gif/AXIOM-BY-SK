//! Native filesystem watcher with canonical-root event confinement.

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;

use anyhow::{anyhow, bail, Result};
use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::fs_safety::{canonicalize_root, contained_event_path, path_string};
use crate::AppHandle;

const MAX_WATCHERS: usize = 32;
const MAX_EVENT_PATHS: usize = 256;
const MAX_EVENT_PAYLOAD_BYTES: usize = 1024 * 1024;

#[derive(Deserialize)]
struct WatchParams {
    root: String,
}

#[derive(Default)]
pub struct WatcherManager {
    watchers: Mutex<HashMap<String, RecommendedWatcher>>,
}

impl WatcherManager {
    pub fn new() -> Self {
        Self::default()
    }

    fn contains(&self, root: &str) -> bool {
        self.watchers
            .lock()
            .expect("watcher registry poisoned")
            .contains_key(root)
    }

    fn stop(&self, root: &str) -> bool {
        self.watchers
            .lock()
            .expect("watcher registry poisoned")
            .remove(root)
            .is_some()
    }
}

fn kind_label(kind: &EventKind) -> &'static str {
    match kind {
        EventKind::Create(_) => "create",
        EventKind::Modify(_) => "modify",
        EventKind::Remove(_) => "remove",
        _ => "other",
    }
}

/// RPC handler for `watch`: stream only bounded events under a canonical root.
pub async fn watch(app: AppHandle, params: Value) -> Result<Value> {
    let p: WatchParams = serde_json::from_value(params)?;
    let root = canonicalize_root(&p.root)?;
    let root_string = path_string(&root)?;
    let callback_root = root.clone();
    let callback_root_string = root_string.clone();

    let app_for_callback = app.clone();
    let runtime = tokio::runtime::Handle::current();
    let mut watcher = notify::recommended_watcher(move |result: notify::Result<Event>| {
        let Ok(event) = result else { return };
        let mut seen = HashSet::new();
        let mut paths = Vec::new();
        let mut payload_bytes = 0usize;
        for candidate in event.paths.iter().take(MAX_EVENT_PATHS) {
            let Ok(path) = contained_event_path(&callback_root, candidate) else {
                continue;
            };
            let Ok(path) = path_string(&path) else {
                continue;
            };
            if !seen.insert(path.clone()) {
                continue;
            }
            if payload_bytes.saturating_add(path.len()) > MAX_EVENT_PAYLOAD_BYTES {
                break;
            }
            payload_bytes += path.len();
            paths.push(path);
        }
        if paths.is_empty() {
            return;
        }
        let payload = json!({
            "root": callback_root_string,
            "kind": kind_label(&event.kind),
            "paths": paths
        });
        let app = app_for_callback.clone();
        runtime.spawn(async move {
            app.notify("fs/event", payload).await;
        });
    })
    .map_err(|error| anyhow!("watcher init failed: {error}"))?;

    watcher
        .watch(&root, RecursiveMode::Recursive)
        .map_err(|error| anyhow!("watch failed: {error}"))?;

    let mut watchers = app
        .watcher
        .watchers
        .lock()
        .expect("watcher registry poisoned");
    if !watchers.contains_key(&root_string) && watchers.len() >= MAX_WATCHERS {
        bail!("watcher limit of {MAX_WATCHERS} roots reached");
    }
    watchers.insert(root_string.clone(), watcher);
    drop(watchers);

    Ok(json!({ "watching": root_string }))
}

/// RPC handler for `unwatch`: stop the watcher identified by its canonical root.
pub async fn unwatch(app: AppHandle, params: Value) -> Result<Value> {
    let p: WatchParams = serde_json::from_value(params)?;
    let root = match canonicalize_root(&p.root) {
        Ok(root) => path_string(&root)?,
        Err(_error) if app.watcher.contains(&p.root) => p.root,
        Err(error) => return Err(error),
    };
    let stopped = app.watcher.stop(&root);
    Ok(json!({ "unwatched": root, "stopped": stopped }))
}
