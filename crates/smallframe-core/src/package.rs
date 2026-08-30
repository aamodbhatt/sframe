use crate::{
    CoreError, ErrorCode, PackageFiles, Result, ValidatedManifest, canonical_zip,
    create_dsse_envelope, encoding::encode_base64url, parse_strict_json, read_zip_bounded,
    validate_manifest, validate_module_source, verify_dsse_envelope,
};
use ed25519_dalek::SigningKey;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;

const PACKAGE_DOMAIN: &[u8] = b"smallframe-package-v1\0";

#[derive(Debug, Clone)]
pub struct ValidatedSource {
    pub canonical_manifest: Vec<u8>,
    pub package_digest: [u8; 32],
    pub publisher_key_id: String,
}

#[derive(Debug, Clone)]
pub struct VerifiedPackage {
    pub package_digest: [u8; 32],
    pub artifact_digest: [u8; 32],
    pub publisher_key_id: String,
    pub canonical_files: PackageFiles,
    pub canonical_archive: Vec<u8>,
}

#[must_use]
pub fn sha256(value: &[u8]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(value);
    hasher.finalize().into()
}

#[must_use]
pub fn hex_digest(value: &[u8]) -> String {
    value.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[must_use]
pub fn key_id(public_key: &[u8; 32]) -> String {
    format!("sha256:{}", encode_base64url(&sha256(public_key)))
}

#[must_use]
pub fn package_digest(canonical_manifest: &[u8]) -> [u8; 32] {
    let mut input = Vec::with_capacity(PACKAGE_DOMAIN.len() + canonical_manifest.len());
    input.extend_from_slice(PACKAGE_DOMAIN);
    input.extend_from_slice(canonical_manifest);
    sha256(&input)
}

#[must_use]
pub fn artifact_digest(archive: &[u8]) -> [u8; 32] {
    sha256(archive)
}

fn digest_matches(left: &[u8; 32], right: &[u8; 32]) -> bool {
    bool::from(left.ct_eq(right))
}

fn validate_source_inner(
    manifest_bytes: &[u8],
    module: &[u8],
    require_canonical_manifest: bool,
) -> Result<(ValidatedManifest, ValidatedSource)> {
    let manifest_value = parse_strict_json(manifest_bytes)?;
    let manifest = validate_manifest(manifest_value)?;
    if require_canonical_manifest && manifest_bytes != manifest.canonical {
        return Err(CoreError::new(
            ErrorCode::JsonNotCanonical,
            "manifest bytes are not JCS",
        ));
    }
    if module.len() != manifest.app_bytes {
        return Err(CoreError::new(
            ErrorCode::PackageFileSizeMismatch,
            "module byte length does not match manifest",
        ));
    }
    let module_digest = sha256(module);
    if !digest_matches(&module_digest, &manifest.app_digest) {
        return Err(CoreError::new(
            ErrorCode::PackageFileHashMismatch,
            "module digest does not match manifest",
        ));
    }
    validate_module_source(module)?;
    if key_id(&manifest.publisher_public_key) != manifest.publisher_key_id {
        return Err(CoreError::new(
            ErrorCode::PublisherKeyIdMismatch,
            "publisher key ID does not match public key",
        ));
    }
    let source = ValidatedSource {
        canonical_manifest: manifest.canonical.clone(),
        package_digest: package_digest(&manifest.canonical),
        publisher_key_id: manifest.publisher_key_id.clone(),
    };
    Ok((manifest, source))
}

pub fn validate_source_files(
    manifest_bytes: &[u8],
    module: &[u8],
    require_canonical_manifest: bool,
) -> Result<ValidatedSource> {
    validate_source_inner(manifest_bytes, module, require_canonical_manifest)
        .map(|(_, source)| source)
}

pub fn verify_package_files(
    files: &PackageFiles,
    require_canonical_json: bool,
) -> Result<VerifiedPackage> {
    let (manifest, source) =
        validate_source_inner(&files.manifest, &files.module, require_canonical_json)?;
    let envelope = verify_dsse_envelope(&files.signature, &manifest)?;
    if require_canonical_json && files.signature != envelope.canonical {
        return Err(CoreError::new(
            ErrorCode::JsonNotCanonical,
            "DSSE envelope bytes are not JCS",
        ));
    }
    let canonical_files = PackageFiles {
        manifest: source.canonical_manifest,
        module: files.module.clone(),
        signature: envelope.canonical,
    };
    let canonical_archive = canonical_zip(&canonical_files)?;
    Ok(VerifiedPackage {
        package_digest: source.package_digest,
        artifact_digest: artifact_digest(&canonical_archive),
        publisher_key_id: source.publisher_key_id,
        canonical_files,
        canonical_archive,
    })
}

fn manifest_object_mut(value: &mut Value) -> Result<&mut serde_json::Map<String, Value>> {
    value.as_object_mut().ok_or_else(|| {
        CoreError::new(
            ErrorCode::ManifestSchemaInvalid,
            "manifest root must be an object",
        )
    })
}

pub fn build_signed_package(
    mut manifest: Value,
    module: &[u8],
    signing_key: &SigningKey,
) -> Result<VerifiedPackage> {
    validate_module_source(module)?;
    let public_key = signing_key.verifying_key().to_bytes();
    let publisher_key_id = key_id(&public_key);
    let manifest_object = manifest_object_mut(&mut manifest)?;
    let publisher = manifest_object
        .get_mut("publisher")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| {
            CoreError::new(
                ErrorCode::ManifestSemanticInvalid,
                "publisher must be an object",
            )
        })?;
    publisher.insert("publicKey".to_owned(), json!(encode_base64url(&public_key)));
    publisher.insert("keyId".to_owned(), json!(publisher_key_id));
    let files = manifest_object
        .get_mut("files")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| {
            CoreError::new(ErrorCode::ManifestFileSetInvalid, "files must be an object")
        })?;
    files.insert(
        "app.worker.js".to_owned(),
        json!({
            "bytes": module.len(),
            "sha256": encode_base64url(&sha256(module)),
        }),
    );
    let validated = validate_manifest(manifest)?;
    let envelope = create_dsse_envelope(&validated.canonical, signing_key)?;
    let package_files = PackageFiles {
        manifest: validated.canonical,
        module: module.to_vec(),
        signature: envelope.canonical,
    };
    verify_package_files(&package_files, true)
}

