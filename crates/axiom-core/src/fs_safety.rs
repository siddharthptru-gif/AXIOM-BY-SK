use std::fs::{self, Metadata};
use std::path::{Component, Path, PathBuf};

use anyhow::{anyhow, bail, Context, Result};
use ignore::{Walk, WalkBuilder};

pub const MAX_PATH_BYTES: usize = 32 * 1024;
pub const MAX_FILE_BYTES: u64 = 8 * 1024 * 1024;
pub const MAX_TOTAL_READ_BYTES: u64 = 256 * 1024 * 1024;
pub const MAX_WALK_FILES: usize = 100_000;
pub const MAX_RETURNED_PATH_BYTES: usize = 16 * 1024 * 1024;

#[derive(Debug)]
pub struct SafeFile {
    pub path: PathBuf,
    pub len: u64,
}

fn is_link_or_reparse(metadata: &Metadata) -> bool {
    if metadata.file_type().is_symlink() {
        return true;
    }

    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;
        return metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0;
    }

    #[cfg(not(windows))]
    false
}

fn validate_path_size(path: &Path) -> Result<()> {
    if path.to_string_lossy().len() > MAX_PATH_BYTES {
        bail!("path exceeds the {MAX_PATH_BYTES}-byte safety limit");
    }
    Ok(())
}

fn normalize_absolute(path: &Path) -> Result<PathBuf> {
    if !path.is_absolute() {
        bail!("path must resolve to an absolute path");
    }

    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                if !normalized.pop() || !normalized.is_absolute() {
                    bail!("path escapes the filesystem root");
                }
            }
            other => normalized.push(other.as_os_str()),
        }
    }
    Ok(normalized)
}

#[cfg(windows)]
fn windows_component_key(component: Component<'_>) -> String {
    let value = component.as_os_str().to_string_lossy();
    if let Some(rest) = value.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{rest}")
    } else if let Some(rest) = value.strip_prefix(r"\\?\") {
        rest.to_string()
    } else {
        value.into_owned()
    }
}

#[cfg(windows)]
fn component_eq(left: Component<'_>, right: Component<'_>) -> bool {
    windows_component_key(left).eq_ignore_ascii_case(&windows_component_key(right))
}

#[cfg(not(windows))]
fn component_eq(left: Component<'_>, right: Component<'_>) -> bool {
    left == right
}

fn relative_to_root(root: &Path, candidate: &Path) -> Option<PathBuf> {
    let mut candidate_components = candidate.components();
    for root_component in root.components() {
        let candidate_component = candidate_components.next()?;
        if !component_eq(root_component, candidate_component) {
            return None;
        }
    }

    let mut relative = PathBuf::new();
    for component in candidate_components {
        match component {
            Component::Normal(_) => relative.push(component.as_os_str()),
            Component::CurDir => {}
            _ => return None,
        }
    }
    Some(relative)
}

fn reject_link_components(root: &Path, relative: &Path) -> Result<()> {
    let mut current = root.to_path_buf();
    for component in relative.components() {
        let Component::Normal(part) = component else {
            bail!("candidate contains an invalid path component");
        };
        current.push(part);
        let metadata = fs::symlink_metadata(&current)
            .with_context(|| format!("inspect candidate component {}", current.display()))?;
        if is_link_or_reparse(&metadata) {
            bail!(
                "symlink or reparse-point candidate rejected: {}",
                current.display()
            );
        }
    }
    Ok(())
}

pub fn canonicalize_root(root: impl AsRef<Path>) -> Result<PathBuf> {
    let root = root.as_ref();
    validate_path_size(root)?;
    let canonical = fs::canonicalize(root)
        .with_context(|| format!("canonicalize workspace root {}", root.display()))?;
    validate_path_size(&canonical)?;
    let metadata = fs::symlink_metadata(&canonical)
        .with_context(|| format!("inspect workspace root {}", canonical.display()))?;
    if is_link_or_reparse(&metadata) || !metadata.file_type().is_dir() {
        bail!(
            "workspace root is not a real directory: {}",
            canonical.display()
        );
    }
    Ok(canonical)
}

