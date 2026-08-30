use crate::{CoreError, ErrorCode, Result, canonical_json_bytes};
use serde_json::{Map, Value};
use std::collections::{HashMap, HashSet};

const MAX_SCHEMA_BYTES: usize = 64 * 1024;
const MAX_SCHEMA_DEPTH: usize = 32;
const MAX_SCHEMA_NODES: usize = 2_000;
const MAX_SCHEMA_PROPERTIES: usize = 256;
const MAX_SCHEMA_ALTERNATIVES: usize = 64;

// Smallframe deliberately supports a deterministic, non-regex Draft 2020-12 subset.
// Native authoring additionally cross-checks this subset with the full meta-schema.
const ALLOWED_KEYWORDS: &[&str] = &[
    "$comment",
    "$defs",
    "$ref",
    "$schema",
    "additionalProperties",
    "allOf",
    "anyOf",
    "const",
    "description",
    "enum",
    "exclusiveMaximum",
    "exclusiveMinimum",
    "items",
    "maxItems",
    "maxLength",
    "maxProperties",
    "maximum",
    "minItems",
    "minLength",
    "minProperties",
    "minimum",
    "not",
    "oneOf",
    "properties",
    "required",
    "title",
    "type",
];

const FORBIDDEN_KEYWORDS: &[&str] = &[
    "$anchor",
    "$dynamicAnchor",
    "$dynamicRef",
    "$id",
    "$vocabulary",
    "contentEncoding",
    "contentMediaType",
    "contentSchema",
    "format",
    "pattern",
    "patternProperties",
];

const MAP_OF_SCHEMAS: &[&str] = &["$defs", "properties"];
const SINGLE_SCHEMAS: &[&str] = &["additionalProperties", "items", "not"];
const ARRAY_OF_SCHEMAS: &[&str] = &["allOf", "anyOf", "oneOf"];
const JSON_TYPES: &[&str] = &[
    "array", "boolean", "integer", "null", "number", "object", "string",
];

#[derive(Default)]
struct SchemaAnalysis {
    nodes: usize,
    properties: usize,
    alternatives: usize,
    edges: HashMap<String, Vec<String>>,
}

fn schema_error(detail: &'static str) -> CoreError {
    CoreError::new(ErrorCode::ManifestSchemaInvalid, detail)
}

fn complexity_error(detail: &'static str) -> CoreError {
    CoreError::new(ErrorCode::ManifestSchemaComplexity, detail)
}

fn pointer_token(value: &str) -> String {
    value.replace('~', "~0").replace('/', "~1")
}

fn child_pointer(parent: &str, token: &str) -> String {
    if parent == "#" {
        format!("#/{}", pointer_token(token))
    } else {
        format!("{parent}/{}", pointer_token(token))
    }
}

fn valid_local_pointer(reference: &str) -> bool {
    if reference == "#" {
        return true;
    }
    if !reference.starts_with("#/") || reference.contains('%') {
        return false;
    }
    let mut characters = reference.chars();
    while let Some(character) = characters.next() {
        if character == '~' && !matches!(characters.next(), Some('0' | '1')) {
            return false;
        }
    }
    true
}

fn unique_strings(value: &Value, allow_empty: bool) -> bool {
    let Some(values) = value.as_array() else {
        return false;
    };
    if !allow_empty && values.is_empty() {
        return false;
    }
    let mut seen = HashSet::new();
    values
        .iter()
        .all(|item| item.as_str().is_some_and(|item| seen.insert(item)))
}

fn unique_values(value: &Value) -> bool {
    let Some(values) = value.as_array() else {
        return false;
    };
    !values.is_empty()
        && values
            .iter()
            .enumerate()
            .all(|(index, item)| !values[..index].contains(item))
}

fn validate_type_keyword(value: &Value) -> bool {
    if let Some(value) = value.as_str() {
        return JSON_TYPES.contains(&value);
    }
    unique_strings(value, false)
        && value.as_array().is_some_and(|values| {
            values.iter().all(|value| {
                value
                    .as_str()
                    .is_some_and(|value| JSON_TYPES.contains(&value))
            })
        })
}

fn validate_keyword_shapes(schema: &Map<String, Value>) -> Result<()> {
    if schema
        .get("type")
        .is_some_and(|value| !validate_type_keyword(value))
        || schema
            .get("required")
            .is_some_and(|value| !unique_strings(value, true))
        || schema
            .get("enum")
            .is_some_and(|value| !unique_values(value))
    {
        return Err(schema_error("invalid type, required, or enum keyword"));
    }
    for keyword in ["maximum", "minimum", "exclusiveMaximum", "exclusiveMinimum"] {
        if schema.get(keyword).is_some_and(|value| !value.is_number()) {
            return Err(schema_error("numeric schema bound must be a number"));
        }
    }
    for keyword in [
        "maxItems",
        "maxLength",
        "maxProperties",
        "minItems",
        "minLength",
        "minProperties",
    ] {
        if schema
            .get(keyword)
            .is_some_and(|value| value.as_u64().is_none())
        {
            return Err(schema_error(
                "size schema bound must be an unsigned integer",
            ));
        }
    }
    for keyword in ["$comment", "description", "title"] {
        if schema.get(keyword).is_some_and(|value| !value.is_string()) {
            return Err(schema_error("schema annotation must be a string"));
        }
    }
    Ok(())
}

