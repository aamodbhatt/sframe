use crate::{
    CoreError, ErrorCode, Result, canonical_json_bytes, encoding::decode_base64url_fixed, key_id,
    parse_strict_json, verify_dsse_pae,
};
use serde::{Deserialize, Serialize};

pub const POISONED_HEAD_PAYLOAD_TYPE: &str =
    "application/vnd.smallframe.poisoned-head-repair.v1+json";
pub const MAX_REPAIR_RECORD_BYTES: usize = 2_048;

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PoisonedHeadRepairRecord {
    pub protocol_version: u8,
    pub room_id: String,
    pub package_digest: String,
    pub publisher_key_id: String,
    pub expected_state_epoch: u64,
    pub expected_revision: u64,
    pub expected_envelope_digest: String,
    pub viewer_descriptor_digest: String,
    pub editor_descriptor_digest: String,
    pub reason: String,
    pub operation_id: String,
    pub created_at: u64,
}

pub fn parse_poisoned_head_repair(input: &[u8]) -> Result<PoisonedHeadRepairRecord> {
    let invalid = || CoreError::new(ErrorCode::RepairRecordInvalid, "invalid repair record");
    if input.is_empty() || input.len() > MAX_REPAIR_RECORD_BYTES {
        return Err(invalid());
    }
    let value = parse_strict_json(input)?;
    if canonical_json_bytes(&value)? != input {
        return Err(CoreError::new(
            ErrorCode::JsonNotCanonical,
            "repair record must be JCS",
        ));
    }
    let record: PoisonedHeadRepairRecord = serde_json::from_value(value).map_err(|_| invalid())?;
    if record.protocol_version != 1
        || record.reason != "POISONED_HEAD"
        || record.expected_state_epoch > 16
        || record.expected_revision == 0
        || record.expected_revision > 9_007_199_254_740_991
        || record.created_at > 9_007_199_254_740_991
    {
        return Err(invalid());
    }
    for value in [&record.room_id, &record.operation_id] {
        decode_base64url_fixed::<16>(value, ErrorCode::RepairRecordInvalid)?;
    }
    for value in [
        &record.package_digest,
        &record.expected_envelope_digest,
        &record.viewer_descriptor_digest,
        &record.editor_descriptor_digest,
    ] {
        decode_base64url_fixed::<32>(value, ErrorCode::RepairRecordInvalid)?;
    }
    let publisher_digest = record
        .publisher_key_id
        .strip_prefix("sha256:")
        .ok_or_else(invalid)?;
    decode_base64url_fixed::<32>(publisher_digest, ErrorCode::RepairRecordInvalid)?;
    Ok(record)
}

fn verify_recovery_signature(
    payload_type: &str,
    input: &[u8],
    signature: &[u8; 64],
    public_key: &[u8; 32],
) -> Result<()> {
    let r: [u8; 32] = signature[..32].try_into().expect("fixed-size signature");
    for encoded in [public_key, &r] {
        let point = curve25519_dalek::edwards::CompressedEdwardsY(*encoded)
            .decompress()
            .ok_or_else(|| {
                CoreError::new(ErrorCode::SignatureInvalid, "invalid signature point")
            })?;
        if point.compress().to_bytes() != *encoded
            || point.is_small_order()
            || !point.is_torsion_free()
        {
            return Err(CoreError::new(
                ErrorCode::SignatureInvalid,
                "invalid signature point",
            ));
        }
    }
    verify_dsse_pae(payload_type, input, public_key, signature)
}

pub fn verify_poisoned_head_repair(
    input: &[u8],
    signature: &[u8; 64],
    public_key: &[u8; 32],
) -> Result<PoisonedHeadRepairRecord> {
    let record = parse_poisoned_head_repair(input)?;
    if record.publisher_key_id != key_id(public_key) {
        return Err(CoreError::new(
            ErrorCode::PublisherKeyIdMismatch,
            "repair publisher key mismatch",
        ));
    }
    verify_recovery_signature(POISONED_HEAD_PAYLOAD_TYPE, input, signature, public_key)?;
    Ok(record)
}

