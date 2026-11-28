use std::cmp::Ordering;

use crate::engine::genui::error::GenUiError;
use crate::engine::genui::value::{StateStore, StateValue, normalize_zero};

use super::ast::{BinaryOp, EvalLimits, Expr, Template, TemplatePart, UnaryOp};

pub fn eval_expr(expr: &Expr, state: &StateStore, limits: EvalLimits) -> Result<StateValue, GenUiError> {
    let mut ctx = EvalCtx {
        state,
        limits,
        steps: 0,
        depth: 0,
        locals: Vec::new(),
    };
    ctx.eval(expr)
}

pub fn eval_template(template: &Template, state: &StateStore, limits: EvalLimits) -> Result<String, GenUiError> {
    let mut ctx = EvalCtx {
        state,
        limits,
        steps: 0,
        depth: 0,
        locals: Vec::new(),
    };
    ctx.eval_template_parts(&template.parts)
}

pub(super) struct EvalCtx<'a> {
    pub(super) state: &'a StateStore,
    pub(super) limits: EvalLimits,
    pub(super) steps: usize,
    pub(super) depth: usize,
    pub(super) locals: Vec<(String, StateValue)>,
}

impl<'a> EvalCtx<'a> {
    pub(super) fn step(&mut self) -> Result<(), GenUiError> {
        self.steps += 1;
        if self.steps > self.limits.max_steps {
            return Err(GenUiError::StepLimitExceeded { limit: self.limits.max_steps });
        }
        Ok(())
    }

    fn enter_depth(&mut self) -> Result<(), GenUiError> {
        self.depth += 1;
        if self.depth > self.limits.max_depth {
            return Err(GenUiError::DepthLimitExceeded { limit: self.limits.max_depth });
        }
        Ok(())
    }

    fn leave_depth(&mut self) {
        self.depth = self.depth.saturating_sub(1);
    }

    fn lookup(&self, name: &str) -> Result<StateValue, GenUiError> {
        for (local_name, val) in self.locals.iter().rev() {
            if local_name == name {
                return Ok(val.clone());
            }
        }
        self.state
            .get(name)
            .cloned()
            .ok_or_else(|| GenUiError::UndefinedVariable { name: name.to_owned() })
    }

    fn eval_template_parts(&mut self, parts: &[TemplatePart]) -> Result<String, GenUiError> {
        let mut out = String::new();
        for part in parts {
            self.step()?;
            match part {
                TemplatePart::Literal(lit) => {
                    if out.len().saturating_add(lit.len()) > self.limits.max_string_len {
                        return Err(GenUiError::StringLimitExceeded {
                            limit: self.limits.max_string_len,
                        });
                    }
                    out.push_str(lit);
                }
                TemplatePart::Expr(expr) => {
                    let val = self.eval(expr)?;
                    let piece = val.to_display_string();
                    if out.len().saturating_add(piece.len()) > self.limits.max_string_len {
                        return Err(GenUiError::StringLimitExceeded {
                            limit: self.limits.max_string_len,
                        });
                    }
                    out.push_str(&piece);
                }
            }
        }
        Ok(out)
    }

    pub(super) fn eval(&mut self, expr: &Expr) -> Result<StateValue, GenUiError> {
        self.step()?;
        self.enter_depth()?;
        let res = self.eval_inner(expr);
        self.leave_depth();
        res
    }