fn add_child_at(
    parent: &str,
    pointer: String,
    child: &Value,
    depth: usize,
    analysis: &mut SchemaAnalysis,
) -> Result<()> {
    analysis
        .edges
        .entry(parent.to_owned())
        .or_default()
        .push(pointer.clone());
    analyze_schema(child, &pointer, depth + 1, analysis)
}

fn analyze_schema(
    value: &Value,
    pointer: &str,
    depth: usize,
    analysis: &mut SchemaAnalysis,
) -> Result<()> {
    if depth > MAX_SCHEMA_DEPTH {
        return Err(complexity_error("schema nesting exceeds 32"));
    }
    analysis.nodes += 1;
    if analysis.nodes > MAX_SCHEMA_NODES {
        return Err(complexity_error("schema node limit exceeded"));
    }
    analysis.edges.entry(pointer.to_owned()).or_default();
    if value.is_boolean() {
        return Ok(());
    }
    let schema = value
        .as_object()
        .ok_or_else(|| schema_error("schema nodes must be objects or booleans"))?;
    for keyword in schema.keys() {
        if FORBIDDEN_KEYWORDS.contains(&keyword.as_str()) {
            return Err(schema_error("forbidden schema keyword"));
        }
        if !ALLOWED_KEYWORDS.contains(&keyword.as_str()) {
            return Err(schema_error("unsupported schema keyword"));
        }
    }
    validate_keyword_shapes(schema)?;
    if let Some(reference) = schema.get("$ref") {
        let reference = reference
            .as_str()
            .filter(|value| valid_local_pointer(value))
            .ok_or_else(|| {
                schema_error("only canonical local JSON Pointer references are allowed")
            })?;
        analysis
            .edges
            .entry(pointer.to_owned())
            .or_default()
            .push(reference.to_owned());
    }
    if let Some(schema_uri) = schema.get("$schema")
        && schema_uri.as_str() != Some("https://json-schema.org/draft/2020-12/schema")
    {
        return Err(schema_error("unknown JSON Schema dialect"));
    }
    for keyword in MAP_OF_SCHEMAS {
        if let Some(children) = schema.get(*keyword) {
            let children = children
                .as_object()
                .ok_or_else(|| schema_error("schema map keyword must be an object"))?;
            if *keyword == "properties" {
                analysis.properties += children.len();
                if analysis.properties > MAX_SCHEMA_PROPERTIES {
                    return Err(complexity_error("schema property limit exceeded"));
                }
            }
            let container = child_pointer(pointer, keyword);
            for (name, child) in children {
                add_child_at(
                    pointer,
                    child_pointer(&container, name),
                    child,
                    depth,
                    analysis,
                )?;
            }
        }
    }
    for keyword in SINGLE_SCHEMAS {
        if let Some(child) = schema.get(*keyword) {
            add_child_at(
                pointer,
                child_pointer(pointer, keyword),
                child,
                depth,
                analysis,
            )?;
        }
    }
    for keyword in ARRAY_OF_SCHEMAS {
        if let Some(children) = schema.get(*keyword) {
            let children = children
                .as_array()
                .filter(|children| !children.is_empty())
                .ok_or_else(|| schema_error("schema alternatives must be a nonempty array"))?;
            analysis.alternatives += children.len();
            if analysis.alternatives > MAX_SCHEMA_ALTERNATIVES {
                return Err(complexity_error("schema alternative limit exceeded"));
            }
            let container = child_pointer(pointer, keyword);
            for (index, child) in children.iter().enumerate() {
                add_child_at(
                    pointer,
                    child_pointer(&container, &index.to_string()),
                    child,
                    depth,
                    analysis,
                )?;
            }
        }
    }
    Ok(())
}

fn visit_graph(
    node: &str,
    graph: &HashMap<String, Vec<String>>,
    active: &mut HashSet<String>,
    complete: &mut HashSet<String>,
) -> Result<()> {
    if complete.contains(node) {
        return Ok(());
    }
    if !active.insert(node.to_owned()) {
        return Err(complexity_error("cyclic local schema reference"));
    }
    for target in graph
        .get(node)
        .ok_or_else(|| schema_error("local reference target is not a schema node"))?
    {
        if !graph.contains_key(target) {
            return Err(schema_error("local reference target does not exist"));
        }
        visit_graph(target, graph, active, complete)?;
    }
    active.remove(node);
    complete.insert(node.to_owned());
    Ok(())
}