pub fn verify_package_archive(
    archive: &[u8],
    expected_package_digest: Option<&[u8; 32]>,
    expected_publisher_key_id: Option<&str>,
) -> Result<VerifiedPackage> {
    let files = read_zip_bounded(archive)?;
    let verified = verify_package_files(&files, true)?;
    if expected_package_digest
        .is_some_and(|expected| !digest_matches(expected, &verified.package_digest))
    {
        return Err(CoreError::new(
            ErrorCode::PackageDigestMismatch,
            "link-pinned package digest mismatch",
        ));
    }
    if expected_publisher_key_id.is_some_and(|expected| expected != verified.publisher_key_id) {
        return Err(CoreError::new(
            ErrorCode::PublisherKeyIdMismatch,
            "link-pinned publisher key ID mismatch",
        ));
    }
    if archive != verified.canonical_archive {
        return Err(CoreError::new(
            ErrorCode::PackageArchiveNoncanonical,
            "archive is not the deterministic STORE encoding",
        ));
    }
    if !digest_matches(&artifact_digest(archive), &verified.artifact_digest) {
        return Err(CoreError::new(
            ErrorCode::ArtifactDigestMismatch,
            "artifact digest mismatch",
        ));
    }
    Ok(verified)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const MODULE: &[u8] = b"export default {view(){return {text:'ok'};},onEvent(){}};";

    fn manifest() -> Value {
        json!({
            "schemaVersion": "1.0",
            "id": "dev.example.package-test",
            "name": "Package Test",
            "version": "0.1.0",
            "description": "Deterministic package fixture.",
            "runtime": "smallframe-view/1",
            "state": {
                "mode": "personal",
                "maxPlaintextBytes": 393216,
                "publicTemplate": {"items": {}},
                "jsonSchema": {
                    "type": "object",
                    "properties": {"items": {"type": "object"}},
                    "required": ["items"],
                    "additionalProperties": false
                }
            },
            "capabilities": [],
            "limits": {"maxViewNodes": 2000, "maxEventRate": 30},
            "publisher": {"displayName": "Fixture Publisher", "publicKey": "", "keyId": ""},
            "files": {"app.worker.js": {"sha256": "", "bytes": 1}}
        })
    }

    #[test]
    fn builds_and_verifies_one_canonical_artifact() {
        let package = build_signed_package(manifest(), MODULE, &SigningKey::from_bytes(&[7; 32]))
            .expect("build package");
        let verified = verify_package_archive(
            &package.canonical_archive,
            Some(&package.package_digest),
            Some(&package.publisher_key_id),
        )
        .expect("verify package");
        assert_eq!(verified.artifact_digest, package.artifact_digest);
        assert_eq!(verified.canonical_files.module, MODULE);
    }

    #[test]
    fn rejects_file_mutation_and_alternate_signer_substitution() {
        let original = build_signed_package(manifest(), MODULE, &SigningKey::from_bytes(&[7; 32]))
            .expect("original package");
        let mut mutated_files = original.canonical_files.clone();
        mutated_files.module[0] ^= 1;
        let mutated_archive = canonical_zip(&mutated_files).expect("mutated ZIP");
        assert_eq!(
            verify_package_archive(&mutated_archive, None, None)
                .expect_err("module mutation fails")
                .code(),
            ErrorCode::PackageFileHashMismatch
        );

        let alternate = build_signed_package(manifest(), MODULE, &SigningKey::from_bytes(&[8; 32]))
            .expect("alternate package");
        assert_eq!(
            verify_package_archive(
                &alternate.canonical_archive,
                Some(&original.package_digest),
                None,
            )
            .expect_err("link pin rejects alternate signer")
            .code(),
            ErrorCode::PackageDigestMismatch
        );
    }
}
