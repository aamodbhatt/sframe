use automerge::{
    ActorId, AutoCommit, Automerge, ObjId, ObjType, ROOT, ReadDoc, ScalarValue, Value,
    transaction::Transactable,
};
use serde_json::{Map, Value as JsonValue};
use std::collections::HashSet;
use unicode_normalization::UnicodeNormalization;

pub const MAX_AUTOMERGE_BYTES: usize = 475_136;
pub const MAX_CHANGES: usize = 10_000;
pub const MAX_OPERATIONS: usize = 100_000;
pub const MAX_ACTORS: usize = 64;
pub const MAX_HEADS: usize = 128;
const MAX_CONFLICTS: usize = 1_024;
const MAX_DEPTH: usize = 32;
const MAX_MAPS: usize = 4_096;
const MAX_PROPERTIES: usize = 16_384;
const MAX_ARRAYS: usize = 1_024;
const MAX_ARRAY_LENGTH: usize = 2_048;
const MAX_SCALARS: usize = 32_768;
const MAX_STRING_SCALARS: usize = 32_768;
const MAX_SAFE_INTEGER: i128 = 9_007_199_254_740_991;

#[derive(Default)]
struct ProjectionCounts {
    maps: usize,
    properties: usize,
    arrays: usize,
    scalars: usize,
    conflicts: usize,
}

fn validate_key(key: &str) -> Result<(), String> {
    let count = key.chars().count();
    let unsafe_key = count == 0
        || count > 64
        || key.nfc().collect::<String>() != key
        || [".", "..", "__proto__", "prototype", "constructor"].contains(&key)
        || key.chars().any(|c| {
            c.is_control() || matches!(c, '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')
        });
    if unsafe_key {
        Err("AUTOMERGE_KEY_INVALID".into())
    } else {
        Ok(())
    }
}

fn validate_json_leaf(
    value: &JsonValue,
    depth: usize,
    counts: &mut ProjectionCounts,
) -> Result<(), String> {
    if depth > MAX_DEPTH {
        return Err("STATE_DEPTH_EXCEEDED".into());
    }
    match value {
        JsonValue::Array(values) => {
            counts.arrays += 1;
            if counts.arrays > MAX_ARRAYS || values.len() > MAX_ARRAY_LENGTH {
                return Err("STATE_ARRAY_LIMIT_EXCEEDED".into());
            }
            for value in values {
                validate_json_leaf(value, depth + 1, counts)?;
            }
        }
        JsonValue::Object(values) => {
            counts.maps += 1;
            if counts.maps > MAX_MAPS {
                return Err("STATE_MAP_LIMIT_EXCEEDED".into());
            }
            for (key, value) in values {
                validate_key(key)?;
                counts.properties += 1;
                if counts.properties > MAX_PROPERTIES {
                    return Err("STATE_PROPERTY_LIMIT_EXCEEDED".into());
                }
                validate_json_leaf(value, depth + 1, counts)?;
            }
        }
        JsonValue::String(value) if value.chars().count() > MAX_STRING_SCALARS => {
            return Err("STATE_STRING_LIMIT_EXCEEDED".into());
        }
        JsonValue::Number(value)
            if value.as_i64().map_or_else(
                || {
                    value
                        .as_u64()
                        .is_none_or(|n| i128::from(n) > MAX_SAFE_INTEGER)
                },
                |n| i128::from(n).abs() > MAX_SAFE_INTEGER,
            ) =>
        {
            return Err("STATE_NUMBER_INVALID".into());
        }
        _ => {}
    }
    if !value.is_array() && !value.is_object() {
        counts.scalars += 1;
    }
    if counts.scalars > MAX_SCALARS {
        return Err("STATE_SCALAR_LIMIT_EXCEEDED".into());
    }
    Ok(())
}

