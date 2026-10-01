#![forbid(unsafe_code)]

use base64ct::{Base64UrlUnpadded, Encoding};
use ed25519_dalek::{Signature, Signer, SigningKey};
use rand_core::{OsRng, RngCore};
use serde_json::json;
use sha2::{Digest, Sha256};
use smallframe_core::{
    dsse_pae, key_id, parse_strict_json, validate_state_schema, verify_package_archive,
};
use std::{
    fs,
    io::Write,
    path::Path,
    process::{Command as ProcessCommand, Stdio},
    time::{SystemTime, UNIX_EPOCH},
};

use crate::app::{pack, validate_path};
use crate::identity::IdentityContext;
use crate::snapshot::encrypt_genesis;

const ENROLLMENT_PAYLOAD_TYPE: &str = "application/vnd.smallframe.publisher-enrollment.v1+json";
const DESCRIPTOR_PAYLOAD_TYPE: &str = "application/vnd.smallframe.room-descriptor.v1+json";

fn jcs_bytes(val: &serde_json::Value) -> Result<Vec<u8>, String> {
    serde_jcs::to_vec(val).map_err(|_| "CANONICALIZE_FAILED".to_owned())
}

fn http_post_json(
    url: &str,
    body: &serde_json::Value,
    auth_header: Option<&str>,
    if_match: Option<&str>,
) -> Result<serde_json::Value, String> {
    let body_bytes = serde_json::to_vec(body).map_err(|_| "SERIALIZE_FAILED".to_owned())?;
    http_post_json_bytes(url, &body_bytes, auth_header, if_match)
}