fn referenced_schema<'a>(root: &'a Value, reference: &str) -> Option<&'a Value> {
    reference
        .strip_prefix('#')
        .and_then(|pointer| root.pointer(pointer))
}

fn instance_matches_type(instance: &Value, expected: &str) -> bool {
    match expected {
        "null" => instance.is_null(),
        "boolean" => instance.is_boolean(),
        "number" => instance.is_number(),
        "integer" => {
            instance.as_i64().is_some()
                || instance.as_u64().is_some()
                || instance
                    .as_f64()
                    .is_some_and(|value| value.is_finite() && value.fract() == 0.0)
        }
        "string" => instance.is_string(),
        "array" => instance.is_array(),
        "object" => instance.is_object(),
        _ => false,
    }
}

fn matches_declared_type(instance: &Value, expected: &Value) -> bool {
    expected
        .as_str()
        .is_some_and(|value| instance_matches_type(instance, value))
        || expected.as_array().is_some_and(|values| {
            values.iter().any(|value| {
                value
                    .as_str()
                    .is_some_and(|kind| instance_matches_type(instance, kind))
            })
        })
}

fn numeric_keyword(schema: &Map<String, Value>, key: &str) -> Option<f64> {
    schema.get(key).and_then(Value::as_f64)
}

fn integer_keyword(schema: &Map<String, Value>, key: &str) -> Option<usize> {
    schema
        .get(key)
        .and_then(Value::as_u64)
        .and_then(|value| usize::try_from(value).ok())
}

fn validate_combinators(
    root: &Value,
    schema: &Map<String, Value>,
    instance: &Value,
    depth: usize,
) -> bool {
    if let Some(values) = schema.get("allOf").and_then(Value::as_array)
        && !values
            .iter()
            .all(|value| validate_instance(root, value, instance, depth + 1))
    {
        return false;
    }
    if let Some(values) = schema.get("anyOf").and_then(Value::as_array)
        && !values
            .iter()
            .any(|value| validate_instance(root, value, instance, depth + 1))
    {
        return false;
    }
    if let Some(values) = schema.get("oneOf").and_then(Value::as_array)
        && values
            .iter()
            .filter(|value| validate_instance(root, value, instance, depth + 1))
            .count()
            != 1
    {
        return false;
    }
    !schema
        .get("not")
        .is_some_and(|value| validate_instance(root, value, instance, depth + 1))
}

fn validate_scalar_bounds(schema: &Map<String, Value>, instance: &Value) -> bool {
    if let Some(value) = instance.as_str() {
        let length = value.chars().count();
        if integer_keyword(schema, "minLength").is_some_and(|minimum| length < minimum)
            || integer_keyword(schema, "maxLength").is_some_and(|maximum| length > maximum)
        {
            return false;
        }
    }
    if let Some(value) = instance.as_f64()
        && (numeric_keyword(schema, "minimum").is_some_and(|minimum| value < minimum)
            || numeric_keyword(schema, "maximum").is_some_and(|maximum| value > maximum)
            || numeric_keyword(schema, "exclusiveMinimum").is_some_and(|minimum| value <= minimum)
            || numeric_keyword(schema, "exclusiveMaximum").is_some_and(|maximum| value >= maximum))
    {
        return false;
    }
    true
}

fn validate_array(
    root: &Value,
    schema: &Map<String, Value>,
    values: &[Value],
    depth: usize,
) -> bool {
    if integer_keyword(schema, "minItems").is_some_and(|minimum| values.len() < minimum)
        || integer_keyword(schema, "maxItems").is_some_and(|maximum| values.len() > maximum)
    {
        return false;
    }
    schema.get("items").is_none_or(|items| {
        values
            .iter()
            .all(|value| validate_instance(root, items, value, depth + 1))
    })
}

fn validate_object(
    root: &Value,
    schema: &Map<String, Value>,
    value: &Map<String, Value>,
    depth: usize,
) -> bool {
    if integer_keyword(schema, "minProperties").is_some_and(|minimum| value.len() < minimum)
        || integer_keyword(schema, "maxProperties").is_some_and(|maximum| value.len() > maximum)
    {
        return false;
    }
    if let Some(required) = schema.get("required").and_then(Value::as_array)
        && !required
            .iter()
            .all(|key| key.as_str().is_some_and(|key| value.contains_key(key)))
    {
        return false;
    }
    let properties = schema.get("properties").and_then(Value::as_object);
    value.iter().all(|(key, child)| {
        if let Some(child_schema) = properties.and_then(|properties| properties.get(key)) {
            validate_instance(root, child_schema, child, depth + 1)
        } else if schema.get("additionalProperties") == Some(&Value::Bool(false)) {
            false
        } else {
            schema
                .get("additionalProperties")
                .filter(|item| item.is_object())
                .is_none_or(|additional| validate_instance(root, additional, child, depth + 1))
        }
    })
}

