use crate::identity::IdentityContext;
use base64ct::{Base64UrlUnpadded, Encoding};
use rand_core::{OsRng, RngCore};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use smallframe_core::{key_id, verify_package_archive};
use std::{
    io::Write,
    process::{Command, Stdio},
};

const CONTENT_TYPE: &str = "application/vnd.smallframe.package";
const MAX_ARTIFACT: usize = 1_048_576;
const MAX_LOCAL_BETA_UPLOAD: usize = 8_192;

// Never derive Debug: this record holds the exact authorization credential.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UploadRecord {
    status: String,
    target_url: String,
    content_type: String,
    operation_id: String,
    publisher_key_id: String,
    api_token: String,
    package_digest: String,
    artifact_digest: String,
    request_bytes: String,
}

fn decode_canonical(value: &str, maximum: usize) -> Result<Vec<u8>, String> {
    if value.len() > maximum.div_ceil(3) * 4 {
        return Err("PACKAGE_UPLOAD_PENDING_INVALID".to_owned());
    }
    let bytes = Base64UrlUnpadded::decode_vec(value)
        .map_err(|_| "PACKAGE_UPLOAD_PENDING_INVALID".to_owned())?;
    if bytes.len() > maximum || Base64UrlUnpadded::encode_string(&bytes) != value {
        return Err("PACKAGE_UPLOAD_PENDING_INVALID".to_owned());
    }
    Ok(bytes)
}

fn valid_target(value: &str) -> bool {
    if value.len() > 2_048
        || value
            .bytes()
            .any(|b| b.is_ascii_control() || b.is_ascii_whitespace())
        || value.contains(['#', '?', '@', '\\'])
    {
        return false;
    }
    let (scheme, rest) = match value.split_once("://") {
        Some(parts) => parts,
        None => return false,
    };
    let (authority, path) = match rest.split_once('/') {
        Some(parts) => parts,
        None => return false,
    };
    if path != "v1/packages" || authority.is_empty() {
        return false;
    }
    let (host, port) = authority.split_once(':').unwrap_or((authority, ""));
    if authority.contains(':') && (port.parse::<u16>().ok().filter(|p| *p > 0).is_none()) {
        return false;
    }
    if host.is_empty()
        || !host
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-')
    {
        return false;
    }
    scheme == "https"
        || (scheme == "http"
            && (host == "localhost" || host == "127.0.0.1" || host.ends_with(".localhost")))
}

fn load_upload(ctx: &IdentityContext, digest: &str) -> Result<(UploadRecord, Vec<u8>), String> {
    let raw = ctx.load_upload_record(digest)?;
    let record: UploadRecord =
        serde_json::from_value(raw).map_err(|_| "PACKAGE_UPLOAD_PENDING_INVALID".to_owned())?;
    if !["PENDING", "CONFIRMED"].contains(&record.status.as_str())
        || record.content_type != CONTENT_TYPE
        || !valid_target(&record.target_url)
        || record.package_digest != digest
        || record.publisher_key_id != key_id(&ctx.signing_key()?.verifying_key().to_bytes())
        || decode_canonical(&record.operation_id, 16)?.len() != 16
        || decode_canonical(&record.api_token, 32)?.len() != 32
        || record.api_token != ctx.load_api_token()?
    {
        return Err("PACKAGE_UPLOAD_PENDING_INVALID".to_owned());
    }
    let bytes = decode_canonical(&record.request_bytes, MAX_ARTIFACT)?;
    let verified = verify_package_archive(&bytes, None, Some(&record.publisher_key_id))
        .map_err(|_| "PACKAGE_UPLOAD_PENDING_INVALID".to_owned())?;
    if record.artifact_digest != Base64UrlUnpadded::encode_string(&verified.artifact_digest)
        || record.package_digest != Base64UrlUnpadded::encode_string(&verified.package_digest)
    {
        return Err("PACKAGE_UPLOAD_PENDING_INVALID".to_owned());
    }
    Ok((record, bytes))
}

pub fn upload_package(
    ctx: &IdentityContext,
    api_url: &str,
    bytes: &[u8],
    digest: &str,
) -> Result<(), String> {
    // Preserve validation/replay of existing journals, but reject oversized new
    // local-beta uploads before saving credentials or contacting the server.
    if bytes.len() > MAX_LOCAL_BETA_UPLOAD {
        return Err("PACKAGE_UPLOAD_LOCAL_BETA_SIZE_LIMIT".to_owned());
    }
    let target = format!("{}/v1/packages", api_url.trim_end_matches('/'));
    if !valid_target(&target) {
        return Err("PACKAGE_UPLOAD_TARGET_INVALID".to_owned());
    }
    if ctx.upload_record_present(digest)? {
        let (record, saved) = load_upload(ctx, digest)?;
        if record.target_url != target || saved != bytes {
            return Err("PACKAGE_UPLOAD_REQUEST_CONFLICT".to_owned());
        }
        if record.status == "PENDING" {
            return Err(format!("PACKAGE_UPLOAD_PENDING:{digest}"));
        }
        return resume_upload(ctx, digest).map(|_| ());
    }
    let publisher = key_id(&ctx.signing_key()?.verifying_key().to_bytes());
    let verified = verify_package_archive(bytes, None, Some(&publisher))
        .map_err(|_| "PACKAGE_UPLOAD_ARTIFACT_INVALID".to_owned())?;
    if Base64UrlUnpadded::encode_string(&verified.package_digest) != digest {
        return Err("PACKAGE_UPLOAD_ARTIFACT_INVALID".to_owned());
    }
    let mut operation = [0_u8; 16];
    OsRng.fill_bytes(&mut operation);
    let record = UploadRecord {
        status: "PENDING".to_owned(),
        target_url: target,
        content_type: CONTENT_TYPE.to_owned(),
        operation_id: Base64UrlUnpadded::encode_string(&operation),
        publisher_key_id: publisher,
        api_token: ctx.load_api_token()?,
        package_digest: digest.to_owned(),
        artifact_digest: Base64UrlUnpadded::encode_string(&Sha256::digest(bytes)),
        request_bytes: Base64UrlUnpadded::encode_string(bytes),
    };
    let value =
        serde_json::to_value(record).map_err(|_| "PACKAGE_UPLOAD_SERIALIZE_FAILED".to_owned())?;
    ctx.save_upload_record(digest, &value)?;
    resume_upload(ctx, digest).map(|_| ())
}