fn http_post_json_bytes(
    url: &str,
    body_bytes: &[u8],
    auth_header: Option<&str>,
    if_match: Option<&str>,
) -> Result<serde_json::Value, String> {
    let mut cmd = ProcessCommand::new("curl");
    cmd.args([
        "-s",
        "-S",
        "-f",
        "-X",
        "POST",
        url,
        "-H",
        "Content-Type: application/json",
        "-H",
        "Origin: http://app.localhost:4173",
    ]);
    if let Some(auth) = auth_header {
        cmd.args(["-H", &format!("Authorization: {auth}")]);
    }
    if let Some(etag) = if_match {
        cmd.args(["-H", &format!("If-Match: {etag}")]);
    }
    cmd.args(["--data-binary", "@-"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = cmd.spawn().map_err(|_| "HTTP_REQUEST_FAILED".to_owned())?;
    child
        .stdin
        .take()
        .ok_or("HTTP_REQUEST_FAILED")?
        .write_all(body_bytes)
        .map_err(|_| "HTTP_REQUEST_FAILED".to_owned())?;
    let output = child
        .wait_with_output()
        .map_err(|_| "HTTP_REQUEST_FAILED".to_owned())?;
    let response_str = String::from_utf8_lossy(&output.stdout);
    if !output.status.success() {
        return Err(format!(
            "HTTP_ERROR: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }

    serde_json::from_str(&response_str).map_err(|_| "HTTP_RESPONSE_INVALID".to_owned())
}

fn http_get_json(url: &str, auth_header: Option<&str>) -> Result<serde_json::Value, String> {
    let mut cmd = ProcessCommand::new("curl");
    cmd.args([
        "-s",
        "-S",
        "-X",
        "GET",
        url,
        "-H",
        "Origin: http://app.localhost:4173",
    ]);
    if let Some(auth) = auth_header {
        cmd.args(["-H", &format!("Authorization: {auth}")]);
    }

    let output = cmd
        .output()
        .map_err(|e| format!("HTTP_REQUEST_FAILED: {e}"))?;
    let response_str = String::from_utf8_lossy(&output.stdout);
    if !output.status.success() {
        return Err(format!(
            "HTTP_ERROR: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }

    serde_json::from_str(&response_str).map_err(|_| "HTTP_RESPONSE_INVALID".to_owned())
}

pub fn enroll_publisher(
    ctx: &IdentityContext,
    invite_file: Option<&Path>,
    api_url: &str,
) -> Result<serde_json::Value, String> {
    let (pending, active) = ctx.enrollment_files_present();
    if pending {
        return Err("ENROLLMENT_PENDING_USE_OPERATIONS_RESUME".to_owned());
    }
    if active {
        return Err("PUBLISHER_ALREADY_ENROLLED".to_owned());
    }
    let invite_code = if let Some(path) = invite_file {
        let metadata = fs::metadata(path).map_err(|_| "INVITE_FILE_READ_FAILED".to_owned())?;
        if !metadata.is_file() || metadata.len() > 256 {
            return Err("INVITE_FILE_INVALID".to_owned());
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if metadata.permissions().mode() & 0o077 != 0 {
                return Err("INVITE_FILE_PERMISSIONS_INVALID".to_owned());
            }
        }
        fs::read_to_string(path).map_err(|_| "INVITE_FILE_READ_FAILED".to_owned())?
    } else {
        rpassword::prompt_password("Publisher invite code: ")
            .map_err(|_| "INVITE_PROMPT_FAILED".to_owned())?
    };
    let invite_code = invite_code.trim();
    if invite_code.len() < 16 || invite_code.len() > 256 {
        return Err("INVITE_CODE_INVALID".to_owned());
    }

    let signing_key = ctx.signing_key()?;
    let pub_key = signing_key.verifying_key().to_bytes();
    let pub_key_base64url = Base64UrlUnpadded::encode_string(&pub_key);
    let pub_key_id = key_id(&pub_key);

    let mut raw_token = [0_u8; 32];
    let mut operation_id = [0_u8; 16];
    OsRng.fill_bytes(&mut raw_token);
    OsRng.fill_bytes(&mut operation_id);

    let token_hash = Sha256::digest(raw_token);
    let invite_code_hash = Sha256::digest(invite_code.as_bytes());

    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "TIME_FAILED".to_owned())?
        .as_millis() as u64;

    let enrollment_record = json!({
        "protocolVersion": 1,
        "publisherPublicKey": pub_key_base64url,
        "publisherKeyId": pub_key_id,
        "tokenHash": Base64UrlUnpadded::encode_string(&token_hash),
        "operationId": Base64UrlUnpadded::encode_string(&operation_id),
        "inviteCodeHash": Base64UrlUnpadded::encode_string(&invite_code_hash),
        "createdAt": now_ms
    });

    let jcs = jcs_bytes(&enrollment_record)?;
    let pae = dsse_pae(ENROLLMENT_PAYLOAD_TYPE, &jcs);
    let signature = signing_key.sign(&pae);

    let request_body = json!({
        "jcsBytes": Base64UrlUnpadded::encode_string(&jcs),
        "signature": Base64UrlUnpadded::encode_string(&signature.to_bytes())
    });

    let token_str = Base64UrlUnpadded::encode_string(&raw_token);
    let request_bytes = serde_json::to_vec(&request_body).map_err(|_| "SERIALIZE_FAILED")?;
    let enroll_url = format!("{}/v1/enroll", api_url.trim_end_matches('/'));
    if !valid_enrollment_target(&enroll_url) {
        return Err("ENROLLMENT_TARGET_INVALID".to_owned());
    }
    let pending_record = json!({
        "status":"PENDING", "targetUrl":enroll_url,
        "publisherKeyId":pub_key_id, "operationId":Base64UrlUnpadded::encode_string(&operation_id),
        "apiToken":token_str,
        "requestBytes":Base64UrlUnpadded::encode_string(&request_bytes),
        "requestSha256":Base64UrlUnpadded::encode_string(&Sha256::digest(&request_bytes)),
    });
    ctx.save_pending_enrollment(&pending_record)?;
    let response = http_post_json_bytes(&enroll_url, &request_bytes, None, None)
        .map_err(|_| "ENROLLMENT_PENDING_USE_OPERATIONS_RESUME".to_owned())?;
    verify_enrollment_response(&response, &pub_key_id)?;
    ctx.confirm_pending_enrollment(&token_str)?;

    Ok(json!({
        "ok": true,
        "publisherKeyId": pub_key_id,
        "enrolled": true,
        "operationRef":"enrollment",
        "response": response
    }))
}

fn valid_enrollment_target(target: &str) -> bool {
    target.len() <= 2_048
        && (target.starts_with("http://") || target.starts_with("https://"))
        && target.ends_with("/v1/enroll")
        && !target.contains(['#', '?', '@', ' ', '\n', '\r'])
}

fn verify_enrollment_response(
    response: &serde_json::Value,
    publisher_key_id: &str,
) -> Result<(), String> {
    if response.as_object().map(|object| object.len()) != Some(3)
        || response.get("ok").and_then(serde_json::Value::as_bool) != Some(true)
        || response
            .get("publisherKeyId")
            .and_then(serde_json::Value::as_str)
            != Some(publisher_key_id)
        || response
            .get("enrolledAt")
            .and_then(serde_json::Value::as_u64)
            .is_none()
    {
        return Err("ENROLLMENT_RESPONSE_MISMATCH".to_owned());
    }
    Ok(())
}

fn pending_enrollment_record(
    ctx: &IdentityContext,
) -> Result<(serde_json::Value, Vec<u8>, String), String> {
    let record = ctx.load_pending_enrollment()?;
    let invalid = || "ENROLLMENT_PENDING_INVALID".to_owned();
    if record.get("status").and_then(serde_json::Value::as_str) != Some("PENDING") {
        return Err(invalid());
    }
    let target = record
        .get("targetUrl")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(invalid)?;
    if !valid_enrollment_target(target) {
        return Err(invalid());
    }
    let publisher_key_id = record
        .get("publisherKeyId")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(invalid)?;
    if key_id(&ctx.signing_key()?.verifying_key().to_bytes()) != publisher_key_id {
        return Err(invalid());
    }
    let token = record
        .get("apiToken")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(invalid)?
        .to_owned();
    let token_bytes = Base64UrlUnpadded::decode_vec(&token).map_err(|_| invalid())?;
    if token_bytes.len() != 32 || Base64UrlUnpadded::encode_string(&token_bytes) != token {
        return Err(invalid());
    }
    let encoded = record
        .get("requestBytes")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(invalid)?;
    if encoded.len() > 2_731 {
        return Err(invalid());
    }
    let bytes = Base64UrlUnpadded::decode_vec(encoded).map_err(|_| invalid())?;
    if bytes.len() > 2_048
        || Base64UrlUnpadded::encode_string(&bytes) != encoded
        || record
            .get("requestSha256")
            .and_then(serde_json::Value::as_str)
            != Some(Base64UrlUnpadded::encode_string(&Sha256::digest(&bytes)).as_str())
    {
        return Err(invalid());
    }
    let request = parse_strict_json(&bytes).map_err(|_| invalid())?;
    if request.as_object().map(|object| object.len()) != Some(2) {
        return Err(invalid());
    }
    let jcs_encoded = request
        .get("jcsBytes")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(invalid)?;
    if jcs_encoded.len() > 1_366 {
        return Err(invalid());
    }
    let jcs = Base64UrlUnpadded::decode_vec(jcs_encoded).map_err(|_| invalid())?;
    if jcs.len() > 1_024 || Base64UrlUnpadded::encode_string(&jcs) != jcs_encoded {
        return Err(invalid());
    }
    let signed = parse_strict_json(&jcs).map_err(|_| invalid())?;
    verify_pending_enrollment_statement(ctx, &request, &signed, &jcs)?;
    if signed
        .get("publisherKeyId")
        .and_then(serde_json::Value::as_str)
        != Some(publisher_key_id)
        || signed.get("operationId") != record.get("operationId")
        || signed.get("tokenHash").and_then(serde_json::Value::as_str)
            != Some(Base64UrlUnpadded::encode_string(&Sha256::digest(&token_bytes)).as_str())
    {
        return Err(invalid());
    }
    Ok((record, bytes, token))
}

fn verify_pending_enrollment_statement(
    ctx: &IdentityContext,
    request: &serde_json::Value,
    signed: &serde_json::Value,
    jcs: &[u8],
) -> Result<(), String> {
    let invalid = || "ENROLLMENT_PENDING_INVALID".to_owned();
    let key = ctx.signing_key()?.verifying_key();
    if signed.as_object().map(|object| object.len()) != Some(7)
        || signed.get("protocolVersion") != Some(&json!(1))
        || signed
            .get("publisherPublicKey")
            .and_then(serde_json::Value::as_str)
            != Some(Base64UrlUnpadded::encode_string(key.as_bytes()).as_str())
        || jcs_bytes(signed)? != jcs
    {
        return Err(invalid());
    }
    let encoded = request
        .get("signature")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(invalid)?;
    let bytes = Base64UrlUnpadded::decode_vec(encoded).map_err(|_| invalid())?;
    if bytes.len() != 64 || Base64UrlUnpadded::encode_string(&bytes) != encoded {
        return Err(invalid());
    }
    let signature = Signature::from_slice(&bytes).map_err(|_| invalid())?;
    key.verify_strict(&dsse_pae(ENROLLMENT_PAYLOAD_TYPE, jcs), &signature)
        .map_err(|_| invalid())
}

pub fn enrollment_operation_status(ctx: &IdentityContext) -> Result<serde_json::Value, String> {
    let (pending, active) = ctx.enrollment_files_present();
    if pending {
        let (record, _, _) = pending_enrollment_record(ctx)?;
        return Ok(
            json!({"operationRef":"enrollment", "operationId":record["operationId"],
            "localStatus":"PENDING", "serverStatus":"UNKNOWN"}),
        );
    }
    if active {
        ctx.load_api_token()?;
        return Ok(
            json!({"operationRef":"enrollment", "localStatus":"CONFIRMED",
            "serverStatus":"UNKNOWN"}),
        );
    }
    Err("ENROLLMENT_OPERATION_NOT_FOUND".to_owned())
}

pub fn resume_enrollment_operation(ctx: &IdentityContext) -> Result<serde_json::Value, String> {
    let (record, bytes, token) = pending_enrollment_record(ctx)?;
    let target = record
        .get("targetUrl")
        .and_then(serde_json::Value::as_str)
        .ok_or("ENROLLMENT_PENDING_INVALID")?;
    let publisher_key_id = record
        .get("publisherKeyId")
        .and_then(serde_json::Value::as_str)
        .ok_or("ENROLLMENT_PENDING_INVALID")?;
    let response = http_post_json_bytes(target, &bytes, None, None)
        .map_err(|_| "ENROLLMENT_STILL_PENDING".to_owned())?;
    verify_enrollment_response(&response, publisher_key_id)?;
    ctx.confirm_pending_enrollment(&token)?;
    Ok(
        json!({"ok":true,"operationRef":"enrollment","publisherKeyId":publisher_key_id,
        "enrolled":true,"response":response}),
    )
}

pub fn publish_package(
    ctx: &IdentityContext,
    path: &Path,
    initial_state: Option<&Path>,
    expires_in_hours: Option<u64>,
    show_secrets: bool,
    api_url: &str,
    controller_url: &str,
) -> Result<serde_json::Value, String> {
    let signing_key = ctx.signing_key()?;
    let pub_key = signing_key.verifying_key().to_bytes();
    let publisher_key_id = key_id(&pub_key);

    // 1. Validate and pack
    validate_path(path)?;
    let temp_pkg_path = std::env::temp_dir().join(format!("sf-pack-{}.zip", std::process::id()));
    let summary = pack(path, &temp_pkg_path, &signing_key)?;
    let pkg_bytes = fs::read(&temp_pkg_path).map_err(|e| format!("READ_PACK_FAILED: {e}"))?;
    let _ = fs::remove_file(&temp_pkg_path);

    let verified = verify_package_archive(&pkg_bytes, None, Some(&publisher_key_id))
        .map_err(|_| "PACK_VERIFY_FAILED".to_owned())?;
    let pkg_digest = summary.package_digest;
    if Base64UrlUnpadded::encode_string(&verified.package_digest) != pkg_digest
        || Base64UrlUnpadded::encode_string(&verified.artifact_digest) != summary.artifact_digest
    {
        return Err("PACK_DIGEST_MISMATCH".to_owned());
    }
    let manifest = parse_strict_json(&verified.canonical_files.manifest)
        .map_err(|_| "MANIFEST_INVALID".to_owned())?;
    let app_id = manifest
        .get("id")
        .and_then(serde_json::Value::as_str)
        .ok_or("MANIFEST_ID_INVALID")?;
    let state = manifest.get("state").ok_or("MANIFEST_STATE_INVALID")?;
    if state.get("mode").and_then(serde_json::Value::as_str) != Some("shared") {
        return Err("PUBLISH_REQUIRES_SHARED_PACKAGE".to_owned());
    }
    let initial = if let Some(file) = initial_state {
        let metadata = fs::metadata(file).map_err(|_| "INITIAL_STATE_READ_FAILED".to_owned())?;
        if !metadata.is_file() || metadata.len() > 393_216 {
            return Err("INITIAL_STATE_SIZE_LIMIT".to_owned());
        }
        parse_strict_json(&fs::read(file).map_err(|_| "INITIAL_STATE_READ_FAILED".to_owned())?)
            .map_err(|_| "INITIAL_STATE_INVALID".to_owned())?
    } else {
        state
            .get("publicTemplate")
            .cloned()
            .unwrap_or_else(|| json!({}))
    };
    let schema = state.get("jsonSchema").ok_or("STATE_SCHEMA_MISSING")?;
    if !initial.is_object() {
        return Err("INITIAL_STATE_INVALID".to_owned());
    }
    validate_state_schema(schema, &initial)
        .map_err(|_| "INITIAL_STATE_SCHEMA_INVALID".to_owned())?;
    let initial_json = jcs_bytes(&initial)?;
    if initial_json.len() > 393_216 {
        return Err("INITIAL_STATE_SIZE_LIMIT".to_owned());
    }

    // 2. Upload package
    let token = ctx.load_api_token()?;
    crate::upload::upload_package(ctx, api_url, &pkg_bytes, &pkg_digest)?;

    // 3. Generate room parameters
    let mut room_id_bytes = [0_u8; 16];
    let mut room_key_bytes = [0_u8; 32];
    let mut viewer_cap_bytes = [0_u8; 32];
    let mut editor_cap_bytes = [0_u8; 32];
    let mut op_id_bytes = [0_u8; 16];

    OsRng.fill_bytes(&mut room_id_bytes);
    OsRng.fill_bytes(&mut room_key_bytes);
    OsRng.fill_bytes(&mut viewer_cap_bytes);
    OsRng.fill_bytes(&mut editor_cap_bytes);
    OsRng.fill_bytes(&mut op_id_bytes);

    let room_id = Base64UrlUnpadded::encode_string(&room_id_bytes);
    let writer_signing_key = SigningKey::generate(&mut OsRng);
    let writer_pub_key = writer_signing_key.verifying_key().to_bytes();
    let writer_pub_str = Base64UrlUnpadded::encode_string(&writer_pub_key);
    let writer_priv_str = Base64UrlUnpadded::encode_string(&writer_signing_key.to_bytes());

    let viewer_cap_hash = Base64UrlUnpadded::encode_string(&Sha256::digest(viewer_cap_bytes));
    let editor_cap_hash = Base64UrlUnpadded::encode_string(&Sha256::digest(editor_cap_bytes));

    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "TIME_FAILED".to_owned())?
        .as_millis() as u64;

    let hours = expires_in_hours.unwrap_or(7 * 24);
    if !(1..=30 * 24).contains(&hours) {
        return Err("EXPIRY_OUT_OF_RANGE".to_owned());
    }
    let duration_ms = hours.checked_mul(3_600_000).ok_or("EXPIRY_OUT_OF_RANGE")?;
    let expires_at = now_ms
        .checked_add(duration_ms)
        .ok_or("EXPIRY_OUT_OF_RANGE")?;

    // 4. Create and sign descriptors
    let viewer_desc = json!({
        "protocolVersion": 1,
        "roomId": room_id,
        "packageDigest": pkg_digest,
        "publisherKeyId": publisher_key_id,
        "writerPublicKey": writer_pub_str,
        "capabilityHash": viewer_cap_hash,
        "role": "viewer",
        "expiresAt": expires_at
    });

    let editor_desc = json!({
        "protocolVersion": 1,
        "roomId": room_id,
        "packageDigest": pkg_digest,
        "publisherKeyId": publisher_key_id,
        "writerPublicKey": writer_pub_str,
        "capabilityHash": editor_cap_hash,
        "role": "editor",
        "expiresAt": expires_at
    });

    let viewer_jcs = jcs_bytes(&viewer_desc)?;
    let viewer_sig = signing_key.sign(&dsse_pae(DESCRIPTOR_PAYLOAD_TYPE, &viewer_jcs));

    let editor_jcs = jcs_bytes(&editor_desc)?;
    let editor_sig = signing_key.sign(&dsse_pae(DESCRIPTOR_PAYLOAD_TYPE, &editor_jcs));

    // 5. Initial genesis state
    let mut actor = [0_u8; 16];
    OsRng.fill_bytes(&mut actor);
    let genesis_bytes = smallframe_core::crdt::create_genesis_document(
        std::str::from_utf8(&initial_json).map_err(|_| "INITIAL_STATE_INVALID".to_owned())?,
        &actor,
    )?;
    let envelope = encrypt_genesis(
        &room_key_bytes,
        &writer_signing_key,
        &room_id,
        app_id,
        &pkg_digest,
        &genesis_bytes,
    )?;

    let room_creation_body = json!({
        "operationId": Base64UrlUnpadded::encode_string(&op_id_bytes),
        "roomId": room_id,
        "packageDigest": pkg_digest,
        "viewerDescriptorJcs": Base64UrlUnpadded::encode_string(&viewer_jcs),
        "viewerDescriptorSignature": Base64UrlUnpadded::encode_string(&viewer_sig.to_bytes()),
        "editorDescriptorJcs": Base64UrlUnpadded::encode_string(&editor_jcs),
        "editorDescriptorSignature": Base64UrlUnpadded::encode_string(&editor_sig.to_bytes()),
        "envelope": envelope
    });
    let request_bytes = serde_json::to_vec(&room_creation_body)
        .map_err(|_| "ROOM_CREATION_SERIALIZE_FAILED".to_owned())?;

    // Keep the exact encrypted request and room secrets before the first room
    // send. An ambiguous response leaves this pending record available.
    let room_record = json!({
        "roomId": room_id,
        "packageDigest": pkg_digest,
        "roomKey": Base64UrlUnpadded::encode_string(&room_key_bytes),
        "viewerCapability": Base64UrlUnpadded::encode_string(&viewer_cap_bytes),
        "editorCapability": Base64UrlUnpadded::encode_string(&editor_cap_bytes),
        "writerPrivateKey": writer_priv_str,
        "writerPublicKey": writer_pub_str,
        "expiresAt": expires_at,
        "publisherKeyId": publisher_key_id,
        "apiUrl": api_url.trim_end_matches('/'),
        "controllerUrl": controller_url.trim_end_matches('/'),
        "status": "PENDING",
        "creationRequestBytes": Base64UrlUnpadded::encode_string(&request_bytes),
        "creationRequestSha256": Base64UrlUnpadded::encode_string(&Sha256::digest(&request_bytes))
    });
    ctx.save_room_record(&room_id, &room_record)?;

    let rooms_url = format!("{}/v1/rooms", api_url.trim_end_matches('/'));
    let room_res = http_post_json_bytes(
        &rooms_url,
        &request_bytes,
        Some(&format!("Bearer {token}")),
        None,
    )
    .map_err(|_| format!("ROOM_CREATION_PENDING:{room_id}"))?;
    verify_room_creation_response(&room_res, &room_id, &pkg_digest, &publisher_key_id)
        .map_err(|_| format!("ROOM_CREATION_PENDING:{room_id}"))?;
    let mut confirmed_record = room_record;
    confirmed_record["status"] = json!("CONFIRMED");
    ctx.replace_room_record(&room_id, &confirmed_record)
        .map_err(|_| format!("ROOM_CREATION_PENDING:{room_id}"))?;

    // 7. Construct invite URLs
    let viewer_d = Base64UrlUnpadded::encode_string(&viewer_jcs);
    let viewer_s = Base64UrlUnpadded::encode_string(&viewer_sig.to_bytes());
    let k = Base64UrlUnpadded::encode_string(&room_key_bytes);
    let viewer_c = Base64UrlUnpadded::encode_string(&viewer_cap_bytes);

    let editor_d = Base64UrlUnpadded::encode_string(&editor_jcs);
    let editor_s = Base64UrlUnpadded::encode_string(&editor_sig.to_bytes());
    let w = writer_priv_str;
    let editor_c = Base64UrlUnpadded::encode_string(&editor_cap_bytes);

    let viewer_invite = format!(
        "{}/r/{}#v=1&d={}&s={}&k={}&c={}",
        controller_url.trim_end_matches('/'),
        room_id,
        viewer_d,
        viewer_s,
        k,
        viewer_c
    );
    let editor_invite = format!(
        "{}/r/{}#v=1&d={}&s={}&w={}&k={}&c={}",
        controller_url.trim_end_matches('/'),
        room_id,
        editor_d,
        editor_s,
        w,
        k,
        editor_c
    );

    let result = if show_secrets {
        json!({
            "ok": true,
            "roomId": room_id,
            "packageDigest": pkg_digest,
            "publisherKeyId": publisher_key_id,
            "expiresAt": expires_at,
            "operationRef": room_id,
            "viewerInviteUrl": viewer_invite,
            "editorInviteUrl": editor_invite
        })
    } else {
        json!({
            "ok": true,
            "roomId": room_id,
            "packageDigest": pkg_digest,
            "publisherKeyId": publisher_key_id,
            "expiresAt": expires_at,
            "operationRef": room_id
        })
    };

    Ok(result)
}

fn verify_room_creation_response(
    response: &serde_json::Value,
    room_id: &str,
    package_digest: &str,
    publisher_key_id: &str,
) -> Result<(), String> {
    if response.get("ok").and_then(serde_json::Value::as_bool) != Some(true)
        || response.get("roomId").and_then(serde_json::Value::as_str) != Some(room_id)
        || response
            .get("packageDigest")
            .and_then(serde_json::Value::as_str)
            != Some(package_digest)
        || response
            .get("publisherKeyId")
            .and_then(serde_json::Value::as_str)
            != Some(publisher_key_id)
    {
        return Err("ROOM_CREATION_RESPONSE_MISMATCH".to_owned());
    }
    Ok(())
}

fn room_operation_record(
    ctx: &IdentityContext,
    room_id: &str,
) -> Result<(serde_json::Value, Vec<u8>, serde_json::Value), String> {
    let record = ctx.load_room_record(room_id)?;
    if record.get("roomId").and_then(serde_json::Value::as_str) != Some(room_id)
        || !matches!(
            record.get("status").and_then(serde_json::Value::as_str),
            Some("PENDING" | "CONFIRMED")
        )
    {
        return Err("OPERATION_RECORD_INVALID".to_owned());
    }
    let encoded = record
        .get("creationRequestBytes")
        .and_then(serde_json::Value::as_str)
        .ok_or("OPERATION_RECORD_INVALID")?;
    if encoded.len() > 966_656 {
        return Err("OPERATION_RECORD_INVALID".to_owned());
    }
    let bytes = Base64UrlUnpadded::decode_vec(encoded)
        .map_err(|_| "OPERATION_RECORD_INVALID".to_owned())?;
    if bytes.len() > 724_992
        || Base64UrlUnpadded::encode_string(&bytes) != encoded
        || record
            .get("creationRequestSha256")
            .and_then(serde_json::Value::as_str)
            != Some(Base64UrlUnpadded::encode_string(&Sha256::digest(&bytes)).as_str())
    {
        return Err("OPERATION_RECORD_INVALID".to_owned());
    }
    let request = parse_strict_json(&bytes).map_err(|_| "OPERATION_RECORD_INVALID".to_owned())?;
    if request.get("roomId").and_then(serde_json::Value::as_str) != Some(room_id)
        || request
            .get("packageDigest")
            .and_then(serde_json::Value::as_str)
            != record
                .get("packageDigest")
                .and_then(serde_json::Value::as_str)
    {
        return Err("OPERATION_RECORD_INVALID".to_owned());
    }
    Ok((record, bytes, request))
}

pub fn room_operation_status(
    ctx: &IdentityContext,
    room_id: &str,
) -> Result<serde_json::Value, String> {
    let (record, _, request) = room_operation_record(ctx, room_id)?;
    Ok(
        json!({"operationRef":room_id,"operationId":request["operationId"],
        "localStatus":record["status"],"serverStatus":"UNKNOWN"}),
    )
}

pub fn resume_room_operation(
    ctx: &IdentityContext,
    room_id: &str,
    show_secrets: bool,
) -> Result<serde_json::Value, String> {
    let (mut record, bytes, request) = room_operation_record(ctx, room_id)?;
    let package_digest = record
        .get("packageDigest")
        .and_then(serde_json::Value::as_str)
        .ok_or("OPERATION_RECORD_INVALID")?
        .to_owned();
    let publisher_key_id = record
        .get("publisherKeyId")
        .and_then(serde_json::Value::as_str)
        .ok_or("OPERATION_RECORD_INVALID")?
        .to_owned();
    if record["status"] == "PENDING" {
        let api_url = record
            .get("apiUrl")
            .and_then(serde_json::Value::as_str)
            .ok_or("OPERATION_RECORD_INVALID")?;
        if !api_url.starts_with("http://") || api_url.contains(['#', '?', '@']) {
            return Err("OPERATION_TARGET_INVALID".to_owned());
        }
        let token = ctx.load_api_token()?;
        let response = http_post_json_bytes(
            &format!("{api_url}/v1/rooms"),
            &bytes,
            Some(&format!("Bearer {token}")),
            None,
        )
        .map_err(|_| "OPERATION_STILL_PENDING".to_owned())?;
        verify_room_creation_response(&response, room_id, &package_digest, &publisher_key_id)?;
        record["status"] = json!("CONFIRMED");
        ctx.replace_room_record(room_id, &record)?;
    }
    let expiry = record
        .get("expiresAt")
        .and_then(serde_json::Value::as_u64)
        .ok_or("OPERATION_RECORD_INVALID")?;
    let mut result = json!({"ok":true,"roomId":room_id,"packageDigest":package_digest,
        "publisherKeyId":publisher_key_id,"expiresAt":expiry,"operationRef":room_id});
    if show_secrets {
        let controller = record
            .get("controllerUrl")
            .and_then(serde_json::Value::as_str)
            .ok_or("OPERATION_RECORD_INVALID")?;
        let viewer_d = request
            .get("viewerDescriptorJcs")
            .and_then(serde_json::Value::as_str)
            .ok_or("OPERATION_RECORD_INVALID")?;
        let viewer_s = request
            .get("viewerDescriptorSignature")
            .and_then(serde_json::Value::as_str)
            .ok_or("OPERATION_RECORD_INVALID")?;
        let editor_d = request
            .get("editorDescriptorJcs")
            .and_then(serde_json::Value::as_str)
            .ok_or("OPERATION_RECORD_INVALID")?;
        let editor_s = request
            .get("editorDescriptorSignature")
            .and_then(serde_json::Value::as_str)
            .ok_or("OPERATION_RECORD_INVALID")?;
        let key = record
            .get("roomKey")
            .and_then(serde_json::Value::as_str)
            .ok_or("OPERATION_RECORD_INVALID")?;
        let viewer_cap = record
            .get("viewerCapability")
            .and_then(serde_json::Value::as_str)
            .ok_or("OPERATION_RECORD_INVALID")?;
        let editor_cap = record
            .get("editorCapability")
            .and_then(serde_json::Value::as_str)
            .ok_or("OPERATION_RECORD_INVALID")?;
        let writer = record
            .get("writerPrivateKey")
            .and_then(serde_json::Value::as_str)
            .ok_or("OPERATION_RECORD_INVALID")?;
        result["viewerInviteUrl"] = json!(format!(
            "{controller}/r/{room_id}#v=1&d={viewer_d}&s={viewer_s}&k={key}&c={viewer_cap}"
        ));
        result["editorInviteUrl"] = json!(format!(
            "{controller}/r/{room_id}#v=1&d={editor_d}&s={editor_s}&w={writer}&k={key}&c={editor_cap}"
        ));
    }
    Ok(result)
}

pub fn room_status(
    _ctx: &IdentityContext,
    room_id: &str,
    api_url: &str,
) -> Result<serde_json::Value, String> {
    let url = format!("{}/v1/rooms/{}", api_url.trim_end_matches('/'), room_id);
    http_get_json(&url, None)
}

pub fn room_rotate_links(
    ctx: &IdentityContext,
    room_id: &str,
    api_url: &str,
) -> Result<serde_json::Value, String> {
    let room_rec = ctx.load_room_record(room_id)?;
    let mut new_viewer_cap = [0_u8; 32];
    let mut new_editor_cap = [0_u8; 32];
    OsRng.fill_bytes(&mut new_viewer_cap);
    OsRng.fill_bytes(&mut new_editor_cap);

    let body = json!({
        "viewerCapHash": Base64UrlUnpadded::encode_string(&Sha256::digest(new_viewer_cap)),
        "editorCapHash": Base64UrlUnpadded::encode_string(&Sha256::digest(new_editor_cap))
    });

    let old_editor_cap = room_rec
        .get("editorCapability")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let url = format!(
        "{}/v1/rooms/{}/rotate-links",
        api_url.trim_end_matches('/'),
        room_id
    );
    http_post_json(&url, &body, Some(&format!("SF-Cap {old_editor_cap}")), None)
}

pub fn room_revoke(
    ctx: &IdentityContext,
    room_id: &str,
    api_url: &str,
) -> Result<serde_json::Value, String> {
    let room_rec = ctx.load_room_record(room_id)?;
    let old_editor_cap = room_rec
        .get("editorCapability")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let url = format!(
        "{}/v1/rooms/{}/revoke",
        api_url.trim_end_matches('/'),
        room_id
    );
    http_post_json(
        &url,
        &json!({}),
        Some(&format!("SF-Cap {old_editor_cap}")),
        None,
    )
}

fn validate_repair_etag(etag: &str) -> Result<(), String> {
    let inner = etag
        .strip_prefix('"')
        .and_then(|v| v.strip_suffix('"'))
        .ok_or("EXPECTED_ETAG_INVALID")?;
    let fields: Vec<_> = inner.split('.').collect();
    if fields.len() != 4
        || fields[0] != "sf1"
        || fields[1]
            .parse::<u64>()
            .ok()
            .is_none_or(|v| v > 16 || v.to_string() != fields[1])
        || fields[2]
            .parse::<u64>()
            .ok()
            .is_none_or(|v| v == 0 || v > 9_007_199_254_740_991 || v.to_string() != fields[2])
        || Base64UrlUnpadded::decode_vec(fields[3])
            .ok()
            .is_none_or(|v| v.len() != 32)
        || fields[3].len() != 43
    {
        return Err("EXPECTED_ETAG_INVALID".to_owned());
    }
    Ok(())
}

pub fn room_request_repair(
    ctx: &IdentityContext,
    room_id: &str,
    expected_etag: Option<&str>,
    api_url: &str,
) -> Result<serde_json::Value, String> {
    let etag = expected_etag.ok_or("EXPECTED_ETAG_REQUIRED")?;
    validate_repair_etag(etag)?;
    let room_rec = ctx.load_room_record(room_id)?;
    let old_editor_cap = room_rec
        .get("editorCapability")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let url = format!(
        "{}/v1/rooms/{}/request-repair",
        api_url.trim_end_matches('/'),
        room_id
    );
    http_post_json(
        &url,
        &json!({}),
        Some(&format!("SF-Cap {old_editor_cap}")),
        Some(etag),
    )
}

#[cfg(test)]
mod repair_tests {
    use super::validate_repair_etag;
    use base64ct::{Base64UrlUnpadded, Encoding};

    #[test]
    fn expected_etag_requires_exact_canonical_head() {
        let digest = Base64UrlUnpadded::encode_string(&[7_u8; 32]);
        let valid = format!("\"sf1.0.42.{digest}\"");
        assert!(validate_repair_etag(&valid).is_ok());
        for invalid in [
            valid.trim_matches('"').to_owned(),
            format!("W/{valid}"),
            format!("\"sf1.00.42.{digest}\""),
            format!("\"sf1.0.042.{digest}\""),
            format!("\"sf1.17.42.{digest}\""),
            format!("\"sf1.0.0.{digest}\""),
            format!("\"sf1.0.9007199254740992.{digest}\""),
            format!("\"sf1.0.18446744073709551616.{digest}\""),
            format!("\"sf1.0.42.{}\"", &digest[..42]),
            format!("\"sf1.0.42.{digest}=\""),
            format!("\"sf1.0.42.{digest}.extra\""),
        ] {
            assert!(validate_repair_etag(&invalid).is_err());
        }
    }
}
