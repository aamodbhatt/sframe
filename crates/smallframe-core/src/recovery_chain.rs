use crate::{
    CoreError, ErrorCode, RecoveryTransitionRecord, Result, encoding::decode_base64url_fixed,
    sha256, verify_recovery_transition,
};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub const MAX_RECOVERY_TRANSITIONS: usize = 16;

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecoveryChainContext {
    pub room_id: String,
    pub package_digest: String,
    pub writer_public_key: String,
    pub state_epoch: u64,
    pub transition_digest: String,
    pub target_state_epoch: u64,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecoveryEpochDigest {
    pub state_epoch: u64,
    pub transition_digest: String,
}

pub struct SignedRecoveryTransitionBytes<'a> {
    pub jcs_bytes: &'a [u8],
    pub signature: &'a [u8; 64],
}

#[derive(Debug)]
pub struct VerifiedRecoveryTransition {
    pub record: RecoveryTransitionRecord,
    pub jcs_bytes: Vec<u8>,
    pub signature: [u8; 64],
    pub digest: [u8; 32],
}

#[derive(Debug)]
pub struct VerifiedRecoveryChain {
    pub state_epoch: u64,
    pub transition_digest: [u8; 32],
    pub transitions: Vec<VerifiedRecoveryTransition>,
}

fn invalid() -> CoreError {
    CoreError::new(
        ErrorCode::RecoveryTransitionInvalid,
        "invalid recovery transition chain",
    )
}

fn context_bytes(context: &RecoveryChainContext) -> Result<([u8; 32], [u8; 32])> {
    let code = ErrorCode::RecoveryTransitionInvalid;
    decode_base64url_fixed::<16>(&context.room_id, code)?;
    decode_base64url_fixed::<32>(&context.package_digest, code)?;
    let writer = decode_base64url_fixed::<32>(&context.writer_public_key, code)?;
    let prior = decode_base64url_fixed::<32>(&context.transition_digest, code)?;
    if context.state_epoch > context.target_state_epoch
        || context.target_state_epoch > MAX_RECOVERY_TRANSITIONS as u64
        || (prior == [0; 32]) != (context.state_epoch == 0)
    {
        return Err(invalid());
    }
    let point = curve25519_dalek::edwards::CompressedEdwardsY(writer)
        .decompress()
        .ok_or_else(invalid)?;
    if point.compress().to_bytes() != writer || point.is_small_order() || !point.is_torsion_free() {
        return Err(invalid());
    }
    Ok((writer, prior))
}

fn known_digests(
    known: &[RecoveryEpochDigest],
    context: &RecoveryChainContext,
    prior: &[u8; 32],
) -> Result<BTreeMap<u64, [u8; 32]>> {
    if known.len() > MAX_RECOVERY_TRANSITIONS {
        return Err(invalid());
    }
    let mut digests = BTreeMap::new();
    for item in known {
        let digest = decode_base64url_fixed::<32>(
            &item.transition_digest,
            ErrorCode::RecoveryTransitionInvalid,
        )?;
        if item.state_epoch == 0
            || item.state_epoch > MAX_RECOVERY_TRANSITIONS as u64
            || digest == [0; 32]
            || digests.insert(item.state_epoch, digest).is_some()
        {
            return Err(invalid());
        }
    }
    if digests
        .get(&context.state_epoch)
        .is_some_and(|digest| digest != prior)
    {
        return Err(invalid());
    }
    Ok(digests)
}