fn contained_existing(root: &Path, candidate: &Path) -> Result<(PathBuf, Metadata)> {
    validate_path_size(candidate)?;
    let joined = if candidate.is_absolute() {
        candidate.to_path_buf()
    } else {
        root.join(candidate)
    };
    let normalized = normalize_absolute(&joined)?;
    validate_path_size(&normalized)?;

    let relative = relative_to_root(root, &normalized).ok_or_else(|| {
        anyhow!(
            "candidate escapes canonical workspace root: {}",
            normalized.display()
        )
    })?;
    reject_link_components(root, &relative)?;

    let canonical = fs::canonicalize(&normalized)
        .with_context(|| format!("canonicalize candidate {}", normalized.display()))?;
    validate_path_size(&canonical)?;
    let canonical_relative = relative_to_root(root, &canonical).ok_or_else(|| {
        anyhow!(
            "candidate resolves outside canonical workspace root: {}",
            canonical.display()
        )
    })?;
    reject_link_components(root, &canonical_relative)?;

    let metadata = fs::symlink_metadata(&canonical)
        .with_context(|| format!("inspect candidate {}", canonical.display()))?;
    if is_link_or_reparse(&metadata) {
        bail!(
            "symlink or reparse-point candidate rejected: {}",
            canonical.display()
        );
    }
    Ok((canonical, metadata))
}

pub fn contained_file(root: &Path, candidate: &Path) -> Result<SafeFile> {
    let (path, metadata) = contained_existing(root, candidate)?;
    if !metadata.file_type().is_file() {
        bail!("candidate is not a regular file: {}", path.display());
    }
    Ok(SafeFile {
        path,
        len: metadata.len(),
    })
}

pub fn read_file_bounded(
    root: &Path,
    candidate: &Path,
    max_bytes: u64,
) -> Result<(PathBuf, Vec<u8>)> {
    let file = contained_file(root, candidate)?;
    if file.len > max_bytes {
        bail!(
            "file exceeds the {max_bytes}-byte safety limit: {}",
            file.path.display()
        );
    }

    let bytes = fs::read(&file.path)
        .with_context(|| format!("read contained file {}", file.path.display()))?;
    if bytes.len() as u64 > max_bytes {
        bail!(
            "file grew beyond the {max_bytes}-byte safety limit while reading: {}",
            file.path.display()
        );
    }

    let after = contained_file(root, &file.path)?;
    if after.path != file.path {
        bail!(
            "file changed identity while reading: {}",
            file.path.display()
        );
    }
    Ok((file.path, bytes))
}

pub fn read_text_bounded(
    root: &Path,
    candidate: &Path,
    max_bytes: u64,
) -> Result<(PathBuf, String)> {
    let (path, bytes) = read_file_bounded(root, candidate, max_bytes)?;
    let text = String::from_utf8(bytes)
        .with_context(|| format!("contained file is not UTF-8 text: {}", path.display()))?;
    Ok((path, text))
}

pub fn walk_no_links(root: &Path) -> Walk {
    let mut builder = WalkBuilder::new(root);
    builder.follow_links(false);
    builder.build()
}

pub fn path_string(path: &Path) -> Result<String> {
    validate_path_size(path)?;
    Ok(path.to_string_lossy().into_owned())
}

pub fn truncate_utf8(value: &str, max_bytes: usize) -> String {
    if value.len() <= max_bytes {
        return value.to_string();
    }
    let mut end = max_bytes;
    while end > 0 && !value.is_char_boundary(end) {
        end -= 1;
    }
    value[..end].to_string()
}

