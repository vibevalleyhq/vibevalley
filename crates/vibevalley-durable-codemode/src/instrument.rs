use oxc_allocator::{Allocator, Vec as AstVec};
use oxc_ast::ast::*;
use oxc_ast_visit::{Visit, walk};
use oxc_parser::Parser;
use oxc_span::{GetSpan, SourceType};
use std::collections::BTreeMap;

pub struct Guards {
    pub tick: String,
    pub string: String,
}
impl Guards {
    pub fn new(source: &str, seed: u64) -> Self {
        let mut key = source
            .bytes()
            .fold(0xcbf29ce484222325u64, |h, b| (h ^ u64::from(b)).wrapping_mul(0x100000001b3))
            ^ seed;
        loop {
            let base = format!("__vv_meter_{key:x}");
            if !source.contains(&base) {
                return Self {
                    tick: format!("{base}t"),
                    string: format!("{base}s"),
                };
            }
            key = key.wrapping_add(1);
        }
    }
}

struct Instrument<'a> {
    guards: &'a Guards,
    edits: BTreeMap<u32, Vec<String>>,
    vars: usize,
}
impl Instrument<'_> {
    fn add(&mut self, pos: u32, content: impl Into<String>) {
        self.edits.entry(pos).or_default().push(content.into());
    }
    fn tick(&mut self, pos: u32) {
        self.add(pos, format!(";{}();", self.guards.tick));
    }
    fn loop_start(&mut self, body: &Statement<'_>) -> Option<u32> {
        match body {
            Statement::BlockStatement(b) => {
                if !b.body.iter().any(metered) {
                    self.tick(b.span.end - 1);
                }
                None
            }
            stmt => {
                let span = stmt.span();
                self.add(span.start, format!("{{{}();", self.guards.tick));
                Some(span.end)
            }
        }
    }
}
fn metered(stmt: &Statement<'_>) -> bool {
    !matches!(stmt, Statement::FunctionDeclaration(_) | Statement::EmptyStatement(_))
}
impl<'a> Visit<'a> for Instrument<'_> {
    fn visit_statements(&mut self, stmts: &AstVec<'a, Statement<'a>>) {
        for stmt in stmts {
            if metered(stmt) {
                self.tick(stmt.span().start);
            }
            self.visit_statement(stmt);
        }
    }
    fn visit_statement(&mut self, stmt: &Statement<'a>) {
        let end = match stmt {
            Statement::WhileStatement(s) => self.loop_start(&s.body),
            Statement::DoWhileStatement(s) => self.loop_start(&s.body),
            Statement::ForStatement(s) => self.loop_start(&s.body),
            Statement::ForInStatement(s) => self.loop_start(&s.body),
            Statement::ForOfStatement(s) => self.loop_start(&s.body),
            _ => None,
        };
        walk::walk_statement(self, stmt);
        if let Some(end) = end {
            self.add(end, "}");
        }
    }
    fn visit_function_body(&mut self, body: &FunctionBody<'a>) {
        if !body.statements.iter().any(metered) {
            self.tick(body.span.end - 1);
        }
        walk::walk_function_body(self, body);
    }
    fn visit_arrow_function_expression(&mut self, arrow: &ArrowFunctionExpression<'a>) {
        let expr = !matches!(arrow.body, ArrowFunctionBody::FunctionBody(_));
        let span = arrow.body.span();
        if expr {
            self.add(span.start, format!("({}(),", self.guards.tick));
        }
        walk::walk_arrow_function_expression(self, arrow);
        if expr {
            self.add(span.end, ")");
        }
    }
    fn visit_binding_identifier(&mut self, _: &BindingIdentifier<'a>) {
        self.vars += 1;
    }
    fn visit_expression(&mut self, expr: &Expression<'a>) {
        let string = matches!(expr, Expression::TemplateLiteral(_))
            || matches!(expr,Expression::AssignmentExpression(e) if e.operator==AssignmentOperator::Addition)
            || matches!(expr,Expression::BinaryExpression(e) if e.operator==BinaryOperator::Addition);
        let span = expr.span();
        if string {
            self.add(span.start, format!("{}(", self.guards.string));
        }
        walk::walk_expression(self, expr);
        if string {
            self.add(span.end, ")");
        }
    }
}

pub fn compile(source: &str, guards: &Guards, max_vars: usize) -> Result<String, String> {
    let allocator = Allocator::default();
    let wrapped;
    let result = Parser::new(&allocator, source, SourceType::script()).parse();
    let (source, ast) = if result.diagnostics.is_empty() {
        (source, result.program)
    } else {
        wrapped = format!("(function(){{\n{source}\n}})()");
        let body = Parser::new(&allocator, &wrapped, SourceType::script()).parse();
        if !body.diagnostics.is_empty() {
            return Err(format!("script syntax: {}", body.diagnostics[0]));
        }
        (wrapped.as_str(), body.program)
    };
    let mut visitor = Instrument {
        guards,
        edits: BTreeMap::new(),
        vars: 0,
    };
    visitor.visit_program(&ast);
    if visitor.vars > max_vars {
        return Err(format!("script quota exceeded: variable limit {max_vars} exceeded ({} declared)", visitor.vars));
    }
    let mut out = String::with_capacity(source.len());
    let mut last = 0;
    for (at, insertions) in visitor.edits {
        let at = at as usize;
        out.push_str(&source[last..at]);
        for insert in insertions {
            out.push_str(&insert);
        }
        last = at;
    }
    out.push_str(&source[last..]);
    Ok(out)
}
