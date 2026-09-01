#![forbid(unsafe_code)]

use base64ct::{Base64UrlUnpadded, Encoding};
use ed25519_dalek::{Signer, SigningKey};
use rand_core::{OsRng, RngCore};
use serde_json::json;
use sha2::{Digest, Sha256};
use smallframe_core::{dsse_pae, key_id};
use std::{
    fs,
    path::Path,
    process::Command as ProcessCommand,
    time::{SystemTime, UNIX_EPOCH},
};

use crate::app::{pack, validate_path};
use crate::identity::IdentityContext;

const ENROLLMENT_PAYLOAD_TYPE: &str = "application/vnd.smallframe.publisher-enrollment.v1+json";
const DESCRIPTOR_PAYLOAD_TYPE: &str = "application/vnd.smallframe.room-descriptor.v1+json";

fn jcs_bytes(val: &serde_json::Value) -> Result<Vec<u8>, String> {
    serde_jcs::to_vec(val).map_err(|_| "CANONICALIZE_FAILED".to_owned())
}

fn http_post_json(url: &str, body: &serde_json::Value, auth_header: Option<&str>) -> Result<serde_json::Value, String> {
    let body_str = serde_json::to_string(body).map_err(|e| format!("SERIALIZE_FAILED: {e}"))?;
    let mut cmd = ProcessCommand::new("curl");
    cmd.args(["-s", "-S", "-X", "POST", url, "-H", "Content-Type: application/json", "-H", "Origin: http://app.localhost:4173"]);
    if let Some(auth) = auth_header {
        cmd.args(["-H", &format!("Authorization: {auth}")]);
    }
    cmd.args(["--data-raw", &body_str]);

    let output = cmd.output().map_err(|e| format!("HTTP_REQUEST_FAILED: {e}"))?;
    let response_str = String::from_utf8_lossy(&output.stdout);
    if !output.status.success() {
        return Err(format!("HTTP_ERROR: {}", String::from_utf8_lossy(&output.stderr)));
    }

    serde_json::from_str(&response_str).map_err(|_| format!("HTTP_RESPONSE_INVALID: {response_str}"))
}

fn http_post_bytes(url: &str, bytes: &[u8], auth_header: Option<&str>) -> Result<serde_json::Value, String> {
    let temp_file = std::env::temp_dir().join(format!("sf-upload-{}.bin", std::process::id()));
    fs::write(&temp_file, bytes).map_err(|e| format!("TEMP_FILE_WRITE_FAILED: {e}"))?;

    let mut cmd = ProcessCommand::new("curl");
    cmd.args(["-s", "-S", "-X", "POST", url, "-H", "Content-Type: application/vnd.smallframe.package", "-H", "Origin: http://app.localhost:4173"]);
    if let Some(auth) = auth_header {
        cmd.args(["-H", &format!("Authorization: {auth}")]);
    }
    cmd.args(["--data-binary", &format!("@{}", temp_file.display())]);

    let output = cmd.output();
    let _ = fs::remove_file(&temp_file);

    let output = output.map_err(|e| format!("HTTP_REQUEST_FAILED: {e}"))?;
    let response_str = String::from_utf8_lossy(&output.stdout);
    if !output.status.success() {
        return Err(format!("HTTP_ERROR: {}", String::from_utf8_lossy(&output.stderr)));
    }

    serde_json::from_str(&response_str).map_err(|_| format!("HTTP_RESPONSE_INVALID: {response_str}"))
}

fn http_get_json(url: &str, auth_header: Option<&str>) -> Result<serde_json::Value, String> {
    let mut cmd = ProcessCommand::new("curl");
    cmd.args(["-s", "-S", "-X", "GET", url, "-H", "Origin: http://app.localhost:4173"]);
    if let Some(auth) = auth_header {
        cmd.args(["-H", &format!("Authorization: {auth}")]);
    }

    let output = cmd.output().map_err(|e| format!("HTTP_REQUEST_FAILED: {e}"))?;
    let response_str = String::from_utf8_lossy(&output.stdout);
    if !output.status.success() {
        return Err(format!("HTTP_ERROR: {}", String::from_utf8_lossy(&output.stderr)));
    }

    serde_json::from_str(&response_str).map_err(|_| format!("HTTP_RESPONSE_INVALID: {response_str}"))
}

pub fn enroll_publisher(
    ctx: &IdentityContext,
    invite_file: Option<&Path>,
    api_url: &str,
) -> Result<serde_json::Value, String> {
    let invite_code = if let Some(path) = invite_file {
        fs::read_to_string(path).map_err(|_| "INVITE_FILE_READ_FAILED".to_owned())?.trim().to_owned()
    } else {
        "BETA_INVITE_TEST_123".to_owned()
    };

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

    let enroll_url = format!("{}/v1/enroll", api_url.trim_end_matches('/'));
    let response = http_post_json(&enroll_url, &request_body, None)?;

    let token_str = Base64UrlUnpadded::encode_string(&raw_token);
    ctx.save_api_token(&token_str)?;

    Ok(json!({
        "ok": true,
        "publisherKeyId": pub_key_id,
        "enrolled": true,
        "response": response
    }))
}

