use crate::{identity::IdentityContext, upload::valid_target};
use base64ct::{Base64UrlUnpadded, Encoding};
use serde_json::Value;
use std::{
    io::Write,
    process::{Command, Stdio},
};

fn canonical(value: &str, length: usize) -> bool {
    value.len() == (length * 8).div_ceil(6)
        && Base64UrlUnpadded::decode_vec(value).is_ok_and(|bytes| {
            bytes.len() == length && Base64UrlUnpadded::encode_string(&bytes) == value
        })
}
fn safe_integer(value: &Value, minimum: u64, maximum: u64) -> bool {
    value.as_u64().is_some_and(|n| n >= minimum && n <= maximum)
}
fn verify_response(response: Value, room_id: &str) -> Result<Value, String> {
    let object = response.as_object().ok_or("ROOM_STATUS_RESPONSE_INVALID")?;
    let fields = [
        "roomId",
        "packageDigest",
        "status",
        "expiresAt",
        "operationId",
        "creationStatus",
        "d1Status",
        "stateEpoch",
        "revision",
    ];
    if object.len() != fields.len()
        || fields.iter().any(|field| !object.contains_key(*field))
        || response["roomId"].as_str() != Some(room_id)
        || !response["packageDigest"]
            .as_str()
            .is_some_and(|s| canonical(s, 32))
        || !response["operationId"]
            .as_str()
            .is_some_and(|s| canonical(s, 16))
        || !safe_integer(&response["expiresAt"], 0, 9_007_199_254_740_991)
    {
        return Err("ROOM_STATUS_RESPONSE_INVALID".to_owned());
    }
    let status = response["status"]
        .as_str()
        .ok_or("ROOM_STATUS_RESPONSE_INVALID")?;
    if ![
        "PENDING",
        "ACTIVE",
        "RECOVERY_REQUIRED",
        "REVOKED",
        "EXPIRED",
    ]
    .contains(&status)
        || !response["creationStatus"].as_str().is_some_and(|s| {
            [
                "D1_PENDING",
                "DO_ACTIVE_WITH_GENESIS",
                "D1_ACTIVE",
                "RESULT_EXPIRED",
            ]
            .contains(&s)
        })
        || !response["d1Status"]
            .as_str()
            .is_some_and(|s| ["CURRENT", "STALE"].contains(&s))
    {
        return Err("ROOM_STATUS_RESPONSE_INVALID".to_owned());
    }
    let head_valid = if ["PENDING", "REVOKED", "EXPIRED"].contains(&status) {
        response["stateEpoch"].is_null() && response["revision"].is_null()
    } else {
        safe_integer(&response["stateEpoch"], 0, 16)
            && safe_integer(&response["revision"], 1, 9_007_199_254_740_991)
    };
    if !head_valid {
        return Err("ROOM_STATUS_RESPONSE_INVALID".to_owned());
    }
    Ok(response)
}

pub fn room_status(ctx: &IdentityContext, room_id: &str, api_url: &str) -> Result<Value, String> {
    let origin = api_url.trim_end_matches('/');
    if !canonical(room_id, 16) || !valid_target(&format!("{origin}/v1/packages")) {
        return Err("ROOM_STATUS_TARGET_INVALID".to_owned());
    }
    let token = ctx.load_api_token()?;
    if !canonical(&token, 32) {
        return Err("API_TOKEN_INVALID".to_owned());
    }
    // Pass authorization through stdin, never process arguments or error output.
    let mut child = Command::new("curl")
        .args([
            "-q",
            "-s",
            "-S",
            "-f",
            "--max-time",
            "10",
            "--max-filesize",
            "4096",
            "--config",
            "-",
            &format!("{origin}/v1/publisher/rooms/{room_id}"),
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| "ROOM_STATUS_TRANSPORT_FAILED".to_owned())?;
    let sent = child
        .stdin
        .take()
        .ok_or("ROOM_STATUS_TRANSPORT_FAILED")?
        .write_all(format!("header = \"Authorization: Bearer {token}\"\n").as_bytes());
    if sent.is_err() {
        let _ = child.kill();
    }
    let output = child
        .wait_with_output()
        .map_err(|_| "ROOM_STATUS_TRANSPORT_FAILED".to_owned())?;
    if sent.is_err() || !output.status.success() || output.stdout.len() > 4096 {
        return Err("ROOM_STATUS_TRANSPORT_FAILED".to_owned());
    }
    let response = smallframe_core::parse_strict_json(&output.stdout)
        .map_err(|_| "ROOM_STATUS_RESPONSE_INVALID".to_owned())?;
    verify_response(response, room_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use rand_core::{OsRng, RngCore};
    use serde_json::json;
    fn fixture() -> (String, Value) {
        let mut room = [0; 16];
        let mut digest = [0; 32];
        OsRng.fill_bytes(&mut room);
        OsRng.fill_bytes(&mut digest);
        let id = Base64UrlUnpadded::encode_string(&room);
        let value = json!({"roomId":id,"packageDigest":Base64UrlUnpadded::encode_string(&digest),"operationId":id,
            "status":"ACTIVE","creationStatus":"D1_ACTIVE","d1Status":"CURRENT","expiresAt":1,"stateEpoch":0,"revision":1});
        (id, value)
    }
    #[test]
    fn status_rejects_extra_fields_wrong_context_and_invalid_heads() {
        let (id, value) = fixture();
        assert!(verify_response(value.clone(), &id).is_ok());
        let mut extra = value.clone();
        extra["unexpected"] = Value::Null;
        assert!(verify_response(extra, &id).is_err());
        assert!(verify_response(value.clone(), &fixture().0).is_err());
        for (field, invalid) in [
            ("stateEpoch", json!(17)),
            ("revision", json!(0)),
            ("expiresAt", json!(-1)),
            ("status", json!("UNKNOWN")),
            ("packageDigest", json!("bad")),
            ("creationStatus", json!("UNKNOWN")),
        ] {
            let mut changed = value.clone();
            changed[field] = invalid;
            assert!(verify_response(changed, &id).is_err());
        }
        let mut terminal = value;
        terminal["status"] = json!("EXPIRED");
        assert!(verify_response(terminal.clone(), &id).is_err());
        terminal["stateEpoch"] = Value::Null;
        terminal["revision"] = Value::Null;
        assert!(verify_response(terminal, &id).is_ok());
    }
}