// Complete signed record lineage through a pinned target. Envelope validation,
// rollback decisions, relay authority and atomic persistence remain separate.
pub fn verify_recovery_transition_chain(
    input: &[SignedRecoveryTransitionBytes<'_>],
    context: &RecoveryChainContext,
    accepted_epoch_digests: &[RecoveryEpochDigest],
) -> Result<VerifiedRecoveryChain> {
    let (writer, mut prior) = context_bytes(context)?;
    if input.len() > MAX_RECOVERY_TRANSITIONS
        || input.len() as u64 != context.target_state_epoch - context.state_epoch
    {
        return Err(invalid());
    }
    let known = known_digests(accepted_epoch_digests, context, &prior)?;
    let mut epoch = context.state_epoch;
    let mut transitions = Vec::with_capacity(input.len());
    for signed in input {
        let record = verify_recovery_transition(signed.jcs_bytes, signed.signature, &writer)?;
        if record.room_id != context.room_id
            || record.package_digest != context.package_digest
            || record.writer_public_key != context.writer_public_key
            || record.new_state_epoch != epoch + 1
            || decode_base64url_fixed::<32>(
                &record.prior_transition_digest,
                ErrorCode::RecoveryTransitionInvalid,
            )? != prior
        {
            return Err(invalid());
        }
        let digest = sha256(signed.jcs_bytes);
        if digest == [0; 32]
            || known
                .get(&record.new_state_epoch)
                .is_some_and(|accepted| *accepted != digest)
        {
            return Err(invalid());
        }
        epoch = record.new_state_epoch;
        prior = digest;
        transitions.push(VerifiedRecoveryTransition {
            record,
            jcs_bytes: signed.jcs_bytes.to_vec(),
            signature: *signed.signature,
            digest,
        });
    }
    Ok(VerifiedRecoveryChain {
        state_epoch: epoch,
        transition_digest: prior,
        transitions,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{encoding::encode_base64url, recovery_transition_digest};
    use base64ct::{Base64UrlUnpadded, Encoding};
    use serde_json::Value;

    type Entry = (Vec<u8>, [u8; 64]);

    fn vector() -> Value {
        serde_json::from_str(include_str!(
            "../../../packages/protocol/vectors/recovery-chain-v1.json"
        ))
        .expect("public vector")
    }

    fn entry(value: &Value) -> Entry {
        let bytes = Base64UrlUnpadded::decode_vec(value["jcsBase64Url"].as_str().unwrap()).unwrap();
        let signature = Base64UrlUnpadded::decode_vec(value["signature"].as_str().unwrap())
            .unwrap()
            .try_into()
            .unwrap();
        (bytes, signature)
    }

    fn entries(value: &Value) -> Vec<Entry> {
        value["transitions"]
            .as_array()
            .unwrap()
            .iter()
            .map(entry)
            .collect()
    }

    fn anchor(value: &Value, from: u64, target: u64) -> RecoveryChainContext {
        let mut context: RecoveryChainContext =
            serde_json::from_value(value["anchor"].clone()).unwrap();
        context.state_epoch = from;
        context.target_state_epoch = target;
        if from > 0 {
            context.transition_digest =
                value["transitions"][(from - 1) as usize]["transitionDigest"]
                    .as_str()
                    .unwrap()
                    .to_owned();
        }
        context
    }

    fn accepted(value: &Value) -> Vec<RecoveryEpochDigest> {
        value["transitions"]
            .as_array()
            .unwrap()
            .iter()
            .map(|item| RecoveryEpochDigest {
                state_epoch: item["record"]["newStateEpoch"].as_u64().unwrap(),
                transition_digest: item["transitionDigest"].as_str().unwrap().to_owned(),
            })
            .collect()
    }

    fn verify(
        input: &[Entry],
        context: &RecoveryChainContext,
        known: &[RecoveryEpochDigest],
    ) -> Result<VerifiedRecoveryChain> {
        let signed: Vec<_> = input
            .iter()
            .map(|(bytes, signature)| SignedRecoveryTransitionBytes {
                jcs_bytes: bytes,
                signature,
            })
            .collect();
        verify_recovery_transition_chain(&signed, context, known)
    }

    #[test]
    fn shared_digest_vectors_and_complete_anchored_suffixes() {
        let value = vector();
        let input = entries(&value);
        let known = accepted(&value);
        for (index, (bytes, _)) in input.iter().enumerate() {
            assert_eq!(
                encode_base64url(&recovery_transition_digest(bytes).unwrap()),
                value["transitions"][index]["transitionDigest"]
            );
        }
        for from in 0..=16 {
            let result = verify(&input[from..], &anchor(&value, from as u64, 16), &known).unwrap();
            assert_eq!(result.state_epoch, 16);
            assert_eq!(result.transitions.len(), 16 - from);
            assert_eq!(
                encode_base64url(&result.transition_digest),
                value["transitions"][15]["transitionDigest"]
            );
            for (offset, transition) in result.transitions.iter().enumerate() {
                assert_eq!(transition.jcs_bytes, input[from + offset].0);
                assert_eq!(transition.signature, input[from + offset].1);
                assert_eq!(
                    encode_base64url(&transition.digest),
                    value["transitions"][from + offset]["transitionDigest"]
                );
            }
        }
    }

    #[test]
    fn rejects_omissions_order_duplicates_caps_and_invalid_targets() {
        let value = vector();
        let input = entries(&value);
        let context = anchor(&value, 0, 16);
        for changed in [
            Vec::new(),
            input[1..].to_vec(),
            input[..15].to_vec(),
            input
                .iter()
                .enumerate()
                .filter(|(i, _)| *i != 5)
                .map(|(_, v)| v.clone())
                .collect(),
            input.iter().rev().cloned().collect(),
            [input.clone(), vec![input[0].clone()]].concat(),
        ] {
            assert!(verify(&changed, &context, &[]).is_err());
        }
        let mut duplicate = input.clone();
        duplicate[2] = duplicate[1].clone();
        assert!(verify(&duplicate, &context, &[]).is_err());
        for target in [15, 17, u64::MAX] {
            assert!(verify(&input, &anchor(&value, 0, target), &[]).is_err());
        }
        assert!(verify(&[], &anchor(&value, 2, 1), &[]).is_err());
        let mut unsafe_anchor = anchor(&value, 0, 0);
        unsafe_anchor.state_epoch = u64::MAX;
        assert!(verify(&[], &unsafe_anchor, &[]).is_err());
    }

    #[test]
    fn rejects_signed_context_predecessor_epoch_and_signature_attacks() {
        let value = vector();
        for rejected in value["rejectedRecords"].as_array().unwrap() {
            let from = match rejected["kind"].as_str().unwrap() {
                "wrong-predecessor" | "zero-predecessor-after-first" | "epoch-gap" => 1,
                _ => 0,
            };
            assert!(verify(&[entry(rejected)], &anchor(&value, from, from + 1), &[]).is_err());
        }
        let mut input = entries(&value);
        input[0].1 = [0; 64];
        assert!(verify(&input, &anchor(&value, 0, 16), &[]).is_err());
        input[0].0 = vec![0; 2_049];
        assert!(verify(&input, &anchor(&value, 0, 16), &[]).is_err());
        let mut context = anchor(&value, 0, 16);
        context.room_id = encode_base64url(&[0; 16]);
        assert!(verify(&entries(&value), &context, &[]).is_err());
        context = anchor(&value, 0, 16);
        context.package_digest = encode_base64url(&[0; 32]);
        assert!(verify(&entries(&value), &context, &[]).is_err());
    }

    #[test]
    fn rejects_known_epoch_conflicts_and_invalid_empty_anchors() {
        let value = vector();
        let fork = vec![entry(&value["fork"])];
        let known = accepted(&value);
        assert!(verify(&fork, &anchor(&value, 1, 2), &[]).is_ok());
        assert!(verify(&fork, &anchor(&value, 1, 2), &known).is_err());
        let conflict = RecoveryEpochDigest {
            state_epoch: 16,
            transition_digest: value["fork"]["transitionDigest"]
                .as_str()
                .unwrap()
                .to_owned(),
        };
        assert!(verify(&[], &anchor(&value, 16, 16), &[conflict]).is_err());
        for changed in [
            vec![known[0].clone(), known[0].clone()],
            [known.clone(), vec![known[0].clone()]].concat(),
            vec![RecoveryEpochDigest {
                state_epoch: 0,
                transition_digest: known[0].transition_digest.clone(),
            }],
            vec![RecoveryEpochDigest {
                state_epoch: 17,
                transition_digest: known[0].transition_digest.clone(),
            }],
            vec![RecoveryEpochDigest {
                state_epoch: 1,
                transition_digest: encode_base64url(&[0; 32]),
            }],
        ] {
            assert!(verify(&entries(&value), &anchor(&value, 0, 16), &changed).is_err());
        }
        let mut context = anchor(&value, 16, 16);
        context.transition_digest = encode_base64url(&[0; 32]);
        assert!(verify(&[], &context, &[]).is_err());
        context = anchor(&value, 0, 0);
        context.transition_digest = known[0].transition_digest.clone();
        assert!(verify(&[], &context, &[]).is_err());
        context = anchor(&value, 0, 0);
        context.writer_public_key = encode_base64url(&[0; 32]);
        assert!(verify(&[], &context, &[]).is_err());
        let points: Value = serde_json::from_str(include_str!(
            "../../../packages/protocol/vectors/recovery-transition-v1.json"
        ))
        .unwrap();
        context.writer_public_key = points["rejectedPointVectors"][2]["publicKey"]
            .as_str()
            .unwrap()
            .to_owned();
        assert!(verify(&[], &context, &[]).is_err());
    }

    #[test]
    fn digests_require_exact_record_bytes_and_verified_results_own_their_bytes() {
        let value = vector();
        let mut input = entries(&value);
        let result = verify(&input, &anchor(&value, 0, 16), &[]).unwrap();
        input[0].0.fill(0);
        input[0].1.fill(0);
        assert_eq!(
            result.transitions[0].jcs_bytes,
            entry(&value["transitions"][0]).0
        );
        assert_eq!(
            result.transitions[0].signature,
            entry(&value["transitions"][0]).1
        );
        let mut noncanonical = entry(&value["transitions"][0]).0;
        noncanonical.push(b' ');
        assert!(recovery_transition_digest(&noncanonical).is_err());
        assert!(recovery_transition_digest(&vec![0; 2_049]).is_err());
        let artifact = crate::canonical_json_bytes(&serde_json::json!({
            "record": value["transitions"][0]["record"],
            "signature": value["transitions"][0]["signature"]
        }))
        .unwrap();
        assert!(recovery_transition_digest(&artifact).is_err());
    }
}