pub const RECOVERY_TRANSITION_PAYLOAD_TYPE: &str =
    "application/vnd.smallframe.recovery-transition.v1+json";
pub const MAX_RECOVERY_TRANSITION_BYTES: usize = 2_048;

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecoveryTransitionRecord {
    pub protocol_version: u8,
    pub room_id: String,
    pub package_digest: String,
    pub writer_public_key: String,
    pub candidate_state_epoch: u64,
    pub candidate_revision: u64,
    pub candidate_envelope_digest: String,
    pub highest_observed_state_epoch: u64,
    pub highest_observed_revision: u64,
    pub highest_observed_envelope_digest: String,
    pub prior_transition_digest: String,
    pub new_state_epoch: u64,
    pub new_envelope_digest: String,
    pub reason: String,
    pub discarded_known_revisions: bool,
    pub created_at: u64,
}

pub fn parse_recovery_transition(input: &[u8]) -> Result<RecoveryTransitionRecord> {
    let invalid = || {
        CoreError::new(
            ErrorCode::RecoveryTransitionInvalid,
            "invalid recovery transition",
        )
    };
    if input.is_empty() || input.len() > MAX_RECOVERY_TRANSITION_BYTES {
        return Err(invalid());
    }
    let value = parse_strict_json(input)?;
    if canonical_json_bytes(&value)? != input {
        return Err(CoreError::new(
            ErrorCode::JsonNotCanonical,
            "recovery transition must be JCS",
        ));
    }
    let record: RecoveryTransitionRecord = serde_json::from_value(value).map_err(|_| invalid())?;
    if record.protocol_version != 1
        || !matches!(record.reason.as_str(), "OPERATOR_RESTORE" | "POISONED_HEAD")
        || record.candidate_state_epoch > 16
        || record.highest_observed_state_epoch > 16
        || record.new_state_epoch == 0
        || record.new_state_epoch > 16
        || record.new_state_epoch
            != record
                .candidate_state_epoch
                .max(record.highest_observed_state_epoch)
                + 1
        || [record.candidate_revision, record.highest_observed_revision]
            .iter()
            .any(|v| *v == 0 || *v > 9_007_199_254_740_991)
        || record.created_at > 9_007_199_254_740_991
    {
        return Err(invalid());
    }
    decode_base64url_fixed::<16>(&record.room_id, ErrorCode::RecoveryTransitionInvalid)?;
    for value in [
        &record.package_digest,
        &record.writer_public_key,
        &record.candidate_envelope_digest,
        &record.highest_observed_envelope_digest,
        &record.prior_transition_digest,
        &record.new_envelope_digest,
    ] {
        decode_base64url_fixed::<32>(value, ErrorCode::RecoveryTransitionInvalid)?;
    }
    let prior = decode_base64url_fixed::<32>(
        &record.prior_transition_digest,
        ErrorCode::RecoveryTransitionInvalid,
    )?;
    if (prior == [0; 32]) != (record.new_state_epoch == 1) {
        return Err(invalid());
    }
    Ok(record)
}

pub fn verify_recovery_transition(
    input: &[u8],
    signature: &[u8; 64],
    public_key: &[u8; 32],
) -> Result<RecoveryTransitionRecord> {
    let record = parse_recovery_transition(input)?;
    if decode_base64url_fixed::<32>(
        &record.writer_public_key,
        ErrorCode::RecoveryTransitionInvalid,
    )? != *public_key
    {
        return Err(CoreError::new(
            ErrorCode::RecoveryTransitionInvalid,
            "recovery writer key mismatch",
        ));
    }
    verify_recovery_signature(
        RECOVERY_TRANSITION_PAYLOAD_TYPE,
        input,
        signature,
        public_key,
    )?;
    Ok(record)
}

