#![forbid(unsafe_code)]

use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum CoreError {
    #[error("invalid JSON: {0}")]
    Json(#[from] serde_json::Error),
    #[error("canonical JSON value is unsupported")]
    UnsupportedValue,
}

fn canonical_value(value: &Value, output: &mut String) -> Result<(), CoreError> {
    match value {
        Value::Null => output.push_str("null"),
        Value::Bool(value) => output.push_str(if *value { "true" } else { "false" }),
        Value::Number(value) => output.push_str(&value.to_string()),
        Value::String(value) => output.push_str(&serde_json::to_string(value)?),
        Value::Array(values) => {
            output.push('[');
            for (index, item) in values.iter().enumerate() {
                if index > 0 {
                    output.push(',');
                }
                canonical_value(item, output)?;
            }
            output.push(']');
        }
        Value::Object(values) => {
            output.push('{');
            let mut keys: Vec<&String> = values.keys().collect();
            keys.sort_unstable();
            for (index, key) in keys.iter().enumerate() {
                if index > 0 {
                    output.push(',');
                }
                output.push_str(&serde_json::to_string(*key)?);
                output.push(':');
                let item = values.get(*key).ok_or(CoreError::UnsupportedValue)?;
                canonical_value(item, output)?;
            }
            output.push('}');
        }
    }
    Ok(())
}

pub fn canonical_json(input: &str) -> Result<String, CoreError> {
    let value: Value = serde_json::from_str(input)?;
    let mut output = String::new();
    canonical_value(&value, &mut output)?;
    Ok(output)
}

pub fn sha256(value: &[u8]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(value);
    hasher.finalize().into()
}

pub fn package_digest(manifest: &str) -> Result<[u8; 32], CoreError> {
    let canonical = canonical_json(manifest)?;
    let mut input = Vec::with_capacity(22 + canonical.len());
    input.extend_from_slice(b"smallframe-package-v1\0");
    input.extend_from_slice(canonical.as_bytes());
    Ok(sha256(&input))
}

pub fn hex_digest(value: &[u8]) -> String {
    value.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[cfg(feature = "wasm")]
#[wasm_bindgen::prelude::wasm_bindgen]
pub fn wasm_sha256_hex(input: &str) -> String {
    hex_digest(&sha256(input.as_bytes()))
}

#[cfg(feature = "wasm")]
#[wasm_bindgen::prelude::wasm_bindgen]
pub fn wasm_canonical_json(input: &str) -> Result<String, wasm_bindgen::JsValue> {
    canonical_json(input).map_err(|error| wasm_bindgen::JsValue::from_str(&error.to_string()))
}

#[allow(dead_code)]
fn _keep_imports(_map: Map<String, Value>) {}
