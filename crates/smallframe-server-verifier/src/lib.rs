#![forbid(unsafe_code)]

use base64ct::{Base64, Base64UrlUnpadded, Encoding};
use serde_json::json;
use smallframe_core::{
    CoreError, ErrorCode, canonical_json, hex_digest, sha256, verify_package_archive,
};
use wasm_bindgen::prelude::*;

// This adapter adds no verifier logic. All archive, manifest, module, signature
// and canonical artifact checks execute in the same core as native/browser.
#[wasm_bindgen]
pub fn wasm_verifier_self_test() -> bool {
    let basic = canonical_json(r#"{"z":-0,"a":1}"#).as_deref().ok() == Some(r#"{"a":1,"z":0}"#)
        && hex_digest(&sha256(b"smallframe-verifier-v1"))
            == "9bda88bcb0b189b7451f33fe367a61eeace383a066a376db35b55ceebc87b4e8";
    let vector = include_str!("../../../packages/protocol/vectors/canonical-package-v1.zip.b64");
    let Ok(archive) = Base64::decode_vec(vector.trim()) else {
        return false;
    };
    let Ok(verified) = verify_package_archive(&archive, None, None) else {
        return false;
    };
    basic
        && Base64UrlUnpadded::encode_string(&verified.package_digest)
            == "xGzOKkefgzfEFU-AFvSM4zHn9bw-XF3xwlHoz-QHJAA"
        && Base64UrlUnpadded::encode_string(&verified.artifact_digest)
            == "O0lEC4tH1tN_ncCX_FalC8uNSyxOpSRvFUU59BLbr5E"
        && verify_package_archive(&archive, None, Some("sha256:wrong")).is_err()
}

fn expected_digest(value: &str) -> Result<Option<[u8; 32]>, CoreError> {
    if value.is_empty() {
        return Ok(None);
    }
    let bytes = Base64UrlUnpadded::decode_vec(value)
        .map_err(|_| CoreError::new(ErrorCode::PackageDigestMismatch, "invalid digest"))?;
    let digest: [u8; 32] = bytes
        .try_into()
        .map_err(|_| CoreError::new(ErrorCode::PackageDigestMismatch, "invalid digest"))?;
    if Base64UrlUnpadded::encode_string(&digest) != value {
        return Err(CoreError::new(
            ErrorCode::PackageDigestMismatch,
            "invalid digest",
        ));
    }
    Ok(Some(digest))
}

#[wasm_bindgen]
pub fn wasm_verify_package(archive: &[u8], digest: &str, publisher: &str) -> String {
    let result = expected_digest(digest).and_then(|expected| {
        verify_package_archive(
            archive,
            expected.as_ref(),
            (!publisher.is_empty()).then_some(publisher),
        )
    });
    match result {
        Ok(package) => json!({"ok":true,
            "packageDigest":Base64UrlUnpadded::encode_string(&package.package_digest),
            "artifactDigest":Base64UrlUnpadded::encode_string(&package.artifact_digest),
            "publisherKeyId":package.publisher_key_id})
        .to_string(),
        Err(error) => json!({"ok":false,"error":{"code":error.code().as_str()}}).to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    const ARCHIVE: &str =
        include_str!("../../../packages/protocol/vectors/canonical-package-v1.zip.b64");

    #[test]
    fn adapter_binds_the_shared_public_vector_and_rejects_malformed_pins() {
        assert!(wasm_verifier_self_test());
        let archive = Base64::decode_vec(ARCHIVE.trim()).expect("public vector");
        let result: serde_json::Value =
            serde_json::from_str(&wasm_verify_package(&archive, "", "")).expect("result");
        assert_eq!(result["ok"], true);
        let digest = result["packageDigest"].as_str().expect("digest");
        let publisher = result["publisherKeyId"].as_str().expect("publisher");
        assert_eq!(
            wasm_verify_package(&archive, digest, publisher),
            result.to_string()
        );
        for bad in [format!("{digest}="), "A".repeat(43), "short".to_owned()] {
            let rejected: serde_json::Value =
                serde_json::from_str(&wasm_verify_package(&archive, &bad, publisher))
                    .expect("result");
            assert_eq!(rejected["ok"], false);
        }
        let rejected: serde_json::Value =
            serde_json::from_str(&wasm_verify_package(&archive, digest, "sha256:wrong"))
                .expect("result");
        assert_eq!(rejected["ok"], false);
    }
}