fn validate_projection_limits(doc: &Automerge) -> Result<(), String> {
    let mut counts = ProjectionCounts::default();
    let mut stack = vec![(ROOT, 0usize)];
    while let Some((object, depth)) = stack.pop() {
        if depth > MAX_DEPTH {
            return Err("STATE_DEPTH_EXCEEDED".into());
        }
        counts.maps += 1;
        if counts.maps > MAX_MAPS {
            return Err("STATE_MAP_LIMIT_EXCEEDED".into());
        }
        for key in doc.keys(&object) {
            validate_key(&key)?;
            counts.properties += 1;
            if counts.properties > MAX_PROPERTIES {
                return Err("STATE_PROPERTY_LIMIT_EXCEEDED".into());
            }
            let values = doc
                .get_all(&object, key)
                .map_err(|_| "AUTOMERGE_READ_ERROR".to_string())?;
            counts.conflicts = counts
                .conflicts
                .saturating_add(values.len().saturating_sub(1));
            if counts.conflicts > MAX_CONFLICTS {
                return Err("AUTOMERGE_CONFLICT_LIMIT_EXCEEDED".into());
            }
            for (value, child) in values {
                match value {
                    Value::Object(ObjType::Map) => stack.push((child, depth + 1)),
                    Value::Object(_) => return Err("AUTOMERGE_OBJECT_TYPE_FORBIDDEN".into()),
                    Value::Scalar(scalar) => match scalar.as_ref() {
                        ScalarValue::Null | ScalarValue::Boolean(_) => counts.scalars += 1,
                        ScalarValue::Str(value) if value.chars().count() <= MAX_STRING_SCALARS => {
                            counts.scalars += 1
                        }
                        ScalarValue::Int(value) if i128::from(*value).abs() <= MAX_SAFE_INTEGER => {
                            counts.scalars += 1
                        }
                        ScalarValue::Uint(value) if i128::from(*value) <= MAX_SAFE_INTEGER => {
                            counts.scalars += 1
                        }
                        ScalarValue::F64(value) if value.is_finite() => counts.scalars += 1,
                        ScalarValue::Bytes(bytes) => {
                            let array: JsonValue = serde_json::from_slice(bytes)
                                .map_err(|_| "AUTOMERGE_ARRAY_INVALID".to_string())?;
                            if !array.is_array() {
                                return Err("AUTOMERGE_ARRAY_INVALID".into());
                            }
                            validate_json_leaf(&array, depth + 1, &mut counts)?;
                        }
                        _ => return Err("AUTOMERGE_SCALAR_TYPE_FORBIDDEN".into()),
                    },
                }
                if counts.scalars > MAX_SCALARS {
                    return Err("STATE_SCALAR_LIMIT_EXCEEDED".into());
                }
            }
        }
    }
    Ok(())
}

fn validate_history_limits(
    doc: &Automerge,
    max_changes: usize,
    max_operations: usize,
    max_actors: usize,
) -> Result<(), String> {
    let changes = doc.get_changes(&[]);
    if changes.len() > max_changes {
        return Err("MAX_CHANGES_EXCEEDED".into());
    }
    let mut operations = 0usize;
    let mut actors = HashSet::new();
    for change in &changes {
        operations = operations
            .checked_add(change.len())
            .ok_or_else(|| "MAX_OPERATIONS_EXCEEDED".to_string())?;
        if operations > max_operations {
            return Err("MAX_OPERATIONS_EXCEEDED".into());
        }
        for actor in change.actors() {
            actors.insert(actor.to_bytes().to_vec());
            if actors.len() > max_actors {
                return Err("MAX_ACTORS_EXCEEDED".into());
            }
        }
    }
    Ok(())
}

