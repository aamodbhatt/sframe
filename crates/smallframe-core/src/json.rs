use crate::{CoreError, ErrorCode, Result};
use serde::de::{DeserializeSeed, MapAccess, SeqAccess, Visitor};
use serde_json::{Map, Number, Value};
use std::{collections::HashSet, fmt};

const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const DUPLICATE_SENTINEL: &str = "smallframe duplicate JSON key";
const NUMBER_SENTINEL: &str = "smallframe non-I-JSON number";

struct StrictValueSeed;

struct StrictValueVisitor;

impl<'de> DeserializeSeed<'de> for StrictValueSeed {
    type Value = Value;

    fn deserialize<D>(self, deserializer: D) -> std::result::Result<Self::Value, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        deserializer.deserialize_any(StrictValueVisitor)
    }
}

impl<'de> Visitor<'de> for StrictValueVisitor {
    type Value = Value;

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("strict I-JSON")
    }

    fn visit_bool<E>(self, value: bool) -> std::result::Result<Self::Value, E> {
        Ok(Value::Bool(value))
    }

    fn visit_i64<E>(self, value: i64) -> std::result::Result<Self::Value, E>
    where
        E: serde::de::Error,
    {
        if value.unsigned_abs() > MAX_SAFE_INTEGER {
            return Err(E::custom(NUMBER_SENTINEL));
        }
        Ok(Value::Number(Number::from(value)))
    }

    fn visit_u64<E>(self, value: u64) -> std::result::Result<Self::Value, E>
    where
        E: serde::de::Error,
    {
        if value > MAX_SAFE_INTEGER {
            return Err(E::custom(NUMBER_SENTINEL));
        }
        Ok(Value::Number(Number::from(value)))
    }

    fn visit_f64<E>(self, value: f64) -> std::result::Result<Self::Value, E>
    where
        E: serde::de::Error,
    {
        if !value.is_finite() {
            return Err(E::custom(NUMBER_SENTINEL));
        }
        Number::from_f64(value)
            .map(Value::Number)
            .ok_or_else(|| E::custom(NUMBER_SENTINEL))
    }

    fn visit_str<E>(self, value: &str) -> std::result::Result<Self::Value, E>
    where
        E: serde::de::Error,
    {
        Ok(Value::String(value.to_owned()))
    }

    fn visit_string<E>(self, value: String) -> std::result::Result<Self::Value, E> {
        Ok(Value::String(value))
    }

    fn visit_none<E>(self) -> std::result::Result<Self::Value, E> {
        Ok(Value::Null)
    }

    fn visit_unit<E>(self) -> std::result::Result<Self::Value, E> {
        Ok(Value::Null)
    }

    fn visit_seq<A>(self, mut sequence: A) -> std::result::Result<Self::Value, A::Error>
    where
        A: SeqAccess<'de>,
    {
        let mut values = Vec::new();
        while let Some(value) = sequence.next_element_seed(StrictValueSeed)? {
            values.push(value);
        }
        Ok(Value::Array(values))
    }

    fn visit_map<A>(self, mut entries: A) -> std::result::Result<Self::Value, A::Error>
    where
        A: MapAccess<'de>,
    {
        let mut keys = HashSet::new();
        let mut values = Map::new();
        while let Some(key) = entries.next_key::<String>()? {
            if !keys.insert(key.clone()) {
                return Err(serde::de::Error::custom(DUPLICATE_SENTINEL));
            }
            values.insert(key, entries.next_value_seed(StrictValueSeed)?);
        }
        Ok(Value::Object(values))
    }
}

pub fn parse_strict_json(input: &[u8]) -> Result<Value> {
    let mut deserializer = serde_json::Deserializer::from_slice(input);
    let value = StrictValueSeed
        .deserialize(&mut deserializer)
        .map_err(|error| {
            let message = error.to_string();
            if message.contains(DUPLICATE_SENTINEL) {
                CoreError::new(ErrorCode::JsonDuplicateKey, "duplicate object member")
            } else if message.contains(NUMBER_SENTINEL) {
                CoreError::new(ErrorCode::JsonNonIjsonNumber, "number is outside I-JSON")
            } else {
                CoreError::new(ErrorCode::JsonInvalid, "malformed JSON")
            }
        })?;
    deserializer
        .end()
        .map_err(|_| CoreError::new(ErrorCode::JsonInvalid, "trailing JSON data"))?;
    Ok(value)
}

pub fn canonical_json_bytes(value: &Value) -> Result<Vec<u8>> {
    serde_jcs::to_vec(value)
        .map_err(|_| CoreError::new(ErrorCode::JsonInvalid, "JCS serialization failed"))
}

pub fn canonical_json(input: &str) -> Result<String> {
    let value = parse_strict_json(input.as_bytes())?;
    let bytes = canonical_json_bytes(&value)?;
    String::from_utf8(bytes)
        .map_err(|_| CoreError::new(ErrorCode::JsonInvalid, "JCS output is not UTF-8"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonicalizes_and_sorts_using_jcs() {
        let canonical = canonical_json(r#"{"z":-0,"a":[3,true,null]}"#);
        assert_eq!(
            canonical.as_deref().expect("canonical JSON"),
            r#"{"a":[3,true,null],"z":0}"#
        );
    }

    #[test]
    fn rejects_duplicate_keys_and_unsafe_integers() {
        let duplicate = parse_strict_json(br#"{"a":1,"a":2}"#);
        assert_eq!(
            duplicate.err().map(|error| error.code()),
            Some(ErrorCode::JsonDuplicateKey)
        );
        let unsafe_integer = parse_strict_json(b"9007199254740992");
        assert_eq!(
            unsafe_integer.err().map(|error| error.code()),
            Some(ErrorCode::JsonNonIjsonNumber)
        );
    }
}
