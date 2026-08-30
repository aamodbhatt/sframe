use crate::{CoreError, ErrorCode, Result};
use std::io::{Cursor, Read, Write};
use zip::{CompressionMethod, DateTime, ZipArchive, ZipWriter, write::SimpleFileOptions};

const PACKAGE_PATHS: [&str; 3] = ["app.worker.js", "signature.dsse.json", "smallframe.json"];
const MAX_PACKAGE_BYTES: u64 = 1024 * 1024;
const MAX_ARCHIVE_BYTES: usize = 1_100_000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PackageFiles {
    pub manifest: Vec<u8>,
    pub module: Vec<u8>,
    pub signature: Vec<u8>,
}

impl PackageFiles {
    #[must_use]
    pub fn total_bytes(&self) -> usize {
        self.manifest.len() + self.module.len() + self.signature.len()
    }

    fn by_path(&self, path: &str) -> Option<&[u8]> {
        match path {
            "app.worker.js" => Some(&self.module),
            "signature.dsse.json" => Some(&self.signature),
            "smallframe.json" => Some(&self.manifest),
            _ => None,
        }
    }
}

fn archive_error(detail: &'static str) -> CoreError {
    CoreError::new(ErrorCode::PackageArchiveInvalid, detail)
}

pub fn canonical_zip(files: &PackageFiles) -> Result<Vec<u8>> {
    if files.total_bytes() > MAX_PACKAGE_BYTES as usize {
        return Err(CoreError::new(
            ErrorCode::PackageSizeLimit,
            "expanded package exceeds 1 MiB",
        ));
    }
    let cursor = Cursor::new(Vec::with_capacity(files.total_bytes() + 1024));
    let mut archive = ZipWriter::new(cursor);
    let timestamp = DateTime::from_date_and_time(1980, 1, 1, 0, 0, 0)
        .map_err(|_| archive_error("invalid deterministic ZIP timestamp"))?;
    let options = SimpleFileOptions::default()
        .compression_method(CompressionMethod::Stored)
        .last_modified_time(timestamp)
        .unix_permissions(0o644);
    for path in PACKAGE_PATHS {
        archive
            .start_file(path, options)
            .map_err(|_| archive_error("failed to create deterministic ZIP entry"))?;
        archive
            .write_all(
                files
                    .by_path(path)
                    .ok_or_else(|| archive_error("missing package file"))?,
            )
            .map_err(|_| archive_error("failed to write deterministic ZIP entry"))?;
    }
    archive
        .finish()
        .map(Cursor::into_inner)
        .map_err(|_| archive_error("failed to finalize deterministic ZIP"))
}

fn read_entry(archive: &mut ZipArchive<Cursor<&[u8]>>, index: usize) -> Result<(String, Vec<u8>)> {
    let entry = archive
        .by_index(index)
        .map_err(|_| archive_error("cannot read ZIP entry"))?;
    let path = std::str::from_utf8(entry.name_raw())
        .map_err(|_| CoreError::new(ErrorCode::PackagePathInvalid, "ZIP path is not UTF-8"))?
        .to_owned();
    if !PACKAGE_PATHS.contains(&path.as_str())
        || path.contains(['/', '\\'])
        || !entry.is_file()
        || entry.is_symlink()
    {
        return Err(CoreError::new(
            ErrorCode::PackagePathInvalid,
            "forbidden ZIP entry path or type",
        ));
    }
    if entry.compression() != CompressionMethod::Stored
        || entry.size() > MAX_PACKAGE_BYTES
        || entry.compressed_size() == 0 && entry.size() != 0
        || entry.compressed_size() > 0 && entry.size() / entry.compressed_size() > 100
    {
        return Err(CoreError::new(
            ErrorCode::PackageSizeLimit,
            "ZIP entry bounds are invalid",
        ));
    }
    let entry_size = entry.size();
    let declared = usize::try_from(entry_size)
        .map_err(|_| CoreError::new(ErrorCode::PackageSizeLimit, "ZIP entry length overflows"))?;
    let mut bytes = Vec::with_capacity(declared);
    entry
        .take(entry_size.saturating_add(1))
        .read_to_end(&mut bytes)
        .map_err(|_| archive_error("failed to read ZIP entry"))?;
    if bytes.len() != declared {
        return Err(archive_error("ZIP expanded size mismatch"));
    }
    Ok((path, bytes))
}

pub(crate) fn read_zip_bounded(input: &[u8]) -> Result<PackageFiles> {
    if input.len() > MAX_ARCHIVE_BYTES {
        return Err(CoreError::new(
            ErrorCode::PackageSizeLimit,
            "archive exceeds bounded size",
        ));
    }
    let mut archive = ZipArchive::new(Cursor::new(input))
        .map_err(|_| archive_error("malformed ZIP central directory"))?;
    if archive.len() != PACKAGE_PATHS.len() {
        return Err(CoreError::new(
            ErrorCode::PackageEntryCountInvalid,
            "archive must contain exactly three entries",
        ));
    }
    let mut manifest = None;
    let mut module = None;
    let mut signature = None;
    let mut total = 0usize;
    for index in 0..archive.len() {
        let (path, bytes) = read_entry(&mut archive, index)?;
        total = total.checked_add(bytes.len()).ok_or_else(|| {
            CoreError::new(
                ErrorCode::PackageSizeLimit,
                "expanded package length overflow",
            )
        })?;
        if total > MAX_PACKAGE_BYTES as usize {
            return Err(CoreError::new(
                ErrorCode::PackageSizeLimit,
                "expanded package exceeds 1 MiB",
            ));
        }
        let target = match path.as_str() {
            "smallframe.json" => &mut manifest,
            "app.worker.js" => &mut module,
            "signature.dsse.json" => &mut signature,
            _ => {
                return Err(CoreError::new(
                    ErrorCode::PackagePathInvalid,
                    "unknown package path",
                ));
            }
        };
        if target.replace(bytes).is_some() {
            return Err(CoreError::new(
                ErrorCode::PackagePathInvalid,
                "duplicate package path",
            ));
        }
    }
    Ok(PackageFiles {
        manifest: manifest.ok_or_else(|| archive_error("missing manifest"))?,
        module: module.ok_or_else(|| archive_error("missing module"))?,
        signature: signature.ok_or_else(|| archive_error("missing signature"))?,
    })
}

pub fn read_canonical_zip(input: &[u8]) -> Result<PackageFiles> {
    let files = read_zip_bounded(input)?;
    let canonical = canonical_zip(&files)?;
    if input != canonical {
        return Err(CoreError::new(
            ErrorCode::PackageArchiveNoncanonical,
            "archive is not the deterministic STORE encoding",
        ));
    }
    Ok(files)
}