    fn eval_inner(&mut self, expr: &Expr) -> Result<StateValue, GenUiError> {
        match expr {
            Expr::Literal(val) => Ok(val.clone()),
            Expr::Var(name) => self.lookup(name),
            Expr::Template(parts) => Ok(StateValue::Text(self.eval_template_parts(parts)?)),
            Expr::List(items) => {
                if items.len() > self.limits.max_collection_len {
                    return Err(GenUiError::CollectionLimitExceeded {
                        limit: self.limits.max_collection_len,
                    });
                }
                let mut out = Vec::with_capacity(items.len());
                for item in items {
                    out.push(self.eval(item)?);
                }
                Ok(StateValue::List(out))
            }
            Expr::Record(entries) => {
                if entries.len() > self.limits.max_collection_len {
                    return Err(GenUiError::CollectionLimitExceeded {
                        limit: self.limits.max_collection_len,
                    });
                }
                let mut out = Vec::with_capacity(entries.len());
                for (k, v) in entries {
                    out.push((k.clone(), self.eval(v)?));
                }
                Ok(StateValue::Record(out))
            }
            Expr::Unary { op, operand } => {
                let val = self.eval(operand)?;
                match op {
                    UnaryOp::Not => Ok(StateValue::Bool(!val.is_truthy())),
                    UnaryOp::Neg => {
                        let n = expect_number(&val, "unary `-`")?;
                        StateValue::number(-n)
                    }
                    UnaryOp::Pos => {
                        let n = expect_number(&val, "unary `+`")?;
                        StateValue::number(n)
                    }
                }
            }
            Expr::Binary { op, left, right } => self.eval_binary(*op, left, right),
            Expr::Ternary {
                cond,
                then_branch,
                else_branch,
            } => {
                let cond_val = self.eval(cond)?;
                if cond_val.is_truthy() {
                    self.eval(then_branch)
                } else {
                    self.eval(else_branch)
                }
            }
            Expr::Field { target, name } => {
                let val = self.eval(target)?;
                match val {
                    StateValue::Record(_) => Ok(val.get_field(name).cloned().unwrap_or(StateValue::Null)),
                    StateValue::Null => Ok(StateValue::Null),
                    StateValue::Bool(_) | StateValue::Number(_) | StateValue::Text(_) | StateValue::List(_) => Err(GenUiError::TypeMismatch {
                        context: format!("field access `.{name}`"),
                        expected: "record".to_owned(),
                        actual: val.type_name().to_owned(),
                    }),
                }
            }
            Expr::Index { target, index } => {
                let container = self.eval(target)?;
                let idx = self.eval(index)?;
                match container {
                    StateValue::List(items) => {
                        let n = expect_number(&idx, "list index")?;
                        if n < 0.0 || n.fract() != 0.0 {
                            return Err(GenUiError::TypeMismatch {
                                context: "list index".to_owned(),
                                expected: "non-negative integer".to_owned(),
                                actual: format!("{n}"),
                            });
                        }
                        Ok(items.get(n as usize).cloned().unwrap_or(StateValue::Null))
                    }
                    StateValue::Record(_) => {
                        let key = expect_text(&idx, "record index")?;
                        Ok(container.get_field(key).cloned().unwrap_or(StateValue::Null))
                    }
                    StateValue::Null => Ok(StateValue::Null),
                    StateValue::Bool(_) | StateValue::Number(_) | StateValue::Text(_) => Err(GenUiError::TypeMismatch {
                        context: "index access".to_owned(),
                        expected: "list or record".to_owned(),
                        actual: container.type_name().to_owned(),
                    }),
                }
            }
            Expr::Call { func, args } => self.eval_builtin(*func, args),
            Expr::Map {
                list,
                param,
                index_param,
                body,
            } => {
                let items = self.eval_list(list, "map")?;
                if items.len() > self.limits.max_collection_len {
                    return Err(GenUiError::CollectionLimitExceeded {
                        limit: self.limits.max_collection_len,
                    });
                }
                let mut out = Vec::with_capacity(items.len());
                for (i, item) in items.into_iter().enumerate() {
                    self.step()?;
                    let mapped = self.with_item_binding(param, index_param.as_deref(), item, i, |ctx| ctx.eval(body))?;
                    out.push(mapped);
                }
                Ok(StateValue::List(out))
            }
            Expr::Filter {
                list,
                param,
                index_param,
                predicate,
            } => {
                let items = self.eval_list(list, "filter")?;
                let mut out = Vec::new();
                for (i, item) in items.into_iter().enumerate() {
                    self.step()?;
                    let keep = self.with_item_binding(param, index_param.as_deref(), item.clone(), i, |ctx| ctx.eval(predicate))?;
                    if keep.is_truthy() {
                        out.push(item);
                    }
                }
                Ok(StateValue::List(out))
            }
            Expr::SortBy {
                list,
                param,
                index_param,
                key_expr,
                descending,
            } => {
                let items = self.eval_list(list, "sort_by")?;
                let mut keyed = Vec::with_capacity(items.len());
                for (i, item) in items.into_iter().enumerate() {
                    self.step()?;
                    let key = self.with_item_binding(param, index_param.as_deref(), item.clone(), i, |ctx| ctx.eval(key_expr))?;
                    keyed.push((key, item));
                }
                keyed.sort_by(|(ka, _), (kb, _)| {
                    let ord = compare_sort_keys(ka, kb);
                    if *descending { ord.reverse() } else { ord }
                });
                Ok(StateValue::List(keyed.into_iter().map(|(_, v)| v).collect()))
            }
            Expr::Any {
                list,
                param,
                index_param,
                predicate,
            } => {
                let items = self.eval_list(list, "any")?;
                for (i, item) in items.into_iter().enumerate() {
                    self.step()?;
                    let matched = self.with_item_binding(param, index_param.as_deref(), item, i, |ctx| ctx.eval(predicate))?;
                    if matched.is_truthy() {
                        return Ok(StateValue::Bool(true));
                    }
                }
                Ok(StateValue::Bool(false))
            }
            Expr::All {
                list,
                param,
                index_param,
                predicate,
            } => {
                let items = self.eval_list(list, "all")?;
                for (i, item) in items.into_iter().enumerate() {
                    self.step()?;
                    let matched = self.with_item_binding(param, index_param.as_deref(), item, i, |ctx| ctx.eval(predicate))?;
                    if !matched.is_truthy() {
                        return Ok(StateValue::Bool(false));
                    }
                }
                Ok(StateValue::Bool(true))
            }
        }
    }