pub fn publish_package(
    ctx: &IdentityContext,
    path: &Path,
    _initial_state: Option<&Path>,
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
    let _summary = pack(path, &temp_pkg_path, &signing_key)?;
    let pkg_bytes = fs::read(&temp_pkg_path).map_err(|e| format!("READ_PACK_FAILED: {e}"))?;
    let _ = fs::remove_file(&temp_pkg_path);

    let pkg_digest = Base64UrlUnpadded::encode_string(&Sha256::digest(&pkg_bytes));

    // 2. Upload package
    let token = ctx.load_api_token()?;
    let pkg_url = format!("{}/v1/packages", api_url.trim_end_matches('/'));
    let _pkg_res = http_post_bytes(&pkg_url, &pkg_bytes, Some(&format!("Bearer {token}")))?;

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

    let duration_ms = expires_in_hours.unwrap_or(24) * 3600 * 1000;
    let expires_at = now_ms + duration_ms;

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
    let genesis_bytes = vec![0x01_u8; 100];
    let genesis_b64 = Base64UrlUnpadded::encode_string(&genesis_bytes);

    let room_creation_body = json!({
        "operationId": Base64UrlUnpadded::encode_string(&op_id_bytes),
        "roomId": room_id,
        "packageDigest": pkg_digest,
        "viewerDescriptorJcs": Base64UrlUnpadded::encode_string(&viewer_jcs),
        "viewerDescriptorSignature": Base64UrlUnpadded::encode_string(&viewer_sig.to_bytes()),
        "editorDescriptorJcs": Base64UrlUnpadded::encode_string(&editor_jcs),
        "editorDescriptorSignature": Base64UrlUnpadded::encode_string(&editor_sig.to_bytes()),
        "genesisStateBytes": genesis_b64
    });

    let rooms_url = format!("{}/v1/rooms", api_url.trim_end_matches('/'));
    let _room_res = http_post_json(&rooms_url, &room_creation_body, Some(&format!("Bearer {token}")))?;

    // 6. Save room secrets in vault
    let room_record = json!({
        "roomId": room_id,
        "packageDigest": pkg_digest,
        "roomKey": Base64UrlUnpadded::encode_string(&room_key_bytes),
        "viewerCapability": Base64UrlUnpadded::encode_string(&viewer_cap_bytes),
        "editorCapability": Base64UrlUnpadded::encode_string(&editor_cap_bytes),
        "writerPrivateKey": writer_priv_str,
        "writerPublicKey": writer_pub_str,
        "expiresAt": expires_at
    });
    ctx.save_room_record(&room_id, &room_record)?;

    // 7. Construct invite URLs
    let viewer_d = Base64UrlUnpadded::encode_string(&viewer_jcs);
    let viewer_s = Base64UrlUnpadded::encode_string(&viewer_sig.to_bytes());
    let k = Base64UrlUnpadded::encode_string(&room_key_bytes);
    let viewer_c = Base64UrlUnpadded::encode_string(&viewer_cap_bytes);

    let editor_d = Base64UrlUnpadded::encode_string(&editor_jcs);
    let editor_s = Base64UrlUnpadded::encode_string(&editor_sig.to_bytes());
    let w = writer_priv_str;
    let editor_c = Base64UrlUnpadded::encode_string(&editor_cap_bytes);

    let viewer_invite = format!("{}/r/{}#v=1&d={}&s={}&k={}&c={}", controller_url.trim_end_matches('/'), room_id, viewer_d, viewer_s, k, viewer_c);
    let editor_invite = format!("{}/r/{}#v=1&d={}&s={}&w={}&k={}&c={}", controller_url.trim_end_matches('/'), room_id, editor_d, editor_s, w, k, editor_c);

    let result = if show_secrets {
        json!({
            "ok": true,
            "roomId": room_id,
            "packageDigest": pkg_digest,
            "publisherKeyId": publisher_key_id,
            "expiresAt": expires_at,
            "viewerInviteUrl": viewer_invite,
            "editorInviteUrl": editor_invite
        })
    } else {
        json!({
            "ok": true,
            "roomId": room_id,
            "packageDigest": pkg_digest,
            "publisherKeyId": publisher_key_id,
            "expiresAt": expires_at
        })
    };

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

    let old_editor_cap = room_rec.get("editorCapability").and_then(|v| v.as_str()).unwrap_or("");
    let url = format!("{}/v1/rooms/{}/rotate-links", api_url.trim_end_matches('/'), room_id);
    http_post_json(&url, &body, Some(&format!("SF-Cap {old_editor_cap}")))
}

pub fn room_revoke(
    ctx: &IdentityContext,
    room_id: &str,
    api_url: &str,
) -> Result<serde_json::Value, String> {
    let room_rec = ctx.load_room_record(room_id)?;
    let old_editor_cap = room_rec.get("editorCapability").and_then(|v| v.as_str()).unwrap_or("");
    let url = format!("{}/v1/rooms/{}/revoke", api_url.trim_end_matches('/'), room_id);
    http_post_json(&url, &json!({}), Some(&format!("SF-Cap {old_editor_cap}")))
}

pub fn room_request_repair(
    ctx: &IdentityContext,
    room_id: &str,
    _expected_etag: Option<&str>,
    api_url: &str,
) -> Result<serde_json::Value, String> {
    let room_rec = ctx.load_room_record(room_id)?;
    let old_editor_cap = room_rec.get("editorCapability").and_then(|v| v.as_str()).unwrap_or("");
    let url = format!("{}/v1/rooms/{}/request-repair", api_url.trim_end_matches('/'), room_id);
    http_post_json(&url, &json!({}), Some(&format!("SF-Cap {old_editor_cap}")))
}
