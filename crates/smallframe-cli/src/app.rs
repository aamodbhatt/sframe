use base64ct::{Base64UrlUnpadded, Encoding};
use ed25519_dalek::SigningKey;
use serde::Serialize;
use serde_json::{Value, json};
use smallframe_core::{
    artifact_digest, build_signed_package, hex_digest, key_id, parse_strict_json, sha256,
    validate_source_files, verify_package_archive,
};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
};

const STARTER_MODULE: &str = "export default {view(){return {tag:'section',class:['sf-stack'],children:[{tag:'h1',children:[{text:'Smallframe app'}]},{tag:'p',children:[{text:'Edit app.worker.js to begin.'}]}]};},onEvent(){}};\n";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackageSummary {
    pub package_digest: String,
    pub artifact_digest: String,
    pub publisher_key_id: String,
    pub bytes: usize,
}

pub fn new_app(name: &str, root: &Path, signing_key: &SigningKey) -> Result<PathBuf, String> {
    let slug = slug(name)?;
    let target = root.join(&slug);
    fs::create_dir(&target).map_err(|_| "TARGET_EXISTS_OR_UNWRITABLE".to_owned())?;
    let module = STARTER_MODULE.as_bytes();
    let public_key = signing_key.verifying_key().to_bytes();
    let manifest = json!({
        "schemaVersion": "1.0",
        "id": format!("dev.local.{slug}"),
        "name": name,
        "version": "0.1.0",
        "description": "A Smallframe local-first app.",
        "runtime": "smallframe-view/1",
        "state": {
            "mode": "personal",
            "maxPlaintextBytes": 393216,
            "publicTemplate": {},
            "jsonSchema": {"type":"object","additionalProperties":false}
        },
        "capabilities": [],
        "limits": {"maxViewNodes":2000,"maxEventRate":30},
        "publisher": {
            "displayName":"Local Publisher",
            "publicKey":Base64UrlUnpadded::encode_string(&public_key),
            "keyId":key_id(&public_key)
        },
        "files": {"app.worker.js": {
            "sha256":Base64UrlUnpadded::encode_string(&sha256(module)),
            "bytes":module.len()
        }}
    });
    write_new(
        &target.join("smallframe.json"),
        &serde_jcs::to_vec(&manifest).map_err(|_| "MANIFEST_ENCODE_FAILED".to_owned())?,
    )?;
    write_new(&target.join("app.worker.js"), module)?;
    Ok(target)
}

pub fn validate_path(path: &Path) -> Result<PackageSummary, String> {
    if path.is_file() {
        let archive = fs::read(path).map_err(|_| "PACKAGE_READ_FAILED".to_owned())?;
        let package =
            verify_package_archive(&archive, None, None).map_err(|error| error.to_string())?;
        return Ok(PackageSummary {
            package_digest: Base64UrlUnpadded::encode_string(&package.package_digest),
            artifact_digest: Base64UrlUnpadded::encode_string(&package.artifact_digest),
            publisher_key_id: package.publisher_key_id,
            bytes: archive.len(),
        });
    }
    let (manifest, module) = read_source(path)?;
    let validated =
        validate_source_files(&manifest, &module, false).map_err(|error| error.to_string())?;
    Ok(PackageSummary {
        package_digest: Base64UrlUnpadded::encode_string(&validated.package_digest),
        artifact_digest: String::new(),
        publisher_key_id: validated.publisher_key_id,
        bytes: manifest.len() + module.len(),
    })
}

pub fn pack(
    path: &Path,
    output: &Path,
    signing_key: &SigningKey,
) -> Result<PackageSummary, String> {
    let (manifest_bytes, module) = read_source(path)?;
    let manifest: Value = parse_strict_json(&manifest_bytes).map_err(|error| error.to_string())?;
    let package =
        build_signed_package(manifest, &module, signing_key).map_err(|error| error.to_string())?;
    write_new(output, &package.canonical_archive)?;
    Ok(PackageSummary {
        package_digest: Base64UrlUnpadded::encode_string(&package.package_digest),
        artifact_digest: Base64UrlUnpadded::encode_string(&artifact_digest(
            &package.canonical_archive,
        )),
        publisher_key_id: package.publisher_key_id,
        bytes: package.canonical_archive.len(),
    })
}

fn read_source(path: &Path) -> Result<(Vec<u8>, Vec<u8>), String> {
    if !path.is_dir() {
        return Err("SOURCE_DIRECTORY_REQUIRED".to_owned());
    }
    let manifest =
        fs::read(path.join("smallframe.json")).map_err(|_| "READ_MANIFEST_FAILED".to_owned())?;
    let module =
        fs::read(path.join("app.worker.js")).map_err(|_| "READ_MODULE_FAILED".to_owned())?;
    Ok((manifest, module))
}

fn slug(value: &str) -> Result<String, String> {
    let mut output = String::new();
    let mut separator = false;
    for character in value.trim().chars() {
        if character.is_ascii_alphanumeric() {
            if separator && !output.is_empty() {
                output.push('-');
            }
            output.push(character.to_ascii_lowercase());
            separator = false;
        } else if matches!(character, ' ' | '-' | '_') {
            separator = true;
        } else {
            return Err("APP_NAME_UNSUPPORTED_CHARACTER".to_owned());
        }
    }
    if output.len() < 2 || output.len() > 60 {
        return Err("APP_NAME_LENGTH".to_owned());
    }
    Ok(output)
}

fn write_new(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|_| "OUTPUT_EXISTS_OR_UNWRITABLE".to_owned())?;
    file.write_all(bytes)
        .map_err(|_| "OUTPUT_WRITE_FAILED".to_owned())?;
    file.sync_all().map_err(|_| "OUTPUT_SYNC_FAILED".to_owned())
}

#[allow(dead_code)]
fn hex_artifact(bytes: &[u8]) -> String {
    hex_digest(&artifact_digest(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;
    use rand_core::{OsRng, RngCore};

    fn temporary_root() -> PathBuf {
        let mut suffix = [0_u8; 8];
        OsRng.fill_bytes(&mut suffix);
        std::env::temp_dir().join(format!("smallframe-pack-{}", hex_artifact(&suffix)))
    }

    #[test]
    fn package_is_deterministic_and_excludes_sensitive_initial_state_file() {
        let root = temporary_root();
        fs::create_dir(&root).expect("create test root");
        let key = SigningKey::from_bytes(&[0x31_u8; 32]);
        let source = new_app("Leak Test", &root, &key).expect("create app");
        let canary = b"PRIVATE_INITIAL_STATE_CANARY_DO_NOT_PACKAGE";
        fs::write(source.join("initial-state.json"), canary).expect("write private source fixture");
        let first = root.join("first.smallframe");
        let second = root.join("second.smallframe");
        let first_summary = pack(&source, &first, &key).expect("first package");
        let second_summary = pack(&source, &second, &key).expect("second package");
        let first_bytes = fs::read(first).expect("read first package");
        let second_bytes = fs::read(second).expect("read second package");
        assert_eq!(
            first_summary.artifact_digest,
            second_summary.artifact_digest
        );
        assert_eq!(first_bytes, second_bytes);
        assert!(
            !first_bytes
                .windows(canary.len())
                .any(|window| window == canary)
        );
        fs::remove_dir_all(root).expect("remove owned temporary test directory");
    }
}