fn validate_instance(root: &Value, schema: &Value, instance: &Value, depth: usize) -> bool {
    if depth > MAX_SCHEMA_DEPTH {
        return false;
    }
    if let Some(accepted) = schema.as_bool() {
        return accepted;
    }
    let Some(schema) = schema.as_object() else {
        return false;
    };
    if let Some(reference) = schema.get("$ref").and_then(Value::as_str) {
        let Some(target) = referenced_schema(root, reference) else {
            return false;
        };
        if !validate_instance(root, target, instance, depth + 1) {
            return false;
        }
    }
    if schema
        .get("type")
        .is_some_and(|expected| !matches_declared_type(instance, expected))
        || schema.get("const").is_some_and(|value| value != instance)
        || schema
            .get("enum")
            .and_then(Value::as_array)
            .is_some_and(|values| !values.contains(instance))
        || !validate_combinators(root, schema, instance, depth)
        || !validate_scalar_bounds(schema, instance)
    {
        return false;
    }
    if let Some(values) = instance.as_array()
        && !validate_array(root, schema, values, depth)
    {
        return false;
    }
    if let Some(value) = instance.as_object()
        && !validate_object(root, schema, value, depth)
    {
        return false;
    }
    true
}

pub(crate) fn validate_state_schema(schema: &Value, template: &Value) -> Result<()> {
    if !schema.is_object() {
        return Err(schema_error("state schema root must be an object"));
    }
    if canonical_json_bytes(schema)?.len() > MAX_SCHEMA_BYTES {
        return Err(complexity_error("canonical schema exceeds 64 KiB"));
    }
    let mut analysis = SchemaAnalysis::default();
    analyze_schema(schema, "#", 0, &mut analysis)?;
    visit_graph(
        "#",
        &analysis.edges,
        &mut HashSet::new(),
        &mut HashSet::new(),
    )?;
    #[cfg(feature = "full-schema")]
    {
        if !jsonschema::draft202012::meta::is_valid(schema) {
            return Err(schema_error("schema fails the Draft 2020-12 meta-schema"));
        }
        let validator = jsonschema::draft202012::new(schema)
            .map_err(|_| schema_error("schema compilation failed"))?;
        if !validator.is_valid(template) {
            return Err(CoreError::new(
                ErrorCode::ManifestTemplateInvalid,
                "public template violates state schema",
            ));
        }
    }
    if !validate_instance(schema, schema, template, 0) {
        return Err(CoreError::new(
            ErrorCode::ManifestTemplateInvalid,
            "public template violates state schema",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn accepts_local_pointer_and_rejects_cycles_and_remote_refs() {
        let valid = json!({
            "$schema": "https://json-schema.org/draft/2020-12/schema",
            "$defs": {"name/value": {"type": "string", "maxLength": 8}},
            "type": "object",
            "properties": {"name": {"$ref": "#/$defs/name~1value"}},
            "required": ["name"],
            "additionalProperties": false
        });
        assert!(validate_state_schema(&valid, &json!({"name": "Ada"})).is_ok());

        let remote = json!({"$ref": "https://example.invalid/schema"});
        assert_eq!(
            validate_state_schema(&remote, &json!({}))
                .expect_err("remote references fail")
                .code(),
            ErrorCode::ManifestSchemaInvalid
        );

        let cyclic = json!({"$defs": {"loop": {"$ref": "#/$defs/loop"}}, "$ref": "#/$defs/loop"});
        assert_eq!(
            validate_state_schema(&cyclic, &json!({}))
                .expect_err("cycles fail")
                .code(),
            ErrorCode::ManifestSchemaComplexity
        );
    }

    #[test]
    fn deterministic_subset_validates_composites_and_bounds() {
        let schema = json!({
            "type": "object",
            "properties": {
                "count": {"type": "integer", "minimum": 0, "maximum": 10},
                "label": {"anyOf": [{"const": "open"}, {"const": "closed"}]}
            },
            "required": ["count", "label"],
            "additionalProperties": false
        });
        assert!(validate_state_schema(&schema, &json!({"count": 4, "label": "open"})).is_ok());
        assert_eq!(
            validate_state_schema(&schema, &json!({"count": 11, "label": "open"}))
                .expect_err("invalid instance fails")
                .code(),
            ErrorCode::ManifestTemplateInvalid
        );
    }
}
