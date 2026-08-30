use crate::{
    CoreError, ErrorCode, Result, canonical_json_bytes, encoding::decode_base64url_fixed,
    state_schema::validate_state_schema,
};
use semver::Version;
use serde_json::{Map, Value};
use std::collections::BTreeSet;
use unicode_normalization::UnicodeNormalization;

const MAX_MANIFEST_BYTES: usize = 128 * 1024;
const MAX_STATE_BYTES: u64 = 393_216;
const MAX_MODULE_BYTES: u64 = 768 * 1024;

const MANIFEST_KEYS: &[&str] = &[
    "capabilities",
    "description",
    "files",
    "id",
    "limits",
    "name",
    "publisher",
    "runtime",
    "schemaVersion",
    "state",
    "version",
];

#[derive(Debug, Clone)]
pub struct ValidatedManifest {
    pub value: Value,
    pub canonical: Vec<u8>,
    pub app_digest: [u8; 32],
    pub app_bytes: usize,
    pub publisher_public_key: [u8; 32],
    pub publisher_key_id: String,
}

#[derive(Default)]
struct StateBudget {
    objects: usize,
    properties: usize,
    arrays: usize,
    scalars: usize,
}

fn object(value: &Value, code: ErrorCode) -> Result<&Map<String, Value>> {
    value
        .as_object()
        .ok_or_else(|| CoreError::new(code, "expected object"))
}

fn exact_keys(object: &Map<String, Value>, keys: &[&str], code: ErrorCode) -> Result<()> {
    let actual: BTreeSet<&str> = object.keys().map(String::as_str).collect();
    let expected: BTreeSet<&str> = keys.iter().copied().collect();
    if actual != expected {
        return Err(CoreError::new(code, "object fields do not match schema"));
    }
    Ok(())
}

fn string<'a>(object: &'a Map<String, Value>, key: &str, code: ErrorCode) -> Result<&'a str> {
    object
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| CoreError::new(code, "expected string field"))
}

fn unsigned(object: &Map<String, Value>, key: &str, code: ErrorCode) -> Result<u64> {
    object
        .get(key)
        .and_then(Value::as_u64)
        .ok_or_else(|| CoreError::new(code, "expected unsigned integer field"))
}

fn valid_text(value: &str, minimum: usize, maximum: usize) -> bool {
    let length = value.chars().count();
    length >= minimum
        && length <= maximum
        && value.nfc().eq(value.chars())
        && !value.chars().any(is_forbidden_scalar)
}

fn is_forbidden_scalar(value: char) -> bool {
    value.is_control()
        || matches!(
            value,
            '\u{200e}'
                | '\u{200f}'
                | '\u{202a}'..='\u{202e}'
                | '\u{2066}'..='\u{2069}'
        )
}

fn valid_app_id(value: &str) -> bool {
    let bytes = value.as_bytes();
    if !(3..=128).contains(&bytes.len()) || !bytes.iter().all(u8::is_ascii) {
        return false;
    }
    let labels: Vec<&str> = value.split('.').collect();
    labels.len() >= 2
        && labels.iter().all(|label| {
            !label.is_empty()
                && !label.starts_with('-')
                && !label.ends_with('-')
                && label
                    .bytes()
                    .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
        })
}

fn validate_capabilities(value: &Value) -> Result<()> {
    let capabilities = value.as_array().ok_or_else(|| {
        CoreError::new(
            ErrorCode::ManifestCapabilityInvalid,
            "capabilities must be an array",
        )
    })?;
    let mut previous: Option<&str> = None;
    for capability in capabilities {
        let capability = capability.as_str().ok_or_else(|| {
            CoreError::new(
                ErrorCode::ManifestCapabilityInvalid,
                "capability must be a string",
            )
        })?;
        if !matches!(capability, "clipboard.write" | "export.download")
            || previous.is_some_and(|value| value >= capability)
        {
            return Err(CoreError::new(
                ErrorCode::ManifestCapabilityInvalid,
                "capabilities must be sorted, unique, and registered",
            ));
        }
        previous = Some(capability);
    }
    Ok(())
}

fn validate_limits(value: &Value) -> Result<()> {
    let limits = object(value, ErrorCode::ManifestSemanticInvalid)?;
    exact_keys(
        limits,
        &["maxEventRate", "maxViewNodes"],
        ErrorCode::ManifestSemanticInvalid,
    )?;
    let view_nodes = unsigned(limits, "maxViewNodes", ErrorCode::ManifestSemanticInvalid)?;
    let event_rate = unsigned(limits, "maxEventRate", ErrorCode::ManifestSemanticInvalid)?;
    if !(1..=2_000).contains(&view_nodes) || !(1..=30).contains(&event_rate) {
        return Err(CoreError::new(
            ErrorCode::ManifestSemanticInvalid,
            "runtime limit is out of range",
        ));
    }
    Ok(())
}