pub fn set_json_value<T: Transactable>(
    tx: &mut T,
    obj: &ObjId,
    key: &str,
    val: &JsonValue,
) -> Result<(), automerge::AutomergeError> {
    match val {
        JsonValue::Null => {
            tx.put(obj, key, ScalarValue::Null)?;
        }
        JsonValue::Bool(b) => {
            tx.put(obj, key, *b)?;
        }
        JsonValue::Number(n) => {
            if let Some(i) = n.as_i64() {
                tx.put(obj, key, i)?;
            } else if let Some(f) = n.as_f64() {
                tx.put(obj, key, f)?;
            }
        }
        JsonValue::String(s) => {
            tx.put(obj, key, s.as_str())?;
        }
        JsonValue::Array(_) => {
            // Bytes distinguish an atomic array from an ordinary user string.
            // A string beginning with a magic prefix must never change JSON type.
            let array_bytes = serde_json::to_vec(val).expect("JSON values serialize");
            tx.put(obj, key, ScalarValue::Bytes(array_bytes))?;
        }
        JsonValue::Object(map) => {
            let child = match tx.get(obj, key)? {
                Some((Value::Object(ObjType::Map), child_id)) => child_id,
                _ => tx.put_object(obj, key, ObjType::Map)?,
            };
            sync_json_object(tx, &child, map)?;
        }
    }
    Ok(())
}

pub fn sync_json_object<T: Transactable>(
    tx: &mut T,
    obj: &ObjId,
    new_map: &Map<String, JsonValue>,
) -> Result<(), automerge::AutomergeError> {
    let existing_keys: Vec<String> = tx.keys(obj).collect();
    for k in existing_keys {
        if !new_map.contains_key(&k) {
            tx.delete(obj, k.as_str())?;
        }
    }
    for (k, v) in new_map {
        match v {
            JsonValue::Object(child_map) => {
                let child = match tx.get(obj, k.as_str())? {
                    Some((Value::Object(ObjType::Map), child_id)) => child_id,
                    _ => tx.put_object(obj, k.as_str(), ObjType::Map)?,
                };
                sync_json_object(tx, &child, child_map)?;
            }
            _ => {
                set_json_value(tx, obj, k.as_str(), v)?;
            }
        }
    }
    Ok(())
}

pub fn project_json<D: ReadDoc>(doc: &D, obj: &ObjId) -> JsonValue {
    let keys = doc.keys(obj);
    let mut map = Map::new();

    for key in keys {
        if let Ok(Some((val, child_id))) = doc.get(obj, &key) {
            match val {
                Value::Object(ObjType::Map) => {
                    let child_val = project_json(doc, &child_id);
                    map.insert(key, child_val);
                }
                Value::Object(_) => {
                    // unsupported object type
                }
                Value::Scalar(scalar) => match scalar.as_ref() {
                    ScalarValue::Null => {
                        map.insert(key, JsonValue::Null);
                    }
                    ScalarValue::Boolean(b) => {
                        map.insert(key, JsonValue::Bool(*b));
                    }
                    ScalarValue::Int(i) => {
                        map.insert(key, JsonValue::from(*i));
                    }
                    ScalarValue::Uint(u) => {
                        map.insert(key, JsonValue::from(*u));
                    }
                    ScalarValue::F64(f) => {
                        if let Some(n) = serde_json::Number::from_f64(*f) {
                            map.insert(key, JsonValue::Number(n));
                        }
                    }
                    ScalarValue::Str(s) => {
                        map.insert(key, JsonValue::String(s.to_string()));
                    }
                    ScalarValue::Bytes(bytes) => {
                        if let Ok(value @ JsonValue::Array(_)) = serde_json::from_slice(bytes) {
                            map.insert(key, value);
                        }
                    }
                    _ => {}
                },
            }
        }
    }

    JsonValue::Object(map)
}

pub fn create_genesis_document(
    initial_json: &str,
    actor_id_bytes: &[u8],
) -> Result<Vec<u8>, String> {
    let actor = ActorId::from(actor_id_bytes);
    let mut doc = AutoCommit::new().with_actor(actor);

    if !initial_json.trim().is_empty() {
        let val: JsonValue =
            serde_json::from_str(initial_json).map_err(|e| format!("JSON_INVALID: {}", e))?;
        if let JsonValue::Object(map) = val {
            sync_json_object(&mut doc, &ROOT, &map)
                .map_err(|e| format!("AUTOMERGE_SET_ERROR: {}", e))?;
        }
    }

    Ok(doc.save())
}

