use crate::{CoreError, ErrorCode, Result};
use oxc_allocator::Allocator;
use oxc_ast::ast_kind::AstKind;
use oxc_ast_visit::Visit;
use oxc_parser::Parser;
use oxc_span::SourceType;

const MAX_MODULE_BYTES: usize = 768 * 1024;

#[derive(Default)]
struct ForbiddenSyntaxVisitor {
    has_forbidden_import: bool,
}

impl<'a> Visit<'a> for ForbiddenSyntaxVisitor {
    fn enter_node(&mut self, kind: AstKind<'a>) {
        match kind {
            AstKind::ImportDeclaration(_)
            | AstKind::ImportExpression(_)
            | AstKind::ExportAllDeclaration(_)
            | AstKind::ExportFromDeclaration(_) => {
                self.has_forbidden_import = true;
            }
            AstKind::IdentifierReference(identifier) if identifier.name == "importScripts" => {
                self.has_forbidden_import = true;
            }
            _ => {}
        }
    }
}

pub fn validate_module_source(source: &[u8]) -> Result<()> {
    if source.len() > MAX_MODULE_BYTES {
        return Err(CoreError::new(
            ErrorCode::AppModuleTooLarge,
            "module exceeds 768 KiB",
        ));
    }
    let source = std::str::from_utf8(source)
        .map_err(|_| CoreError::new(ErrorCode::AppModuleSyntaxInvalid, "module is not UTF-8"))?;
    if source.contains("sourceMappingURL=") || source.contains("sourceURL=") {
        return Err(CoreError::new(
            ErrorCode::AppModuleSourceMapForbidden,
            "source map and source URL directives are forbidden",
        ));
    }

    let allocator = Allocator::default();
    let parsed = Parser::new(&allocator, source, SourceType::mjs()).parse();
    if parsed.panicked || !parsed.diagnostics.is_empty() {
        return Err(CoreError::new(
            ErrorCode::AppModuleSyntaxInvalid,
            "JavaScript parser rejected module",
        ));
    }
    let mut visitor = ForbiddenSyntaxVisitor::default();
    visitor.visit_program(&parsed.program);
    if visitor.has_forbidden_import {
        return Err(CoreError::new(
            ErrorCode::AppModuleImportForbidden,
            "module contains an unresolved import or importScripts reference",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_self_contained_module() {
        assert!(
            validate_module_source(b"export default () => ({render(){ return {text:'ok'}; }});")
                .is_ok()
        );
    }

    #[test]
    fn rejects_every_import_shape() {
        for source in [
            "import value from './x.js'; export default value;",
            "export {value} from './x.js';",
            "export * from './x.js';",
            "const value = import('./x.js'); export default value;",
            "importScripts('./x.js'); export default 1;",
        ] {
            let error = validate_module_source(source.as_bytes()).expect_err("import must fail");
            assert_eq!(error.code(), ErrorCode::AppModuleImportForbidden);
        }
    }
}