fn valid_state_key(key: &str) -> bool {
    valid_text(key, 1, 64) && !matches!(key, "." | ".." | "__proto__" | "prototype" | "constructor")
}

fn validate_state_budget(value: &Value, depth: usize, budget: &mut StateBudget) -> bool {
    if depth > 32 {
        return false;
    }
    match value {
        Value::Object(values) => {
            budget.objects += 1;
            budget.properties += values.len();
            budget.objects <= 4_096
                && budget.properties <= 16_384
                && values.iter().all(|(key, value)| {
                    valid_state_key(key) && validate_state_budget(value, depth + 1, budget)
                })
        }
        Value::Array(values) => {
            budget.arrays += 1;
            budget.arrays <= 1_024
                && values.len() <= 2_048
                && values
                    .iter()
                    .all(|value| validate_state_budget(value, depth + 1, budget))
        }
        Value::String(value) => {
            budget.scalars += 1;
            value.chars().count() <= 32_768 && budget.scalars <= 32_768
        }
        Value::Number(value) => {
            budget.scalars += 1;
            value.as_f64().is_some_and(f64::is_finite) && budget.scalars <= 32_768
        }
        Value::Null | Value::Bool(_) => {
            budget.scalars += 1;
            budget.scalars <= 32_768
        }
    }
}

fn validate_state(value: &Value) -> Result<()> {
    let state = object(value, ErrorCode::ManifestSemanticInvalid)?;
    let allowed = ["jsonSchema", "maxPlaintextBytes", "mode", "publicTemplate"];
    if state.keys().any(|key| !allowed.contains(&key.as_str()))
        || !["jsonSchema", "maxPlaintextBytes", "mode"]
            .iter()
            .all(|key| state.contains_key(*key))
    {
        return Err(CoreError::new(
            ErrorCode::ManifestSemanticInvalid,
            "invalid state fields",
        ));
    }
    let mode = string(state, "mode", ErrorCode::ManifestSemanticInvalid)?;
    let max_plaintext = unsigned(
        state,
        "maxPlaintextBytes",
        ErrorCode::ManifestSemanticInvalid,
    )?;
    if !matches!(mode, "personal" | "shared") || !(1..=MAX_STATE_BYTES).contains(&max_plaintext) {
        return Err(CoreError::new(
            ErrorCode::ManifestSemanticInvalid,
            "invalid state mode or size",
        ));
    }
    let schema = state
        .get("jsonSchema")
        .ok_or_else(|| CoreError::new(ErrorCode::ManifestSchemaInvalid, "missing state schema"))?;
    let template = state
        .get("publicTemplate")
        .cloned()
        .unwrap_or_else(|| Value::Object(Map::new()));
    let mut budget = StateBudget::default();
    if !validate_state_budget(&template, 0, &mut budget)
        || canonical_json_bytes(&template)?.len() as u64 > max_plaintext
    {
        return Err(CoreError::new(
            ErrorCode::ManifestTemplateInvalid,
            "public template violates state limits",
        ));
    }
    validate_state_schema(schema, &template)
}

fn validate_publisher(value: &Value) -> Result<([u8; 32], String)> {
    let publisher = object(value, ErrorCode::ManifestSemanticInvalid)?;
    exact_keys(
        publisher,
        &["displayName", "keyId", "publicKey"],
        ErrorCode::ManifestSemanticInvalid,
    )?;
    if !valid_text(
        string(publisher, "displayName", ErrorCode::ManifestUnicodeInvalid)?,
        1,
        80,
    ) {
        return Err(CoreError::new(
            ErrorCode::ManifestUnicodeInvalid,
            "invalid publisher display name",
        ));
    }
    let public_key = decode_base64url_fixed::<32>(
        string(publisher, "publicKey", ErrorCode::PublisherKeyInvalid)?,
        ErrorCode::PublisherKeyInvalid,
    )?;
    let key_id = string(publisher, "keyId", ErrorCode::PublisherKeyIdMismatch)?.to_owned();
    Ok((public_key, key_id))
}