    fn with_item_binding<T>(
        &mut self,
        param: &str,
        index_param: Option<&str>,
        item: StateValue,
        idx: usize,
        f: impl FnOnce(&mut Self) -> Result<T, GenUiError>,
    ) -> Result<T, GenUiError> {
        let saved = self.locals.len();
        self.locals.push((param.to_owned(), item));
        if let Some(idx_name) = index_param {
            self.locals.push((idx_name.to_owned(), StateValue::Number(idx as f64)));
        }
        let result = f(self);
        self.locals.truncate(saved);
        result
    }

    fn eval_list(&mut self, expr: &Expr, context: &str) -> Result<Vec<StateValue>, GenUiError> {
        let val = self.eval(expr)?;
        match val {
            StateValue::List(items) => Ok(items),
            StateValue::Null | StateValue::Bool(_) | StateValue::Number(_) | StateValue::Text(_) | StateValue::Record(_) => Err(GenUiError::TypeMismatch {
                context: context.to_owned(),
                expected: "list".to_owned(),
                actual: val.type_name().to_owned(),
            }),
        }
    }

    fn eval_binary(&mut self, op: BinaryOp, left_expr: &Expr, right_expr: &Expr) -> Result<StateValue, GenUiError> {
        match op {
            BinaryOp::And => {
                let left = self.eval(left_expr)?;
                if !left.is_truthy() {
                    return Ok(StateValue::Bool(false));
                }
                let right = self.eval(right_expr)?;
                return Ok(StateValue::Bool(right.is_truthy()));
            }
            BinaryOp::Or => {
                let left = self.eval(left_expr)?;
                if left.is_truthy() {
                    return Ok(StateValue::Bool(true));
                }
                let right = self.eval(right_expr)?;
                return Ok(StateValue::Bool(right.is_truthy()));
            }
            BinaryOp::Add
            | BinaryOp::Sub
            | BinaryOp::Mul
            | BinaryOp::Div
            | BinaryOp::Mod
            | BinaryOp::Pow
            | BinaryOp::Eq
            | BinaryOp::Ne
            | BinaryOp::Lt
            | BinaryOp::Le
            | BinaryOp::Gt
            | BinaryOp::Ge => {}
        }

        let left = self.eval(left_expr)?;
        let right = self.eval(right_expr)?;

        match op {
            BinaryOp::Add => match (&left, &right) {
                (StateValue::Number(a), StateValue::Number(b)) => checked_finite(a + b, "`+`"),
                (
                    StateValue::Text(_),
                    StateValue::Null | StateValue::Bool(_) | StateValue::Number(_) | StateValue::Text(_) | StateValue::List(_) | StateValue::Record(_),
                )
                | (StateValue::Null | StateValue::Bool(_) | StateValue::Number(_) | StateValue::List(_) | StateValue::Record(_), StateValue::Text(_)) => {
                    let a = left.to_display_string();
                    let b = right.to_display_string();
                    if a.len().saturating_add(b.len()) > self.limits.max_string_len {
                        return Err(GenUiError::StringLimitExceeded {
                            limit: self.limits.max_string_len,
                        });
                    }
                    Ok(StateValue::Text(format!("{a}{b}")))
                }
                (
                    StateValue::Null | StateValue::Bool(_) | StateValue::Number(_) | StateValue::List(_) | StateValue::Record(_),
                    StateValue::Null | StateValue::Bool(_) | StateValue::Number(_) | StateValue::List(_) | StateValue::Record(_),
                ) => Err(GenUiError::TypeMismatch {
                    context: "`+`".to_owned(),
                    expected: "number or text".to_owned(),
                    actual: format!("{} and {}", left.type_name(), right.type_name()),
                }),
            },
            BinaryOp::Sub => {
                let a = expect_number(&left, "`-`")?;
                let b = expect_number(&right, "`-`")?;
                checked_finite(a - b, "`-`")
            }
            BinaryOp::Mul => {
                let a = expect_number(&left, "`*`")?;
                let b = expect_number(&right, "`*`")?;
                checked_finite(a * b, "`*`")
            }
            BinaryOp::Div => {
                let a = expect_number(&left, "`/`")?;
                let b = expect_number(&right, "`/`")?;
                if b == 0.0 {
                    return Err(GenUiError::DivisionByZero);
                }
                checked_finite(a / b, "`/`")
            }
            BinaryOp::Mod => {
                let a = expect_number(&left, "`%`")?;
                let b = expect_number(&right, "`%`")?;
                if b == 0.0 {
                    return Err(GenUiError::DivisionByZero);
                }
                checked_finite(a % b, "`%`")
            }
            BinaryOp::Pow => {
                let a = expect_number(&left, "`^`")?;
                let b = expect_number(&right, "`^`")?;
                checked_finite(a.powf(b), "`^`")
            }
            BinaryOp::Eq => Ok(StateValue::Bool(left.structural_eq(&right))),
            BinaryOp::Ne => Ok(StateValue::Bool(!left.structural_eq(&right))),
            BinaryOp::Lt => Ok(StateValue::Bool(compare_ordered(&left, &right, "`<`")? == Ordering::Less)),
            BinaryOp::Le => Ok(StateValue::Bool(compare_ordered(&left, &right, "`<=`")? != Ordering::Greater)),
            BinaryOp::Gt => Ok(StateValue::Bool(compare_ordered(&left, &right, "`>`")? == Ordering::Greater)),
            BinaryOp::Ge => Ok(StateValue::Bool(compare_ordered(&left, &right, "`>=`")? != Ordering::Less)),
            BinaryOp::And | BinaryOp::Or => unreachable!("short-circuited above"),
        }
    }
}

