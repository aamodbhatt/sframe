#![forbid(unsafe_code)]

mod archive;
mod dsse;
mod encoding;
mod error;
mod json;
mod manifest;
mod module_source;
mod package;
mod state_schema;

pub(crate) use archive::read_zip_bounded;
pub use archive::{PackageFiles, canonical_zip, read_canonical_zip};
pub use dsse::{
    DsseEnvelope, create_dsse_envelope, dsse_pae, sign_dsse_pae, verify_dsse_envelope,
    verify_dsse_pae,
};
pub use error::{CoreError, ErrorCode, Result};
pub use json::{canonical_json, canonical_json_bytes, parse_strict_json};
pub use manifest::{ValidatedManifest, validate_manifest};
pub use module_source::validate_module_source;
pub use package::{
    ValidatedSource, VerifiedPackage, artifact_digest, build_signed_package, hex_digest, key_id,
    package_digest, sha256, validate_source_files, verify_package_archive, verify_package_files,
};

#[cfg(feature = "wasm")]
mod wasm;
