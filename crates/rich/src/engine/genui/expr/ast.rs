use std::collections::BTreeSet;

use crate::engine::genui::error::GenUiError;
use crate::engine::genui::value::StateValue;

use super::parser::{parse_expr, parse_expr_with_limits, parse_template, parse_template_with_limits};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EvalLimits {
    pub max_steps: usize,
    pub max_depth: usize,
    pub max_collection_len: usize,
    pub max_string_len: usize,
}

impl Default for EvalLimits {
    fn default() -> Self {
        Self {
            max_steps: 10_000,
            max_depth: 64,
            max_collection_len: 4_096,
            max_string_len: 65_536,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UnaryOp {
    Neg,
    Not,
    Pos,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BinaryOp {
    Add,
    Sub,
    Mul,
    Div,
    Mod,
    Pow,
    Eq,
    Ne,
    Lt,
    Le,
    Gt,
    Ge,
    And,
    Or,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BuiltinFn {
    Min,
    Max,
    Clamp,
    Abs,
    Round,
    Floor,
    Ceil,
    Pow,
    Sqrt,
    Ln,
    Log10,
    Sum,
    Avg,
    Len,
    Range,
    Format,
    Contains,
    Lower,
    Upper,
    Trim,
    Concat,
    Coalesce,
    Str,
    Num,
    If,
}

impl BuiltinFn {
    pub(super) fn from_name(name: &str) -> Option<Self> {
        match name {
            "min" => Some(Self::Min),
            "max" => Some(Self::Max),
            "clamp" => Some(Self::Clamp),
            "abs" => Some(Self::Abs),
            "round" => Some(Self::Round),
            "floor" => Some(Self::Floor),
            "ceil" => Some(Self::Ceil),
            "pow" => Some(Self::Pow),
            "sqrt" => Some(Self::Sqrt),
            "ln" => Some(Self::Ln),
            "log10" => Some(Self::Log10),
            "sum" => Some(Self::Sum),
            "avg" => Some(Self::Avg),
            "len" => Some(Self::Len),
            "range" => Some(Self::Range),
            "format" => Some(Self::Format),
            "contains" => Some(Self::Contains),
            "lower" => Some(Self::Lower),
            "upper" => Some(Self::Upper),
            "trim" => Some(Self::Trim),
            "concat" => Some(Self::Concat),
            "coalesce" => Some(Self::Coalesce),
            "str" => Some(Self::Str),
            "num" => Some(Self::Num),
            "if" => Some(Self::If),
            _ => None,
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Self::Min => "min",
            Self::Max => "max",
            Self::Clamp => "clamp",
            Self::Abs => "abs",
            Self::Round => "round",
            Self::Floor => "floor",
            Self::Ceil => "ceil",
            Self::Pow => "pow",
            Self::Sqrt => "sqrt",
            Self::Ln => "ln",
            Self::Log10 => "log10",
            Self::Sum => "sum",
            Self::Avg => "avg",
            Self::Len => "len",
            Self::Range => "range",
            Self::Format => "format",
            Self::Contains => "contains",
            Self::Lower => "lower",
            Self::Upper => "upper",
            Self::Trim => "trim",
            Self::Concat => "concat",
            Self::Coalesce => "coalesce",
            Self::Str => "str",
            Self::Num => "num",
            Self::If => "if",
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum TemplatePart {
    Literal(String),
    Expr(Expr),
}

#[derive(Debug, Clone, PartialEq)]
pub struct Template {
    pub parts: Vec<TemplatePart>,
}

impl Template {
    pub fn parse(source: &str) -> Result<Self, GenUiError> {
        parse_template(source)
    }

    pub fn parse_with_limits(source: &str, limits: EvalLimits) -> Result<Self, GenUiError> {
        parse_template_with_limits(source, limits)
    }

    pub fn is_static(&self) -> bool {
        self.parts.iter().all(|part| match part {
            TemplatePart::Literal(_) => true,
            TemplatePart::Expr(_) => false,
        })
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum Expr {
    Literal(StateValue),
    Var(String),
    Template(Vec<TemplatePart>),
    List(Vec<Expr>),
    Record(Vec<(String, Expr)>),
    Unary {
        op: UnaryOp,
        operand: Box<Expr>,
    },
    Binary {
        op: BinaryOp,
        left: Box<Expr>,
        right: Box<Expr>,
    },
    Ternary {
        cond: Box<Expr>,
        then_branch: Box<Expr>,
        else_branch: Box<Expr>,
    },
    Field {
        target: Box<Expr>,
        name: String,
    },
    Index {
        target: Box<Expr>,
        index: Box<Expr>,
    },
    Call {
        func: BuiltinFn,
        args: Vec<Expr>,
    },
    Map {
        list: Box<Expr>,
        param: String,
        index_param: Option<String>,
        body: Box<Expr>,
    },
    Filter {
        list: Box<Expr>,
        param: String,
        index_param: Option<String>,
        predicate: Box<Expr>,
    },
    SortBy {
        list: Box<Expr>,
        param: String,
        index_param: Option<String>,
        key_expr: Box<Expr>,
        descending: bool,
    },
    Any {
        list: Box<Expr>,
        param: String,
        index_param: Option<String>,
        predicate: Box<Expr>,
    },
    All {
        list: Box<Expr>,
        param: String,
        index_param: Option<String>,
        predicate: Box<Expr>,
    },
}

impl Expr {
    pub fn parse(source: &str) -> Result<Self, GenUiError> {
        parse_expr(source)
    }

    pub fn parse_with_limits(source: &str, limits: EvalLimits) -> Result<Self, GenUiError> {
        parse_expr_with_limits(source, limits)
    }
}

pub fn referenced_keys(expr: &Expr) -> BTreeSet<String> {
    let mut keys = BTreeSet::new();
    let mut bound = Vec::new();
    collect_expr_keys(expr, &mut bound, &mut keys);
    keys
}

pub fn template_referenced_keys(template: &Template) -> BTreeSet<String> {
    let mut keys = BTreeSet::new();
    let mut bound = Vec::new();
    for part in &template.parts {
        match part {
            TemplatePart::Literal(_) => {}
            TemplatePart::Expr(expr) => collect_expr_keys(expr, &mut bound, &mut keys),
        }
    }
    keys
}

fn collect_expr_keys<'a>(expr: &'a Expr, bound: &mut Vec<&'a str>, keys: &mut BTreeSet<String>) {
    match expr {
        Expr::Literal(_) => {}
        Expr::Var(name) => {
            if !bound.contains(&name.as_str()) {
                keys.insert(name.clone());
            }
        }
        Expr::Template(parts) => {
            for part in parts {
                match part {
                    TemplatePart::Literal(_) => {}
                    TemplatePart::Expr(inner) => collect_expr_keys(inner, bound, keys),
                }
            }
        }
        Expr::List(items) => {
            for item in items {
                collect_expr_keys(item, bound, keys);
            }
        }
        Expr::Record(entries) => {
            for (_, value) in entries {
                collect_expr_keys(value, bound, keys);
            }
        }
        Expr::Unary { operand, .. } => collect_expr_keys(operand, bound, keys),
        Expr::Binary { left, right, .. } => {
            collect_expr_keys(left, bound, keys);
            collect_expr_keys(right, bound, keys);
        }
        Expr::Ternary {
            cond,
            then_branch,
            else_branch,
        } => {
            collect_expr_keys(cond, bound, keys);
            collect_expr_keys(then_branch, bound, keys);
            collect_expr_keys(else_branch, bound, keys);
        }
        Expr::Field { target, .. } => collect_expr_keys(target, bound, keys),
        Expr::Index { target, index } => {
            collect_expr_keys(target, bound, keys);
            collect_expr_keys(index, bound, keys);
        }
        Expr::Call { args, .. } => {
            for arg in args {
                collect_expr_keys(arg, bound, keys);
            }
        }
        Expr::Map {
            list,
            param,
            index_param,
            body,
        }
        | Expr::Filter {
            list,
            param,
            index_param,
            predicate: body,
        }
        | Expr::SortBy {
            list,
            param,
            index_param,
            key_expr: body,
            ..
        }
        | Expr::Any {
            list,
            param,
            index_param,
            predicate: body,
        }
        | Expr::All {
            list,
            param,
            index_param,
            predicate: body,
        } => {
            collect_expr_keys(list, bound, keys);
            let saved = bound.len();
            bound.push(param.as_str());
            if let Some(idx) = index_param {
                bound.push(idx.as_str());
            }
            collect_expr_keys(body, bound, keys);
            bound.truncate(saved);
        }
    }
}