pub fn contained_event_path(root: &Path, candidate: &Path) -> Result<PathBuf> {
    validate_path_size(candidate)?;
    let joined = if candidate.is_absolute() {
        candidate.to_path_buf()
    } else {
        root.join(candidate)
    };
    let normalized = normalize_absolute(&joined)?;
    let relative = relative_to_root(root, &normalized).ok_or_else(|| {
        anyhow!(
            "watch event escapes canonical workspace root: {}",
            normalized.display()
        )
    })?;

    match fs::symlink_metadata(&normalized) {
        Ok(_) => return contained_existing(root, &normalized).map(|(path, _)| path),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error).context("inspect watch event path"),
    }

    let mut existing = normalized.clone();
    while existing != root {
        if existing.pop() && fs::symlink_metadata(&existing).is_ok() {
            break;
        }
    }
    let existing_relative = relative_to_root(root, &existing)
        .ok_or_else(|| anyhow!("watch event has no contained existing ancestor"))?;
    reject_link_components(root, &existing_relative)?;
    let canonical_existing = fs::canonicalize(&existing)?;
    if relative_to_root(root, &canonical_existing).is_none() {
        bail!("watch event ancestor resolves outside canonical root");
    }

    // The missing suffix cannot currently contain a live redirect. Reattach the
    // validated relative suffix to the canonical root so payload paths have one
    // unambiguous, root-contained spelling.
    Ok(root.join(relative))
}

pub fn canonical_database_path(db: &Path) -> Result<PathBuf> {
    validate_path_size(db)?;
    let absolute = if db.is_absolute() {
        db.to_path_buf()
    } else {
        std::env::current_dir()?.join(db)
    };
    let normalized = normalize_absolute(&absolute)?;
    let file_name = normalized
        .file_name()
        .ok_or_else(|| anyhow!("catalog database path must name a file"))?
        .to_os_string();
    let parent = normalized
        .parent()
        .ok_or_else(|| anyhow!("catalog database path has no parent"))?;
    fs::create_dir_all(parent)
        .with_context(|| format!("create catalog directory {}", parent.display()))?;
    let canonical_parent = fs::canonicalize(parent)
        .with_context(|| format!("canonicalize catalog directory {}", parent.display()))?;
    let parent_metadata = fs::symlink_metadata(&canonical_parent)?;
    if is_link_or_reparse(&parent_metadata) || !parent_metadata.file_type().is_dir() {
        bail!("catalog parent is not a real directory");
    }

    let candidate = canonical_parent.join(file_name);
    match fs::symlink_metadata(&candidate) {
        Ok(metadata) => {
            if is_link_or_reparse(&metadata) || !metadata.file_type().is_file() {
                bail!("catalog database is not a regular non-link file");
            }
            let canonical = fs::canonicalize(&candidate)?;
            if relative_to_root(&canonical_parent, &canonical).is_none() {
                bail!("catalog database resolves outside its canonical parent");
            }
            Ok(canonical)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(candidate),
        Err(error) => Err(error).context("inspect catalog database path"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn fixture() -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let root = std::env::temp_dir().join(format!("axiom-core-fs-safety-{nonce}"));
        fs::create_dir_all(&root).expect("create fixture");
        fs::write(root.join("inside.txt"), b"safe").expect("write fixture");
        root
    }

    #[test]
    fn contained_paths_accept_real_files_and_reject_root_escapes() {
        let fixture = fixture();
        let outside = fixture.with_extension("outside.txt");
        fs::write(&outside, b"outside").expect("write outside fixture");
        let root = canonicalize_root(&fixture).expect("canonical root");

        let relative = contained_file(&root, Path::new("inside.txt")).expect("relative file");
        assert!(relative_to_root(&root, &relative.path).is_some());

        // On Windows, `root` is generally verbatim (`\\?\C:\...`) while this
        // candidate has normal drive spelling. Both must identify the same file.
        let absolute = contained_file(&root, &fixture.join("inside.txt")).expect("absolute file");
        assert_eq!(relative.path, absolute.path);

        assert!(contained_file(&root, Path::new("../outside.txt")).is_err());
        assert!(contained_file(&root, &outside).is_err());

        let removed = contained_event_path(&root, &fixture.join("removed.txt"))
            .expect("contained removed event");
        assert!(relative_to_root(&root, &removed).is_some());

        fs::remove_file(outside).expect("remove outside fixture");
        fs::remove_dir_all(fixture).expect("remove fixture");
    }
}
