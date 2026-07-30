//! Offline, zero-egress baseline text embedder (PRD Phase 59). Produces a
//! fixed-dimension, L2-normalized vector via signed character n-gram feature
//! hashing. It is deterministic, dependency-free, and fully offline (INV-4),
//! capturing lexical/substring similarity. A neural ONNX/GGUF model can be
//! slotted behind the same `embed_text` interface later for true semantics.

use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};

use anyhow::Result;
use serde::Deserialize;
use serde_json::{json, Value};

/// Default embedding dimensionality.
pub const DEFAULT_DIM: usize = 256;

fn hash_str(s: &str) -> u64 {
    let mut h = DefaultHasher::new();
    s.hash(&mut h);
    h.finish()
}

/// L2-normalize a vector in place (no-op for the zero vector).
pub fn l2_normalize(v: &mut [f32]) {
    let norm = v.iter().map(|x| x * x).sum::<f32>().sqrt();
    if norm > 0.0 {
        for x in v.iter_mut() {
            *x /= norm;
        }
    }
}

/// Cosine similarity. Inputs are expected L2-normalized, so this is a dot product.
pub fn cosine(a: &[f32], b: &[f32]) -> f32 {
    let n = a.len().min(b.len());
    let mut dot = 0f32;
    for i in 0..n {
        dot += a[i] * b[i];
    }
    dot
}

/// Embed text into an L2-normalized vector using signed character 3-gram
/// feature hashing. Short inputs fall back to whole-token hashing.
pub fn embed_text(text: &str, dim: usize) -> Vec<f32> {
    let dim = dim.max(1);
    let mut v = vec![0f32; dim];
    let lower = text.to_lowercase();
    let chars: Vec<char> = lower.chars().collect();

    if chars.len() < 3 {
        for tok in lower.split_whitespace() {
            let h = hash_str(tok);
            let idx = (h as usize) % dim;
            v[idx] += 1.0;
        }
    } else {
        for window in chars.windows(3) {
            let gram: String = window.iter().collect();
            let h = hash_str(&gram);
            let idx = (h as usize) % dim;
            // Signed hashing (top bit picks the sign) reduces collision bias.
            let sign = if (h >> 63) & 1 == 1 { -1.0 } else { 1.0 };
            v[idx] += sign;
        }
    }

    l2_normalize(&mut v);
    v
}

#[derive(Deserialize)]
struct EmbedParams {
    text: String,
    #[serde(default)]
    dim: Option<usize>,
}

/// RPC handler for `embed`: return the embedding vector for a text.
pub async fn embed(params: Value) -> Result<Value> {
    let p: EmbedParams = serde_json::from_value(params)?;
    let vector = embed_text(&p.text, p.dim.unwrap_or(DEFAULT_DIM));
    Ok(json!({ "dim": vector.len(), "vector": vector }))
}