// Byte identity only: callers still need the detached signature and context.
pub fn recovery_transition_digest(input: &[u8]) -> Result<[u8; 32]> {
    parse_recovery_transition(input)?;
    Ok(crate::sha256(input))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{dsse_pae, encoding::encode_base64url, sha256};
    use base64ct::{Base64UrlUnpadded, Encoding};
    use serde_json::{Value, json};

    fn vector() -> Value {
        serde_json::from_str(include_str!(
            "../../../packages/protocol/vectors/poisoned-head-repair-v1.json"
        ))
        .expect("public vector")
    }

    fn mutate_encoding(value: &str) -> String {
        let mut bytes = Base64UrlUnpadded::decode_vec(value).expect("public vector encoding");
        bytes[0] ^= 1;
        Base64UrlUnpadded::encode_string(&bytes)
    }

    #[test]
    fn native_verifies_shared_public_jcs_dsse_vector_and_every_field_mutation() {
        let vector = vector();
        let input = Base64UrlUnpadded::decode_vec(vector["jcsBase64Url"].as_str().expect("JCS"))
            .expect("JCS encoding");
        let public_key = decode_base64url_fixed::<32>(
            vector["publisherPublicKey"].as_str().expect("public key"),
            ErrorCode::PublisherKeyInvalid,
        )
        .expect("public key encoding");
        let signature = decode_base64url_fixed::<64>(
            vector["signature"].as_str().expect("signature"),
            ErrorCode::SignatureInvalid,
        )
        .expect("signature encoding");
        assert_eq!(
            encode_base64url(&sha256(&dsse_pae(POISONED_HEAD_PAYLOAD_TYPE, &input))),
            vector["paeSha256"].as_str().expect("PAE digest")
        );
        assert_eq!(
            verify_poisoned_head_repair(&input, &signature, &public_key)
                .expect("valid repair")
                .expected_revision,
            42
        );
        for (field, value) in vector["record"].as_object().expect("record") {
            let mut changed = vector["record"].clone();
            changed[field] = if let Some(number) = value.as_u64() {
                json!(number + 1)
            } else if field == "reason" {
                json!("OTHER")
            } else if field == "publisherKeyId" {
                json!(format!(
                    "sha256:{}",
                    mutate_encoding(&value.as_str().expect("key id")[7..])
                ))
            } else {
                json!(mutate_encoding(value.as_str().expect("encoded field")))
            };
            assert!(
                verify_poisoned_head_repair(
                    &canonical_json_bytes(&changed).expect("mutation JCS"),
                    &signature,
                    &public_key
                )
                .is_err()
            );
        }
        for index in 0..64 {
            let mut changed_signature = signature;
            changed_signature[index] ^= 1;
            assert!(verify_poisoned_head_repair(&input, &changed_signature, &public_key).is_err());
        }
        assert!(verify_poisoned_head_repair(&input, &signature, &[0; 32]).is_err());
        assert!(verify_dsse_pae("application/other", &input, &public_key, &signature).is_err());
    }

    #[test]
    fn native_rejects_duplicate_noncanonical_unknown_and_unsafe_repair_records() {
        let vector = vector();
        let input = Base64UrlUnpadded::decode_vec(vector["jcsBase64Url"].as_str().expect("JCS"))
            .expect("JCS encoding");
        let text = String::from_utf8(input.clone()).expect("UTF-8");
        for invalid in [
            format!("{{\"protocolVersion\":1,{}", &text[1..]),
            format!("{{\"\\u0070rotocolVersion\":1,{}", &text[1..]),
            format!(" {text}"),
            text.replace("\"expectedStateEpoch\":0", "\"expectedStateEpoch\":-0"),
        ] {
            assert!(parse_poisoned_head_repair(invalid.as_bytes()).is_err());
        }
        for changes in [
            json!({"expectedStateEpoch":17}),
            json!({"expectedRevision":0}),
            json!({"expectedRevision":9_007_199_254_740_992_u64}),
            json!({"createdAt":-1}),
            json!({"createdAt":9_007_199_254_740_992_u64}),
            json!({"unknown":true}),
            json!({"operationId":"invalid"}),
        ] {
            let mut record = vector["record"].clone();
            for (field, value) in changes.as_object().expect("changes") {
                record[field] = value.clone();
            }
            assert!(
                parse_poisoned_head_repair(&canonical_json_bytes(&record).expect("mutation JCS"))
                    .is_err()
            );
        }
        assert!(parse_poisoned_head_repair(&vec![0; MAX_REPAIR_RECORD_BYTES + 1]).is_err());
        assert!(parse_poisoned_head_repair(&[123, 255, 125]).is_err());
        let mut boundary = vector["record"].clone();
        boundary["expectedStateEpoch"] = json!(16);
        boundary["expectedRevision"] = json!(9_007_199_254_740_991_u64);
        boundary["createdAt"] = json!(9_007_199_254_740_991_u64);
        assert!(
            parse_poisoned_head_repair(&canonical_json_bytes(&boundary).expect("boundary JCS"))
                .is_ok()
        );
    }
    fn transition_vector() -> Value {
        serde_json::from_str(include_str!(
            "../../../packages/protocol/vectors/recovery-transition-v1.json"
        ))
        .expect("public transition vector")
    }

    #[test]
    fn native_verifies_transition_vector_and_rejects_all_mutations() {
        let vector = transition_vector();
        let input = Base64UrlUnpadded::decode_vec(vector["jcsBase64Url"].as_str().expect("JCS"))
            .expect("JCS encoding");
        let public_key = decode_base64url_fixed::<32>(
            vector["writerPublicKey"].as_str().expect("public key"),
            ErrorCode::RecoveryTransitionInvalid,
        )
        .expect("key encoding");
        let signature = decode_base64url_fixed::<64>(
            vector["signature"].as_str().expect("signature"),
            ErrorCode::SignatureInvalid,
        )
        .expect("signature encoding");
        assert_eq!(
            encode_base64url(&sha256(&dsse_pae(RECOVERY_TRANSITION_PAYLOAD_TYPE, &input))),
            vector["paeSha256"].as_str().expect("PAE digest")
        );
        assert_eq!(
            verify_recovery_transition(&input, &signature, &public_key)
                .expect("valid transition")
                .new_state_epoch,
            1
        );
        for (field, value) in vector["record"].as_object().expect("record") {
            let mut changed = vector["record"].clone();
            changed[field] = if let Some(number) = value.as_u64() {
                json!(number + 1)
            } else if let Some(boolean) = value.as_bool() {
                json!(!boolean)
            } else if field == "reason" {
                json!("POISONED_HEAD")
            } else {
                json!(mutate_encoding(value.as_str().expect("encoded field")))
            };
            assert!(
                verify_recovery_transition(
                    &canonical_json_bytes(&changed).expect("mutation JCS"),
                    &signature,
                    &public_key
                )
                .is_err()
            );
        }
        for index in 0..64 {
            let mut changed = signature;
            changed[index] ^= 1;
            assert!(verify_recovery_transition(&input, &changed, &public_key).is_err());
        }
        assert!(verify_recovery_transition(&input, &signature, &[0; 32]).is_err());
        assert!(
            verify_dsse_pae(POISONED_HEAD_PAYLOAD_TYPE, &input, &public_key, &signature).is_err()
        );
    }

    #[test]
    fn native_rejects_noncanonical_transition_and_enforces_epoch_boundaries() {
        let vector = transition_vector();
        let input = Base64UrlUnpadded::decode_vec(vector["jcsBase64Url"].as_str().expect("JCS"))
            .expect("JCS encoding");
        let text = String::from_utf8(input).expect("UTF-8");
        for invalid in [
            format!("{{\"newStateEpoch\":1,{}", &text[1..]),
            format!("{{\"\\u006eewStateEpoch\":1,{}", &text[1..]),
            format!(" {text}"),
            text.replace("\"candidateStateEpoch\":0", "\"candidateStateEpoch\":-0"),
        ] {
            assert!(parse_recovery_transition(invalid.as_bytes()).is_err());
        }
        for changes in [
            json!({"priorEpoch":0}),
            json!({"reason":"DISASTER_RESTORE"}),
            json!({"discardedKnownRevisions":1}),
            json!({"newStateEpoch":2}),
            json!({"newStateEpoch":0}),
            json!({"candidateStateEpoch":16,"newStateEpoch":17}),
            json!({"highestObservedStateEpoch":17}),
            json!({"candidateRevision":0}),
            json!({"highestObservedRevision":9_007_199_254_740_992_u64}),
            json!({"createdAt":-1}),
            json!({"createdAt":9_007_199_254_740_992_u64}),
            json!({"writerPublicKey":"invalid"}),
            json!({"priorTransitionDigest":vector["record"]["packageDigest"]}),
            json!({"candidateStateEpoch":1,"newStateEpoch":2}),
        ] {
            let mut record = vector["record"].clone();
            for (field, value) in changes.as_object().expect("changes") {
                record[field] = value.clone();
            }
            assert!(
                parse_recovery_transition(&canonical_json_bytes(&record).expect("mutation JCS"))
                    .is_err()
            );
        }
        assert!(parse_recovery_transition(&vec![0; MAX_RECOVERY_TRANSITION_BYTES + 1]).is_err());
        assert!(parse_recovery_transition(&[123, 255, 125]).is_err());
        for field in ["candidateStateEpoch", "highestObservedStateEpoch"] {
            let mut record = vector["record"].clone();
            record[field] = json!(15);
            record["newStateEpoch"] = json!(16);
            record["priorTransitionDigest"] = record["packageDigest"].clone();
            for number in ["candidateRevision", "highestObservedRevision", "createdAt"] {
                record[number] = json!(9_007_199_254_740_991_u64);
            }
            assert!(
                parse_recovery_transition(&canonical_json_bytes(&record).expect("boundary JCS"))
                    .is_ok()
            );
            record["priorTransitionDigest"] = json!(encode_base64url(&[0; 32]));
            assert!(
                parse_recovery_transition(
                    &canonical_json_bytes(&record).expect("zero predecessor JCS")
                )
                .is_err()
            );
        }
        let signing_key = ed25519_dalek::SigningKey::generate(&mut rand_core::OsRng);
        let public_key = signing_key.verifying_key().to_bytes();
        let mut record = vector["record"].clone();
        record["writerPublicKey"] = json!(encode_base64url(&public_key));
        let canonical = canonical_json_bytes(&record).expect("JCS");
        let signature =
            crate::sign_dsse_pae(RECOVERY_TRANSITION_PAYLOAD_TYPE, &canonical, &signing_key);
        assert!(verify_recovery_transition(&canonical, &signature, &public_key).is_ok());
        record["newStateEpoch"] = json!(3);
        let canonical = canonical_json_bytes(&record).expect("invalid JCS");
        let signature =
            crate::sign_dsse_pae(RECOVERY_TRANSITION_PAYLOAD_TYPE, &canonical, &signing_key);
        assert!(verify_recovery_transition(&canonical, &signature, &public_key).is_err());
    }
    #[test]
    fn native_rejects_shared_small_and_mixed_order_signer_point_vectors() {
        for (vector, repair) in [(vector(), true), (transition_vector(), false)] {
            let points = vector["rejectedPointVectors"]
                .as_array()
                .expect("public point vectors");
            assert_eq!(points.len(), 3);
            for point in points {
                let input =
                    Base64UrlUnpadded::decode_vec(point["jcsBase64Url"].as_str().expect("JCS"))
                        .expect("JCS encoding");
                let public_key = decode_base64url_fixed::<32>(
                    point["publicKey"].as_str().expect("public key"),
                    ErrorCode::SignatureInvalid,
                )
                .expect("key encoding");
                let signature = decode_base64url_fixed::<64>(
                    point["signature"].as_str().expect("signature"),
                    ErrorCode::SignatureInvalid,
                )
                .expect("signature encoding");
                if repair {
                    assert!(parse_poisoned_head_repair(&input).is_ok());
                    assert!(verify_poisoned_head_repair(&input, &signature, &public_key).is_err());
                } else {
                    assert!(parse_recovery_transition(&input).is_ok());
                    assert!(verify_recovery_transition(&input, &signature, &public_key).is_err());
                }
            }
        }
    }
}
