use crate::{
    CoreError, ErrorCode, canonical_json,
    encoding::{decode_base64url_fixed, encode_base64url},
    hex_digest,
    package::sha256,
    prepare_classic_module_source, verify_package_archive,
};
use serde_json::json;
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub fn wasm_verifier_version() -> u32 {
    1
}

#[wasm_bindgen]
pub fn wasm_verifier_self_test() -> bool {
    canonical_json(r#"{"z":-0,"a":1}"#).as_deref().ok() == Some(r#"{"a":1,"z":0}"#)
        && hex_digest(&sha256(b"smallframe-verifier-v1"))
            == "9bda88bcb0b189b7451f33fe367a61eeace383a066a376db35b55ceebc87b4e8"
}

#[wasm_bindgen]
pub fn wasm_canonical_json(input: &str) -> std::result::Result<String, JsValue> {
    canonical_json(input).map_err(|error| JsValue::from_str(error.code().as_str()))
}

#[wasm_bindgen]
pub fn wasm_sha256_hex(input: &[u8]) -> String {
    hex_digest(&sha256(input))
}

fn expected_digest(value: &str) -> std::result::Result<Option<[u8; 32]>, CoreError> {
    if value.is_empty() {
        Ok(None)
    } else {
        decode_base64url_fixed::<32>(value, ErrorCode::PackageDigestMismatch).map(Some)
    }
}

#[wasm_bindgen]
pub fn wasm_verify_package(
    archive: &[u8],
    expected_digest_value: &str,
    expected_key_id: &str,
) -> String {
    let result = expected_digest(expected_digest_value).and_then(|expected| {
        verify_package_archive(
            archive,
            expected.as_ref(),
            (!expected_key_id.is_empty()).then_some(expected_key_id),
        )
    });
    match result {
        Ok(package) => json!({
            "ok": true,
            "packageDigest": encode_base64url(&package.package_digest),
            "artifactDigest": encode_base64url(&package.artifact_digest),
            "publisherKeyId": package.publisher_key_id,
        })
        .to_string(),
        Err(error) => json!({"ok": false, "error": {"code": error.code().as_str()}}).to_string(),
    }
}

#[wasm_bindgen]
pub fn wasm_prepare_package(
    archive: &[u8],
    expected_digest_value: &str,
    expected_key_id: &str,
) -> String {
    let result = expected_digest(expected_digest_value).and_then(|expected| {
        verify_package_archive(
            archive,
            expected.as_ref(),
            (!expected_key_id.is_empty()).then_some(expected_key_id),
        )
    });
    match result {
        Ok(package) => match prepare_classic_module_source(&package.canonical_files.module) {
            Ok(module_source) => {
                match serde_json::from_slice::<serde_json::Value>(&package.canonical_files.manifest)
                {
                    Ok(manifest) => json!({
                        "ok": true,
                        "packageDigest": encode_base64url(&package.package_digest),
                        "artifactDigest": encode_base64url(&package.artifact_digest),
                        "publisherKeyId": package.publisher_key_id,
                        "manifest": manifest,
                        "moduleSource": module_source,
                    })
                    .to_string(),
                    Err(_) => {
                        json!({"ok": false, "error": {"code": ErrorCode::JsonInvalid.as_str()}})
                            .to_string()
                    }
                }
            }
            Err(error) => {
                json!({"ok": false, "error": {"code": error.code().as_str()}}).to_string()
            }
        },
        Err(error) => json!({"ok": false, "error": {"code": error.code().as_str()}}).to_string(),
    }
}