pub(super) fn expect_number(val: &StateValue, context: &str) -> Result<f64, GenUiError> {
    match val {
        StateValue::Number(n) => {
            if !n.is_finite() {
                return Err(GenUiError::NonFiniteResult { context: context.to_owned() });
            }
            Ok(*n)
        }
        StateValue::Null | StateValue::Bool(_) | StateValue::Text(_) | StateValue::List(_) | StateValue::Record(_) => Err(GenUiError::TypeMismatch {
            context: context.to_owned(),
            expected: "number".to_owned(),
            actual: val.type_name().to_owned(),
        }),
    }
}

pub(super) fn expect_text<'a>(val: &'a StateValue, context: &str) -> Result<&'a str, GenUiError> {
    match val {
        StateValue::Text(s) => Ok(s.as_str()),
        StateValue::Null | StateValue::Bool(_) | StateValue::Number(_) | StateValue::List(_) | StateValue::Record(_) => Err(GenUiError::TypeMismatch {
            context: context.to_owned(),
            expected: "text".to_owned(),
            actual: val.type_name().to_owned(),
        }),
    }
}

pub(super) fn checked_finite(value: f64, context: &str) -> Result<StateValue, GenUiError> {
    if !value.is_finite() {
        return Err(GenUiError::NonFiniteResult { context: context.to_owned() });
    }
    Ok(StateValue::Number(normalize_zero(value)))
}