pub fn upload_status(ctx: &IdentityContext, digest: &str) -> Result<Value, String> {
    let (record, _) = load_upload(ctx, digest)?;
    Ok(
        json!({"operationRef":format!("upload:{digest}"),"operationId":record.operation_id,
        "localStatus":record.status,"serverStatus":"UNKNOWN"}),
    )
}

pub fn resume_upload(ctx: &IdentityContext, digest: &str) -> Result<Value, String> {
    let (mut record, bytes) = load_upload(ctx, digest)?;
    let pending = || format!("PACKAGE_UPLOAD_PENDING:{digest}");
    let response = send_upload(&record, &bytes).map_err(|_| pending())?;
    verify_response(&response, &record, bytes.len()).map_err(|_| pending())?;
    if record.status == "PENDING" {
        record.status = "CONFIRMED".to_owned();
        ctx.replace_upload_record(
            digest,
            &serde_json::to_value(&record).map_err(|_| pending())?,
        )
        .map_err(|_| pending())?;
    }
    Ok(
        json!({"ok":true,"operationRef":format!("upload:{digest}"),"localStatus":"CONFIRMED",
        "packageDigest":record.package_digest,"artifactDigest":record.artifact_digest,
        "publisherKeyId":record.publisher_key_id}),
    )
}

fn verify_response(
    response: &Value,
    record: &UploadRecord,
    byte_length: usize,
) -> Result<(), String> {
    if response.as_object().map(|o| o.len()) != Some(5)
        || response.get("ok") != Some(&json!(true))
        || response.get("packageDigest").and_then(Value::as_str) != Some(&record.package_digest)
        || response.get("artifactDigest").and_then(Value::as_str) != Some(&record.artifact_digest)
        || response.get("publisherKeyId").and_then(Value::as_str) != Some(&record.publisher_key_id)
        || response.get("byteLength").and_then(Value::as_u64) != Some(byte_length as u64)
    {
        return Err("PACKAGE_UPLOAD_RESPONSE_MISMATCH".to_owned());
    }
    Ok(())
}

fn send_upload(record: &UploadRecord, bytes: &[u8]) -> Result<Value, String> {
    let mut child = Command::new("curl")
        .args([
            "-s",
            "-S",
            "-f",
            "--max-time",
            "10",
            "--max-filesize",
            "4096",
            "-X",
            "POST",
            &record.target_url,
            "-H",
            &format!("Content-Type: {}", record.content_type),
            "-H",
            "Origin: http://app.localhost:4173",
            "-H",
            &format!("Authorization: Bearer {}", record.api_token),
            "-H",
            &format!("X-Smallframe-Package-Digest: {}", record.package_digest),
            "-H",
            &format!("Idempotency-Key: {}", record.operation_id),
            "--data-binary",
            "@-",
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| "PACKAGE_UPLOAD_TRANSPORT_FAILED".to_owned())?;
    let sent = child
        .stdin
        .take()
        .ok_or("PACKAGE_UPLOAD_TRANSPORT_FAILED")?
        .write_all(bytes);
    if sent.is_err() {
        let _ = child.kill();
    }
    let output = child
        .wait_with_output()
        .map_err(|_| "PACKAGE_UPLOAD_TRANSPORT_FAILED".to_owned())?;
    if sent.is_err() || !output.status.success() || output.stdout.len() > 4096 {
        return Err("PACKAGE_UPLOAD_TRANSPORT_FAILED".to_owned());
    }
    smallframe_core::parse_strict_json(&output.stdout)
        .map_err(|_| "PACKAGE_UPLOAD_RESPONSE_INVALID".to_owned())
}

#[cfg(test)]
mod tests {
    use super::valid_target;

    #[test]
    fn upload_credentials_require_https_or_loopback_without_url_ambiguity() {
        for target in [
            "https://publisher.example/v1/packages",
            "http://127.0.0.1:8787/v1/packages",
            "http://api.localhost:8787/v1/packages",
        ] {
            assert!(valid_target(target));
        }
        for target in [
            "http://publisher.example/v1/packages",
            "http://127.0.0.1.attacker.example/v1/packages",
            "https://publisher.example@attacker.example/v1/packages",
            "https://publisher.example/v1/packages?x=y",
            "https://publisher.example/v1/packages#x",
            "https://publisher.example:0/v1/packages",
            "https://publisher.example:99999/v1/packages",
            "https://publisher.example\\attacker.example/v1/packages",
            "https://publisher.example/extra/v1/packages",
        ] {
            assert!(!valid_target(target));
        }
    }
}