pub fn apply_patch_to_document(
    doc_bytes: &[u8],
    patch_json: &str,
    actor_id_bytes: &[u8],
) -> Result<Vec<u8>, String> {
    let actor = ActorId::from(actor_id_bytes);
    let mut doc = AutoCommit::load(doc_bytes)
        .map_err(|e| format!("AUTOMERGE_LOAD_ERROR: {}", e))?
        .with_actor(actor);

    let val: JsonValue =
        serde_json::from_str(patch_json).map_err(|e| format!("JSON_INVALID: {}", e))?;

    if let JsonValue::Object(map) = val {
        sync_json_object(&mut doc, &ROOT, &map)
            .map_err(|e| format!("AUTOMERGE_PATCH_ERROR: {}", e))?;
    }

    Ok(doc.save())
}

pub fn merge_documents(local_bytes: &[u8], remote_bytes: &[u8]) -> Result<Vec<u8>, String> {
    let mut local =
        AutoCommit::load(local_bytes).map_err(|e| format!("LOCAL_LOAD_ERROR: {}", e))?;
    let mut remote =
        AutoCommit::load(remote_bytes).map_err(|e| format!("REMOTE_LOAD_ERROR: {}", e))?;

    local
        .merge(&mut remote)
        .map_err(|e| format!("MERGE_ERROR: {}", e))?;

    Ok(local.save())
}

pub fn project_document_to_json(doc_bytes: &[u8]) -> Result<String, String> {
    let doc = Automerge::load(doc_bytes).map_err(|e| format!("AUTOMERGE_LOAD_ERROR: {}", e))?;
    let val = project_json(&doc, &ROOT);
    serde_json::to_string(&val).map_err(|e| format!("JSON_SERIALIZE_ERROR: {}", e))
}