fn validate_files(value: &Value) -> Result<([u8; 32], usize)> {
    let files = object(value, ErrorCode::ManifestFileSetInvalid)?;
    exact_keys(files, &["app.worker.js"], ErrorCode::ManifestFileSetInvalid)?;
    let app = object(
        files.get("app.worker.js").ok_or_else(|| {
            CoreError::new(ErrorCode::ManifestFileSetInvalid, "missing app.worker.js")
        })?,
        ErrorCode::ManifestFileSetInvalid,
    )?;
    exact_keys(app, &["bytes", "sha256"], ErrorCode::ManifestFileSetInvalid)?;
    let bytes = unsigned(app, "bytes", ErrorCode::ManifestFileSetInvalid)?;
    if !(1..=MAX_MODULE_BYTES).contains(&bytes) {
        return Err(CoreError::new(
            ErrorCode::ManifestFileSetInvalid,
            "module size is out of range",
        ));
    }
    let digest = decode_base64url_fixed::<32>(
        string(app, "sha256", ErrorCode::ManifestFileSetInvalid)?,
        ErrorCode::ManifestFileSetInvalid,
    )?;
    Ok((digest, bytes as usize))
}

pub fn validate_manifest(value: Value) -> Result<ValidatedManifest> {
    let canonical = canonical_json_bytes(&value)?;
    if canonical.len() > MAX_MANIFEST_BYTES {
        return Err(CoreError::new(
            ErrorCode::ManifestSchemaInvalid,
            "manifest exceeds 128 KiB",
        ));
    }
    let manifest = object(&value, ErrorCode::ManifestSchemaInvalid)?;
    exact_keys(manifest, MANIFEST_KEYS, ErrorCode::ManifestSchemaInvalid)?;
    if string(
        manifest,
        "schemaVersion",
        ErrorCode::ManifestSemanticInvalid,
    )? != "1.0"
        || string(manifest, "runtime", ErrorCode::ManifestSemanticInvalid)? != "smallframe-view/1"
    {
        return Err(CoreError::new(
            ErrorCode::ManifestSemanticInvalid,
            "unsupported manifest or runtime version",
        ));
    }
    let id = string(manifest, "id", ErrorCode::ManifestSemanticInvalid)?;
    let name = string(manifest, "name", ErrorCode::ManifestUnicodeInvalid)?;
    let description = string(manifest, "description", ErrorCode::ManifestUnicodeInvalid)?;
    let version = string(manifest, "version", ErrorCode::ManifestSemanticInvalid)?;
    if !valid_app_id(id) || Version::parse(version).is_err() {
        return Err(CoreError::new(
            ErrorCode::ManifestSemanticInvalid,
            "invalid app identity metadata",
        ));
    }
    if !valid_text(name, 1, 60) || !valid_text(description, 0, 240) {
        return Err(CoreError::new(
            ErrorCode::ManifestUnicodeInvalid,
            "app display metadata is not normalized safe text",
        ));
    }
    validate_state(
        manifest
            .get("state")
            .ok_or_else(|| CoreError::new(ErrorCode::ManifestSemanticInvalid, "missing state"))?,
    )?;
    validate_capabilities(manifest.get("capabilities").ok_or_else(|| {
        CoreError::new(ErrorCode::ManifestCapabilityInvalid, "missing capabilities")
    })?)?;
    validate_limits(
        manifest
            .get("limits")
            .ok_or_else(|| CoreError::new(ErrorCode::ManifestSemanticInvalid, "missing limits"))?,
    )?;
    let (publisher_public_key, publisher_key_id) =
        validate_publisher(manifest.get("publisher").ok_or_else(|| {
            CoreError::new(ErrorCode::ManifestSemanticInvalid, "missing publisher")
        })?)?;
    let (app_digest, app_bytes) = validate_files(
        manifest
            .get("files")
            .ok_or_else(|| CoreError::new(ErrorCode::ManifestFileSetInvalid, "missing files"))?,
    )?;
    Ok(ValidatedManifest {
        value,
        canonical,
        app_digest,
        app_bytes,
        publisher_public_key,
        publisher_key_id,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reverse_dns_requires_dot_and_valid_labels() {
        assert!(valid_app_id("dev.example.decision-board"));
        assert!(!valid_app_id("example-app"));
        assert!(!valid_app_id("dev.-example.app"));
        assert!(!valid_app_id("Dev.example.app"));
    }

    #[test]
    fn state_keys_reject_prototype_and_path_sentinels() {
        for key in [".", "..", "__proto__", "prototype", "constructor"] {
            assert!(!valid_state_key(key));
        }
        assert!(valid_state_key("decision-01"));
    }
}