fn compare_ordered(left: &StateValue, right: &StateValue, context: &str) -> Result<Ordering, GenUiError> {
    let mismatch = || GenUiError::TypeMismatch {
        context: context.to_owned(),
        expected: "matching comparable types (number, text, or bool)".to_owned(),
        actual: format!("{} and {}", left.type_name(), right.type_name()),
    };
    match left {
        StateValue::Number(a) => match right {
            StateValue::Number(b) => a.partial_cmp(b).ok_or_else(|| GenUiError::NonFiniteResult { context: context.to_owned() }),
            StateValue::Null | StateValue::Bool(_) | StateValue::Text(_) | StateValue::List(_) | StateValue::Record(_) => Err(mismatch()),
        },
        StateValue::Text(a) => match right {
            StateValue::Text(b) => Ok(a.cmp(b)),
            StateValue::Null | StateValue::Bool(_) | StateValue::Number(_) | StateValue::List(_) | StateValue::Record(_) => Err(mismatch()),
        },
        StateValue::Bool(a) => match right {
            StateValue::Bool(b) => Ok(a.cmp(b)),
            StateValue::Null | StateValue::Number(_) | StateValue::Text(_) | StateValue::List(_) | StateValue::Record(_) => Err(mismatch()),
        },
        StateValue::Null | StateValue::List(_) | StateValue::Record(_) => Err(mismatch()),
    }
}

fn compare_sort_keys(left: &StateValue, right: &StateValue) -> Ordering {
    let rank = |v: &StateValue| -> u8 {
        match v {
            StateValue::Null => 0,
            StateValue::Bool(_) => 1,
            StateValue::Number(_) => 2,
            StateValue::Text(_) => 3,
            StateValue::List(_) => 4,
            StateValue::Record(_) => 5,
        }
    };
    let ra = rank(left);
    let rb = rank(right);
    if ra != rb {
        return ra.cmp(&rb);
    }
    match left {
        StateValue::Null => Ordering::Equal,
        StateValue::Bool(a) => match right {
            StateValue::Bool(b) => a.cmp(b),
            StateValue::Null | StateValue::Number(_) | StateValue::Text(_) | StateValue::List(_) | StateValue::Record(_) => Ordering::Equal,
        },
        StateValue::Number(a) => match right {
            StateValue::Number(b) => a.total_cmp(b),
            StateValue::Null | StateValue::Bool(_) | StateValue::Text(_) | StateValue::List(_) | StateValue::Record(_) => Ordering::Equal,
        },
        StateValue::Text(a) => match right {
            StateValue::Text(b) => a.cmp(b),
            StateValue::Null | StateValue::Bool(_) | StateValue::Number(_) | StateValue::List(_) | StateValue::Record(_) => Ordering::Equal,
        },
        StateValue::List(a) => match right {
            StateValue::List(b) => a.len().cmp(&b.len()),
            StateValue::Null | StateValue::Bool(_) | StateValue::Number(_) | StateValue::Text(_) | StateValue::Record(_) => Ordering::Equal,
        },
        StateValue::Record(a) => match right {
            StateValue::Record(b) => a.len().cmp(&b.len()),
            StateValue::Null | StateValue::Bool(_) | StateValue::Number(_) | StateValue::Text(_) | StateValue::List(_) => Ordering::Equal,
        },
    }
}
