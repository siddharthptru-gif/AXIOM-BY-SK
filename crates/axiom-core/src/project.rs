//! Automatic, bounded project understanding over a canonical workspace root.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Component, Path, PathBuf};

use anyhow::Result;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::fs_safety::{
    canonicalize_root, contained_file, path_string, read_text_bounded, truncate_utf8,
    walk_no_links, MAX_WALK_FILES,
};

const PACKAGE_FILE_CAP: usize = 500;
const MANIFEST_BYTES: u64 = 2 * 1024 * 1024;
const TOTAL_MANIFEST_BYTES: usize = 32 * 1024 * 1024;
const DEPENDENCY_CAP: usize = 50_000;
const SCRIPT_CAP: usize = 100;
const SCRIPT_OUTPUT_BYTES: usize = 512 * 1024;
const ENTRY_POINT_CAP: usize = 100;
const WORKSPACE_CAP: usize = 200;

const JS_FRAMEWORKS: &[(&str, &str)] = &[
    ("next", "Next.js"),
    ("react", "React"),
    ("vue", "Vue"),
    ("svelte", "Svelte"),
    ("@angular/core", "Angular"),
    ("solid-js", "SolidJS"),
    ("preact", "Preact"),
    ("express", "Express"),
    ("fastify", "Fastify"),
    ("koa", "Koa"),
    ("@nestjs/core", "NestJS"),
    ("electron", "Electron"),
    ("electron-vite", "electron-vite"),
    ("vite", "Vite"),
    ("webpack", "Webpack"),
    ("tailwindcss", "Tailwind CSS"),
    ("monaco-editor", "Monaco Editor"),
    ("@supabase/supabase-js", "Supabase"),
];

const JS_TEST: &[(&str, &str)] = &[
    ("vitest", "Vitest"),
    ("jest", "Jest"),
    ("mocha", "Mocha"),
    ("@playwright/test", "Playwright"),
    ("cypress", "Cypress"),
    ("ava", "AVA"),
    ("jasmine", "Jasmine"),
];

fn ext_to_lang(ext: &str) -> Option<&'static str> {
    match ext {
        "ts" | "mts" | "cts" => Some("TypeScript"),
        "tsx" => Some("TypeScript (JSX)"),
        "js" | "mjs" | "cjs" => Some("JavaScript"),
        "jsx" => Some("JavaScript (JSX)"),
        "rs" => Some("Rust"),
        "py" | "pyi" => Some("Python"),
        "go" => Some("Go"),
        "java" => Some("Java"),
        "kt" => Some("Kotlin"),
        "rb" => Some("Ruby"),
        "php" => Some("PHP"),
        "c" | "h" => Some("C"),
        "cpp" | "cc" | "hpp" => Some("C++"),
        "cs" => Some("C#"),
        "swift" => Some("Swift"),
        "css" | "scss" | "less" => Some("CSS"),
        "html" | "htm" => Some("HTML"),
        "json" => Some("JSON"),
        "md" | "markdown" => Some("Markdown"),
        "sh" | "bash" => Some("Shell"),
        "yml" | "yaml" => Some("YAML"),
        "toml" => Some("TOML"),
        _ => None,
    }
}

#[derive(Deserialize)]
struct RootParams {
    root: String,
}

fn safe_workspace_pattern(pattern: &str) -> bool {
    !pattern.is_empty()
        && pattern.len() <= 1_024
        && !Path::new(pattern).is_absolute()
        && !Path::new(pattern).components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
}

fn add_entry_point(root: &Path, candidate: &str, entries: &mut Vec<String>) {
    if entries.len() >= ENTRY_POINT_CAP || candidate.len() > 1_024 {
        return;
    }
    let Ok(file) = contained_file(root, Path::new(candidate)) else {
        return;
    };
    let Ok(path) = path_string(&file.path) else {
        return;
    };
    if !entries.contains(&path) {
        entries.push(path);
    }
}

/// RPC `project/understand`: derive a bounded project profile.
pub async fn understand(params: Value) -> Result<Value> {
    let p: RootParams = serde_json::from_value(params)?;
    tokio::task::spawn_blocking(move || -> Result<Value> {
        let root = canonicalize_root(&p.root)?;
        build_profile(&root)
    })
    .await?
}

