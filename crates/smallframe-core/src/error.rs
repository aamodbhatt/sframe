use serde::Serialize;
use std::fmt::{Display, Formatter};

pub type Result<T> = std::result::Result<T, CoreError>;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ErrorCode {
    JsonInvalid,
    JsonDuplicateKey,
    JsonNonIjsonNumber,
    JsonNotCanonical,
    ManifestSchemaInvalid,
    ManifestSemanticInvalid,
    ManifestUnicodeInvalid,
    ManifestCapabilityInvalid,
    ManifestFileSetInvalid,
    ManifestSchemaComplexity,
    ManifestTemplateInvalid,
    AppModuleTooLarge,
    AppModuleSyntaxInvalid,
    AppModuleImportForbidden,
    AppModuleSourceMapForbidden,
    PackagePathInvalid,
    PackageEntryCountInvalid,
    PackageSizeLimit,
    PackageArchiveInvalid,
    PackageArchiveNoncanonical,
    PackageFileSizeMismatch,
    PackageFileHashMismatch,
    PublisherKeyInvalid,
    PublisherKeyIdMismatch,
    DsseInvalid,
    DssePayloadTypeInvalid,
    DssePayloadMismatch,
    SignatureInvalid,
    PackageDigestMismatch,
    ArtifactDigestMismatch,
    IoError,
}

impl ErrorCode {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::JsonInvalid => "JSON_INVALID",
            Self::JsonDuplicateKey => "JSON_DUPLICATE_KEY",
            Self::JsonNonIjsonNumber => "JSON_NON_IJSON_NUMBER",
            Self::JsonNotCanonical => "JSON_NOT_CANONICAL",
            Self::ManifestSchemaInvalid => "MANIFEST_SCHEMA_INVALID",
            Self::ManifestSemanticInvalid => "MANIFEST_SEMANTIC_INVALID",
            Self::ManifestUnicodeInvalid => "MANIFEST_UNICODE_INVALID",
            Self::ManifestCapabilityInvalid => "MANIFEST_CAPABILITY_INVALID",
            Self::ManifestFileSetInvalid => "MANIFEST_FILE_SET_INVALID",
            Self::ManifestSchemaComplexity => "MANIFEST_SCHEMA_COMPLEXITY",
            Self::ManifestTemplateInvalid => "MANIFEST_TEMPLATE_INVALID",
            Self::AppModuleTooLarge => "APP_MODULE_TOO_LARGE",
            Self::AppModuleSyntaxInvalid => "APP_MODULE_SYNTAX_INVALID",
            Self::AppModuleImportForbidden => "APP_MODULE_IMPORT_FORBIDDEN",
            Self::AppModuleSourceMapForbidden => "APP_MODULE_SOURCE_MAP_FORBIDDEN",
            Self::PackagePathInvalid => "PACKAGE_PATH_INVALID",
            Self::PackageEntryCountInvalid => "PACKAGE_ENTRY_COUNT_INVALID",
            Self::PackageSizeLimit => "PACKAGE_SIZE_LIMIT",
            Self::PackageArchiveInvalid => "PACKAGE_ARCHIVE_INVALID",
            Self::PackageArchiveNoncanonical => "PACKAGE_ARCHIVE_NONCANONICAL",
            Self::PackageFileSizeMismatch => "PACKAGE_FILE_SIZE_MISMATCH",
            Self::PackageFileHashMismatch => "PACKAGE_FILE_HASH_MISMATCH",
            Self::PublisherKeyInvalid => "PUBLISHER_KEY_INVALID",
            Self::PublisherKeyIdMismatch => "PUBLISHER_KEY_ID_MISMATCH",
            Self::DsseInvalid => "DSSE_INVALID",
            Self::DssePayloadTypeInvalid => "DSSE_PAYLOAD_TYPE_INVALID",
            Self::DssePayloadMismatch => "DSSE_PAYLOAD_MISMATCH",
            Self::SignatureInvalid => "SIGNATURE_INVALID",
            Self::PackageDigestMismatch => "PACKAGE_DIGEST_MISMATCH",
            Self::ArtifactDigestMismatch => "ARTIFACT_DIGEST_MISMATCH",
            Self::IoError => "IO_ERROR",
        }
    }
}

impl Display for ErrorCode {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.as_str())
    }
}

#[derive(Debug)]
pub struct CoreError {
    code: ErrorCode,
    detail: &'static str,
}

impl CoreError {
    #[must_use]
    pub const fn new(code: ErrorCode, detail: &'static str) -> Self {
        Self { code, detail }
    }

    #[must_use]
    pub const fn code(&self) -> ErrorCode {
        self.code
    }

    #[must_use]
    pub const fn detail(&self) -> &'static str {
        self.detail
    }
}

impl Display for CoreError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}: {}", self.code, self.detail)
    }
}

impl std::error::Error for CoreError {}