pub fn validate_document(doc_bytes: &[u8], max_bytes: usize) -> Result<(), String> {
    if doc_bytes.len() > max_bytes || doc_bytes.len() > MAX_AUTOMERGE_BYTES {
        return Err("AUTOMERGE_SIZE_EXCEEDED".into());
    }

    let doc = Automerge::load(doc_bytes).map_err(|e| format!("AUTOMERGE_CORRUPT: {}", e))?;
    validate_history_limits(&doc, MAX_CHANGES, MAX_OPERATIONS, MAX_ACTORS)?;
    validate_projection_limits(&doc)?;

    if doc.get_heads().len() > MAX_HEADS {
        return Err("MAX_HEADS_EXCEEDED".into());
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn atomic_arrays_do_not_collide_with_user_strings() {
        let initial = r#"{"array":[1,"two"],"text":"__sf_arr:[1,2]"}"#;
        let doc = create_genesis_document(initial, &[1; 16]).expect("genesis");
        let projected: JsonValue =
            serde_json::from_str(&project_document_to_json(&doc).expect("project")).expect("JSON");
        assert_eq!(
            projected,
            serde_json::from_str::<JsonValue>(initial).expect("input")
        );
    }

    #[test]
    fn test_genesis_and_project() {
        let actor = [0x42u8; 16];
        let initial = r#"{"decisions":{"d1":{"title":"Build MVP"}}}"#;
        let bytes = create_genesis_document(initial, &actor).expect("create genesis");
        assert!(!bytes.is_empty());

        let projected = project_document_to_json(&bytes).expect("project");
        let parsed: JsonValue = serde_json::from_str(&projected).expect("parse projected");
        assert_eq!(parsed["decisions"]["d1"]["title"], "Build MVP");
    }

    #[test]
    fn test_patch_and_merge() {
        let actor1 = [0x11u8; 16];
        let actor2 = [0x22u8; 16];

        let genesis = create_genesis_document(r#"{"decisions":{}}"#, &actor1).expect("genesis");

        // Actor 1 adds decision 1
        let doc1 = apply_patch_to_document(
            &genesis,
            r#"{"decisions":{"d1":{"title":"Decision 1"}}}"#,
            &actor1,
        )
        .expect("actor 1 patch");

        // Actor 2 adds decision 2 concurrently on genesis
        let doc2 = apply_patch_to_document(
            &genesis,
            r#"{"decisions":{"d2":{"title":"Decision 2"}}}"#,
            &actor2,
        )
        .expect("actor 2 patch");

        // Merge doc2 into doc1
        let merged = merge_documents(&doc1, &doc2).expect("merge");

        let projected = project_document_to_json(&merged).expect("project");
        let parsed: JsonValue = serde_json::from_str(&projected).expect("parse projected");

        assert_eq!(parsed["decisions"]["d1"]["title"], "Decision 1");
        assert_eq!(parsed["decisions"]["d2"]["title"], "Decision 2");
    }

    #[test]
    fn test_delete_key_sync() {
        let actor = [0x33u8; 16];
        let initial = r#"{"decisions":{"d1":{"title":"Decision 1"},"d2":{"title":"Decision 2"}}}"#;
        let doc = create_genesis_document(initial, &actor).expect("create genesis");

        // Remove d1
        let updated = apply_patch_to_document(
            &doc,
            r#"{"decisions":{"d2":{"title":"Decision 2"}}}"#,
            &actor,
        )
        .expect("delete");

        let projected = project_document_to_json(&updated).expect("project");
        let parsed: JsonValue = serde_json::from_str(&projected).expect("parse projected");

        assert!(parsed["decisions"]["d1"].is_null());
        assert_eq!(parsed["decisions"]["d2"]["title"], "Decision 2");
    }

    #[test]
    fn history_limits_count_changes_operations_and_actors() {
        let mut doc = AutoCommit::new().with_actor(ActorId::from([1_u8; 16].as_slice()));
        doc.put(&ROOT, "one", 1).expect("first operation");
        doc.commit();
        doc.set_actor(ActorId::from([2_u8; 16].as_slice()));
        doc.put(&ROOT, "two", 2).expect("second operation");
        doc.commit();
        let loaded = Automerge::load(&doc.save()).expect("load");

        assert_eq!(
            validate_history_limits(&loaded, 1, 10, 10),
            Err("MAX_CHANGES_EXCEEDED".into())
        );
        assert_eq!(
            validate_history_limits(&loaded, 10, 1, 10),
            Err("MAX_OPERATIONS_EXCEEDED".into())
        );
        assert_eq!(
            validate_history_limits(&loaded, 10, 10, 1),
            Err("MAX_ACTORS_EXCEEDED".into())
        );
        assert!(validate_history_limits(&loaded, 2, 2, 2).is_ok());
    }

    #[test]
    fn projection_limits_reject_unsupported_types_keys_and_numbers() {
        let actor = ActorId::from([3_u8; 16].as_slice());

        let mut list = AutoCommit::new().with_actor(actor.clone());
        list.put_object(&ROOT, "list", ObjType::List).expect("list");
        assert_eq!(
            validate_document(&list.save(), MAX_AUTOMERGE_BYTES),
            Err("AUTOMERGE_OBJECT_TYPE_FORBIDDEN".into())
        );

        let mut key = AutoCommit::new().with_actor(actor.clone());
        key.put(&ROOT, "__proto__", true).expect("key");
        assert_eq!(
            validate_document(&key.save(), MAX_AUTOMERGE_BYTES),
            Err("AUTOMERGE_KEY_INVALID".into())
        );

        let mut number = AutoCommit::new().with_actor(actor);
        number
            .put(&ROOT, "number", 9_007_199_254_740_992_u64)
            .expect("number");
        assert_eq!(
            validate_document(&number.save(), MAX_AUTOMERGE_BYTES),
            Err("AUTOMERGE_SCALAR_TYPE_FORBIDDEN".into())
        );
    }
}