fn build_profile(root: &Path) -> Result<Value> {
    let root_string = path_string(root)?;
    let mut language_counts: BTreeMap<&'static str, usize> = BTreeMap::new();
    let mut total_files = 0usize;
    let mut package_paths: Vec<PathBuf> = Vec::new();

    for entry in walk_no_links(root) {
        if total_files >= MAX_WALK_FILES {
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
        total_files += 1;
        if file.path.file_name().and_then(|name| name.to_str()) == Some("package.json")
            && package_paths.len() < PACKAGE_FILE_CAP
        {
            package_paths.push(file.path.clone());
        }
        if let Some(extension) = file.path.extension().and_then(|value| value.to_str()) {
            if let Some(language) = ext_to_lang(&extension.to_ascii_lowercase()) {
                *language_counts.entry(language).or_insert(0) += 1;
            }
        }
    }
    let mut languages: Vec<(&'static str, usize)> = language_counts.into_iter().collect();
    languages.sort_by(|left, right| right.1.cmp(&left.1).then(left.0.cmp(right.0)));
    languages.truncate(12);

    let has = |candidate: &str| contained_file(root, Path::new(candidate)).is_ok();
    let mut package_managers = Vec::new();
    if has("pnpm-lock.yaml") {
        package_managers.push("pnpm");
    }
    if has("yarn.lock") {
        package_managers.push("yarn");
    }
    if has("bun.lockb") {
        package_managers.push("bun");
    }
    if has("package-lock.json") {
        package_managers.push("npm");
    }
    if has("Cargo.toml") {
        package_managers.push("cargo");
    }
    if has("go.mod") {
        package_managers.push("go modules");
    }
    if has("requirements.txt") || has("pyproject.toml") || has("Pipfile") {
        package_managers.push("pip/poetry");
    }

    let mut dependencies = BTreeSet::new();
    let mut manifest_bytes = 0usize;
    for package_path in &package_paths {
        if manifest_bytes >= TOTAL_MANIFEST_BYTES || dependencies.len() >= DEPENDENCY_CAP {
            break;
        }
        let Ok((_, text)) = read_text_bounded(root, package_path, MANIFEST_BYTES) else {
            continue;
        };
        if manifest_bytes.saturating_add(text.len()) > TOTAL_MANIFEST_BYTES {
            break;
        }
        manifest_bytes += text.len();
        let Ok(package) = serde_json::from_str::<Value>(&text) else {
            continue;
        };
        for key in ["dependencies", "devDependencies", "peerDependencies"] {
            let Some(object) = package.get(key).and_then(Value::as_object) else {
                continue;
            };
            for dependency in object.keys() {
                if dependencies.len() >= DEPENDENCY_CAP {
                    break;
                }
                dependencies.insert(truncate_utf8(dependency, 512));
            }
        }
    }

    let frameworks: Vec<String> = JS_FRAMEWORKS
        .iter()
        .filter(|(dependency, _)| dependencies.contains(*dependency))
        .map(|(_, display)| (*display).to_string())
        .collect();
    let test_framework = JS_TEST
        .iter()
        .find(|(dependency, _)| dependencies.contains(*dependency))
        .map(|(_, display)| (*display).to_string());

    let mut scripts = Vec::new();
    let mut script_bytes = 0usize;
    let mut entry_points = Vec::new();
    let mut monorepo = false;
    let mut workspaces = Vec::new();
    let mut name = None;

    if let Ok((_, text)) = read_text_bounded(root, Path::new("package.json"), MANIFEST_BYTES) {
        if let Ok(package) = serde_json::from_str::<Value>(&text) {
            name = package
                .get("name")
                .and_then(Value::as_str)
                .map(|value| truncate_utf8(value, 256));
            if let Some(object) = package.get("scripts").and_then(Value::as_object) {
                for (script_name, value) in object {
                    let Some(command) = value.as_str() else {
                        continue;
                    };
                    let script_name = truncate_utf8(script_name, 256);
                    let command = truncate_utf8(command, 4_096);
                    let added = script_name.len().saturating_add(command.len());
                    if scripts.len() >= SCRIPT_CAP
                        || script_bytes.saturating_add(added) > SCRIPT_OUTPUT_BYTES
                    {
                        break;
                    }
                    script_bytes += added;
                    scripts.push(json!({ "name": script_name, "command": command }));
                }
            }
            for key in ["main", "module"] {
                if let Some(candidate) = package.get(key).and_then(Value::as_str) {
                    add_entry_point(root, candidate, &mut entry_points);
                }
            }
            let workspace_values = match package.get("workspaces") {
                Some(Value::Array(values)) => Some(values),
                Some(Value::Object(object)) => object.get("packages").and_then(Value::as_array),
                _ => None,
            };
            if let Some(values) = workspace_values {
                monorepo = true;
                for value in values {
                    let Some(pattern) = value.as_str() else {
                        continue;
                    };
                    if workspaces.len() >= WORKSPACE_CAP {
                        break;
                    }
                    if safe_workspace_pattern(pattern) {
                        workspaces.push(pattern.to_string());
                    }
                }
            }
        }
    }

    if has("pnpm-workspace.yaml") {
        monorepo = true;
    }
    if let Ok((_, cargo)) = read_text_bounded(root, Path::new("Cargo.toml"), MANIFEST_BYTES) {
        if cargo.contains("[workspace]") {
            monorepo = true;
        }
    }

    for candidate in [
        "src/index.ts",
        "src/main.ts",
        "src/main.tsx",
        "src/index.tsx",
        "src/index.js",
        "src/main.rs",
        "main.py",
        "app.py",
        "cmd/main.go",
    ] {
        add_entry_point(root, candidate, &mut entry_points);
    }

    let languages: Vec<Value> = languages
        .iter()
        .map(|(name, files)| json!({ "name": name, "files": files }))
        .collect();

    Ok(json!({
        "root": root_string,
        "name": name,
        "totalFiles": total_files,
        "languages": languages,
        "packageManagers": package_managers,
        "frameworks": frameworks,
        "testFramework": test_framework,
        "scripts": scripts,
        "entryPoints": entry_points,
        "monorepo": monorepo,
        "workspaces": workspaces,
    }))
}
