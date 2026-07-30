//! JSON-RPC 2.0-ish protocol over newline-delimited JSON (NDJSON) on stdio.
//! Each message is a single line of compact JSON terminated by `\n`. This is the
//! wire format between the Electron Main process and the Rust Core (PRD Phase 49).

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// A request from Main. `id` is absent for notifications (no response expected).
#[derive(Debug, Deserialize)]
pub struct Request {
    #[serde(default)]
    pub id: Option<Value>,
    pub method: String,
    #[serde(default)]
    pub params: Value,
}

/// A response to a request, carrying either a result or an error.
#[derive(Debug, Serialize)]
pub struct Response {
    pub id: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<RpcError>,
}

impl Response {
    pub fn ok(id: Value, result: Value) -> Self {
        Response {
            id,
            result: Some(result),
            error: None,
        }
    }

    pub fn err(id: Value, code: i32, message: String) -> Self {
        Response {
            id,
            result: None,
            error: Some(RpcError { code, message }),
        }
    }
}

#[derive(Debug, Serialize)]
pub struct RpcError {
    pub code: i32,
    pub message: String,
}

/// A server-initiated notification (e.g., filesystem change events, indexing
/// progress). No `id`, so Main treats it as fire-and-forget.
#[derive(Debug, Serialize)]
pub struct Notification {
    pub method: String,
    pub params: Value,
}

/// Standard error codes.
pub const METHOD_NOT_FOUND: i32 = -32601;
pub const INTERNAL_ERROR: i32 = -32000;
