use automerge::{Automerge, ROOT, ReadDoc};
use base64ct::{Base64, Base64UrlUnpadded, Encoding};
use serde::Deserialize;
use smallframe_core::{
    ErrorCode, build_signed_package, canonical_zip, parse_strict_json, read_canonical_zip,
    validate_manifest, validate_source_files, verify_package_archive, verify_package_files,
};
use std::io::{Cursor, Write};
use zip::{CompressionMethod, DateTime, ZipWriter, write::SimpleFileOptions};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GenesisVector {
    bytes: usize,
    sha256_hex: String,
    base64: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SignedRecordSet {
    vectors: Vec<SignedRecordVector>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SignedRecordVector {
    payload_type: String,
    record: serde_json::Value,
    canonical_base64: String,
    signature: String,
    key_id: String,
}

#[test]
fn canonical_archive_vector_is_byte_exact_and_link_pinned() {
    let encoded =
        include_str!("../../../packages/protocol/vectors/canonical-package-v1.zip.b64").trim();
    let archive = Base64::decode_vec(encoded).expect("decode package vector");
    assert_eq!(archive.len(), 2_351);
    let expected_digest = [
        0xc4, 0x6c, 0xce, 0x2a, 0x47, 0x9f, 0x83, 0x37, 0xc4, 0x15, 0x4f, 0x80, 0x16, 0xf4, 0x8c,
        0xe3, 0x31, 0xe7, 0xf5, 0xbc, 0x3e, 0x5c, 0x5d, 0xf1, 0xc2, 0x51, 0xe8, 0xcf, 0xe4, 0x07,
        0x24, 0x00,
    ];
    let package = verify_package_archive(
        &archive,
        Some(&expected_digest),
        Some("sha256:_oEsEvOrTOasXbaaw1L5BssbEe9D-zPiUu9_9VImOIk"),
    )
    .expect("verify canonical package vector");
    assert_eq!(package.canonical_archive, archive);
}

#[test]
fn one_bit_module_mutation_has_stable_error() {
    let encoded =
        include_str!("../../../packages/protocol/vectors/canonical-package-v1.zip.b64").trim();
    let archive = Base64::decode_vec(encoded).expect("decode package vector");
    let mut files = read_canonical_zip(&archive).expect("read canonical package");
    files.module[0] ^= 1;
    let error = verify_package_files(&files, true).expect_err("mutation must fail");
    assert_eq!(error.code(), ErrorCode::PackageFileHashMismatch);
    let mutated_archive = canonical_zip(&files).expect("encode mutated fixture");
    let error = verify_package_archive(&mutated_archive, None, None)
        .expect_err("archive mutation must fail");
    assert_eq!(error.code(), ErrorCode::PackageFileHashMismatch);
}

#[test]
fn automerge_genesis_vector_loads_and_projects() {
    let vector: GenesisVector = serde_json::from_str(include_str!(
        "../../../packages/protocol/vectors/automerge-genesis-v1.json"
    ))
    .expect("parse genesis vector");
    let bytes = Base64::decode_vec(&vector.base64).expect("decode genesis vector");
    assert_eq!(bytes.len(), vector.bytes);
    assert_eq!(
        smallframe_core::hex_digest(&smallframe_core::sha256(&bytes)),
        vector.sha256_hex
    );
    let document = Automerge::load(&bytes).expect("load genesis vector");
    assert!(
        document
            .get(&ROOT, "decisions")
            .expect("read decisions")
            .is_some()
    );
}

#[test]
fn parser_seed_corpus_is_bounded_and_panic_free() {
    let json_seeds = [
        include_bytes!("../../../fuzz/corpus/json/duplicate-key.json").as_slice(),
        include_bytes!("../../../fuzz/corpus/json/unsafe-integer.json").as_slice(),
        include_bytes!("../../../fuzz/corpus/json/trailing-data.json").as_slice(),
    ];
    for seed in json_seeds {
        assert!(parse_strict_json(seed).is_err());
    }
    let encoded = include_str!("../../../fuzz/corpus/archive/truncated.hex").trim();
    let truncated: Vec<u8> = encoded
        .as_bytes()
        .chunks_exact(2)
        .map(|pair| {
            u8::from_str_radix(std::str::from_utf8(pair).expect("hex UTF-8"), 16)
                .expect("decode hex seed")
        })
        .collect();
    assert!(verify_package_archive(&truncated, None, None).is_err());
}

#[test]
fn detached_signed_record_vectors_verify_and_reject_one_bit() {
    let vectors: SignedRecordSet = serde_json::from_str(include_str!(
        "../../../packages/protocol/vectors/signed-records-v1.json"
    ))
    .expect("parse signed-record vectors");
    let publisher = ed25519_dalek::SigningKey::from_bytes(&[7_u8; 32]);
    let release = ed25519_dalek::SigningKey::from_bytes(&[0x52_u8; 32]);
    for vector in vectors.vectors {
        let canonical =
            smallframe_core::canonical_json_bytes(&vector.record).expect("canonical record");
        assert_eq!(Base64::encode_string(&canonical), vector.canonical_base64);
        let signature: [u8; 64] = Base64UrlUnpadded::decode_vec(&vector.signature)
            .expect("decode signature")
            .try_into()
            .expect("signature length");
        let key = if vector.key_id == smallframe_core::key_id(&publisher.verifying_key().to_bytes())
        {
            &publisher
        } else {
            &release
        };
        smallframe_core::verify_dsse_pae(
            &vector.payload_type,
            &canonical,
            &key.verifying_key().to_bytes(),
            &signature,
        )
        .expect("verify signed record vector");
        let mut mutated = signature;
        mutated[0] ^= 1;
        assert_eq!(
            smallframe_core::verify_dsse_pae(
                &vector.payload_type,
                &canonical,
                &key.verifying_key().to_bytes(),
                &mutated,
            )
            .expect_err("one-bit signature mutation must fail")
            .code(),
            ErrorCode::SignatureInvalid
        );
    }
}

fn zip_with_entries(entries: &[(&str, &[u8])]) -> Vec<u8> {
    let mut writer = ZipWriter::new(Cursor::new(Vec::new()));
    let options = SimpleFileOptions::default()
        .compression_method(CompressionMethod::Stored)
        .last_modified_time(DateTime::from_date_and_time(1980, 1, 1, 0, 0, 0).expect("ZIP epoch"))
        .unix_permissions(0o644);
    for (path, bytes) in entries {
        writer
            .start_file(*path, options)
            .expect("start fixture entry");
        writer.write_all(bytes).expect("write fixture entry");
    }
    writer
        .finish()
        .expect("finish fixture archive")
        .into_inner()
}

#[test]
fn archive_path_count_and_dsse_mutations_have_stable_errors() {
    let encoded =
        include_str!("../../../packages/protocol/vectors/canonical-package-v1.zip.b64").trim();
    let archive = Base64::decode_vec(encoded).expect("decode package vector");
    let files = read_canonical_zip(&archive).expect("read canonical vector");
    let missing = zip_with_entries(&[
        ("app.worker.js", &files.module),
        ("smallframe.json", &files.manifest),
    ]);
    assert_eq!(
        verify_package_archive(&missing, None, None)
            .expect_err("missing entry must fail")
            .code(),
        ErrorCode::PackageEntryCountInvalid
    );
    let extra = zip_with_entries(&[
        ("app.worker.js", &files.module),
        ("signature.dsse.json", &files.signature),
        ("smallframe.json", &files.manifest),
        ("extra.txt", b"extra"),
    ]);
    assert_eq!(
        verify_package_archive(&extra, None, None)
            .expect_err("extra entry must fail")
            .code(),
        ErrorCode::PackageEntryCountInvalid
    );
    let traversal = zip_with_entries(&[
        ("app.worker.js", &files.module),
        ("signature.dsse.json", &files.signature),
        ("../smallframe.json", &files.manifest),
    ]);
    assert_eq!(
        verify_package_archive(&traversal, None, None)
            .expect_err("traversal must fail")
            .code(),
        ErrorCode::PackagePathInvalid
    );
    let mut bomb_metadata = archive.clone();
    let central = bomb_metadata
        .windows(4)
        .position(|bytes| bytes == [0x50, 0x4b, 0x01, 0x02])
        .expect("first central-directory header");
    bomb_metadata[central + 24..central + 28].copy_from_slice(&1_048_577_u32.to_le_bytes());
    assert_eq!(
        verify_package_archive(&bomb_metadata, None, None)
            .expect_err("oversized ZIP metadata must fail before expansion")
            .code(),
        ErrorCode::PackageSizeLimit
    );

    let mut wrong_type = files.clone();
    let mut envelope = parse_strict_json(&wrong_type.signature).expect("parse DSSE vector");
    envelope["payloadType"] = serde_json::json!("application/vnd.smallframe.other+json");
    wrong_type.signature =
        smallframe_core::canonical_json_bytes(&envelope).expect("canonical DSSE");
    assert_eq!(
        verify_package_files(&wrong_type, true)
            .expect_err("wrong payload type must fail")
            .code(),
        ErrorCode::DssePayloadTypeInvalid
    );

    let mut bad_signature = files.clone();
    let mut envelope = parse_strict_json(&bad_signature.signature).expect("parse DSSE signature");
    let encoded_signature = envelope["signatures"][0]["sig"]
        .as_str()
        .expect("signature string");
    let mut signature = Base64::decode_vec(encoded_signature).expect("decode package signature");
    signature[0] ^= 1;
    envelope["signatures"][0]["sig"] = serde_json::json!(Base64::encode_string(&signature));
    bad_signature.signature =
        smallframe_core::canonical_json_bytes(&envelope).expect("canonical mutated DSSE");
    assert_eq!(
        verify_package_files(&bad_signature, true)
            .expect_err("one-bit package signature mutation must fail")
            .code(),
        ErrorCode::SignatureInvalid
    );

    let mut wrong_key = files;
    let mut manifest = parse_strict_json(&wrong_key.manifest).expect("parse manifest vector");
    manifest["publisher"]["keyId"] =
        serde_json::json!("sha256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
    wrong_key.manifest =
        smallframe_core::canonical_json_bytes(&manifest).expect("canonical manifest");
    assert_eq!(
        verify_package_files(&wrong_key, true)
            .expect_err("wrong key ID must fail")
            .code(),
        ErrorCode::PublisherKeyIdMismatch
    );
}

#[test]
fn noncanonical_directory_json_normalizes_but_publish_artifact_rejects_it() {
    let encoded =
        include_str!("../../../packages/protocol/vectors/canonical-package-v1.zip.b64").trim();
    let archive = Base64::decode_vec(encoded).expect("decode package vector");
    let files = read_canonical_zip(&archive).expect("read canonical vector");
    let value = parse_strict_json(&files.manifest).expect("parse canonical manifest");
    let noncanonical = serde_json::to_vec_pretty(&value).expect("pretty manifest");
    assert_ne!(noncanonical, files.manifest);
    let source = validate_source_files(&noncanonical, &files.module, false)
        .expect("noncanonical source directory JSON is accepted for normalization");
    let rebuilt = build_signed_package(
        value,
        &files.module,
        &ed25519_dalek::SigningKey::from_bytes(&[7_u8; 32]),
    )
    .expect("normalize and rebuild package");
    assert_eq!(rebuilt.package_digest, source.package_digest);
    assert_eq!(rebuilt.canonical_archive, archive);

    let noncanonical_files = smallframe_core::PackageFiles {
        manifest: noncanonical,
        module: files.module,
        signature: files.signature,
    };
    let noncanonical_archive =
        canonical_zip(&noncanonical_files).expect("encode source JSON archive");
    assert_eq!(
        verify_package_archive(&noncanonical_archive, None, None)
            .expect_err("publish artifact must contain exact JCS")
            .code(),
        ErrorCode::JsonNotCanonical
    );
}

#[test]
fn unicode_normalization_and_archive_size_edges_fail_closed() {
    let encoded =
        include_str!("../../../packages/protocol/vectors/canonical-package-v1.zip.b64").trim();
    let archive = Base64::decode_vec(encoded).expect("decode package vector");
    let files = read_canonical_zip(&archive).expect("read canonical vector");
    let mut manifest = parse_strict_json(&files.manifest).expect("parse canonical manifest");
    manifest["name"] = serde_json::json!("Cafe\u{301}");
    assert_eq!(
        validate_manifest(manifest)
            .expect_err("non-NFC display text must fail")
            .code(),
        ErrorCode::ManifestUnicodeInvalid
    );
    let oversized = vec![0_u8; 1_100_001];
    assert_eq!(
        verify_package_archive(&oversized, None, None)
            .expect_err("oversized archive must fail before ZIP allocation")
            .code(),
        ErrorCode::PackageSizeLimit
    );
}
