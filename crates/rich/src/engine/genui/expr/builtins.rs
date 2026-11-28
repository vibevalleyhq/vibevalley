use crate::engine::genui::error::GenUiError;
use crate::engine::genui::value::{FormatKind, StateValue, format_value, normalize_zero};

use super::ast::{BuiltinFn, Expr};
use super::eval::{EvalCtx, checked_finite, expect_number, expect_text};

impl EvalCtx<'_> {
    pub(super) fn eval_builtin(&mut self, func: BuiltinFn, args: &[Expr]) -> Result<StateValue, GenUiError> {
        let name = func.name();
        match func {
            BuiltinFn::If => {
                if args.len() != 3 {
                    return Err(GenUiError::ArityMismatch {
                        function: name.to_owned(),
                        expected: "3".to_owned(),
                        actual: args.len(),
                    });
                }
                let cond = self.eval(&args[0])?;
                if cond.is_truthy() { self.eval(&args[1]) } else { self.eval(&args[2]) }
            }
            BuiltinFn::Coalesce => {
                if args.is_empty() {
                    return Err(GenUiError::ArityMismatch {
                        function: name.to_owned(),
                        expected: ">= 1".to_owned(),
                        actual: 0,
                    });
                }
                for arg in args {
                    let val = self.eval(arg)?;
                    if !matches!(val, StateValue::Null) {
                        return Ok(val);
                    }
                }
                Ok(StateValue::Null)
            }
            BuiltinFn::Min => {
                let nums = self.eval_numeric_args(args, name)?;
                match nums.into_iter().reduce(f64::min) {
                    Some(v) => checked_finite(v, name),
                    None => Ok(StateValue::Null),
                }
            }
            BuiltinFn::Max => {
                let nums = self.eval_numeric_args(args, name)?;
                match nums.into_iter().reduce(f64::max) {
                    Some(v) => checked_finite(v, name),
                    None => Ok(StateValue::Null),
                }
            }
            BuiltinFn::Clamp => {
                let vals = self.eval_exact_args(args, 3, name)?;
                let x = expect_number(&vals[0], name)?;
                let lo = expect_number(&vals[1], name)?;
                let hi = expect_number(&vals[2], name)?;
                if lo > hi {
                    return Err(GenUiError::InvalidRange {
                        message: format!("clamp min ({lo}) exceeds max ({hi})"),
                    });
                }
                checked_finite(x.clamp(lo, hi), name)
            }
            BuiltinFn::Abs => {
                let vals = self.eval_exact_args(args, 1, name)?;
                checked_finite(expect_number(&vals[0], name)?.abs(), name)
            }
            BuiltinFn::Round => {
                if args.is_empty() || args.len() > 2 {
                    return Err(GenUiError::ArityMismatch {
                        function: name.to_owned(),
                        expected: "1..=2".to_owned(),
                        actual: args.len(),
                    });
                }
                let x = expect_number(&self.eval(&args[0])?, name)?;
                if args.len() == 1 {
                    return checked_finite(x.round(), name);
                }
                let decimals = expect_number(&self.eval(&args[1])?, name)?;
                if decimals < 0.0 || decimals > 12.0 || decimals.fract() != 0.0 {
                    return Err(GenUiError::InvalidRange {
                        message: format!("round precision must be an integer in 0..=12, got {decimals}"),
                    });
                }
                let factor = 10_f64.powi(decimals as i32);
                checked_finite((x * factor).round() / factor, name)
            }
            BuiltinFn::Floor => {
                let vals = self.eval_exact_args(args, 1, name)?;
                checked_finite(expect_number(&vals[0], name)?.floor(), name)
            }
            BuiltinFn::Ceil => {
                let vals = self.eval_exact_args(args, 1, name)?;
                checked_finite(expect_number(&vals[0], name)?.ceil(), name)
            }
            BuiltinFn::Pow => {
                let vals = self.eval_exact_args(args, 2, name)?;
                let base = expect_number(&vals[0], name)?;
                let exp = expect_number(&vals[1], name)?;
                checked_finite(base.powf(exp), name)
            }
            BuiltinFn::Sqrt => {
                let vals = self.eval_exact_args(args, 1, name)?;
                let x = expect_number(&vals[0], name)?;
                if x < 0.0 {
                    return Err(GenUiError::NonFiniteResult { context: name.to_owned() });
                }
                checked_finite(x.sqrt(), name)
            }
            BuiltinFn::Ln => {
                let vals = self.eval_exact_args(args, 1, name)?;
                let x = expect_number(&vals[0], name)?;
                if x <= 0.0 {
                    return Err(GenUiError::NonFiniteResult { context: name.to_owned() });
                }
                checked_finite(x.ln(), name)
            }
            BuiltinFn::Log10 => {
                let vals = self.eval_exact_args(args, 1, name)?;
                let x = expect_number(&vals[0], name)?;
                if x <= 0.0 {
                    return Err(GenUiError::NonFiniteResult { context: name.to_owned() });
                }
                checked_finite(x.log10(), name)
            }
            BuiltinFn::Sum => {
                let nums = self.eval_numeric_args(args, name)?;
                let total: f64 = nums.into_iter().sum();
                checked_finite(total, name)
            }
            BuiltinFn::Avg => {
                let nums = self.eval_numeric_args(args, name)?;
                if nums.is_empty() {
                    return Ok(StateValue::Number(0.0));
                }
                let count = nums.len() as f64;
                let total: f64 = nums.into_iter().sum();
                checked_finite(total / count, name)
            }
            BuiltinFn::Len => {
                let vals = self.eval_exact_args(args, 1, name)?;
                let length = match &vals[0] {
                    StateValue::List(items) => items.len(),
                    StateValue::Text(s) => s.chars().count(),
                    StateValue::Record(entries) => entries.len(),
                    StateValue::Null | StateValue::Bool(_) | StateValue::Number(_) => {
                        return Err(GenUiError::TypeMismatch {
                            context: name.to_owned(),
                            expected: "list, text, or record".to_owned(),
                            actual: vals[0].type_name().to_owned(),
                        });
                    }
                };
                Ok(StateValue::Number(length as f64))
            }
            BuiltinFn::Range => {
                if args.is_empty() || args.len() > 3 {
                    return Err(GenUiError::ArityMismatch {
                        function: name.to_owned(),
                        expected: "1..=3".to_owned(),
                        actual: args.len(),
                    });
                }
                let (start, end, step) = match args.len() {
                    1 => (0.0, expect_number(&self.eval(&args[0])?, name)?, 1.0),
                    2 => (expect_number(&self.eval(&args[0])?, name)?, expect_number(&self.eval(&args[1])?, name)?, 1.0),
                    _ => (
                        expect_number(&self.eval(&args[0])?, name)?,
                        expect_number(&self.eval(&args[1])?, name)?,
                        expect_number(&self.eval(&args[2])?, name)?,
                    ),
                };
                if !step.is_finite() || step == 0.0 {
                    return Err(GenUiError::InvalidRange {
                        message: "step must be a finite non-zero number".to_owned(),
                    });
                }
                let mut out = Vec::new();
                let mut idx: usize = 0;
                loop {
                    let cur = normalize_zero(start + (idx as f64) * step);
                    let in_bounds = if step > 0.0 { cur < end } else { cur > end };
                    if !in_bounds {
                        break;
                    }
                    if out.len() >= self.limits.max_collection_len {
                        return Err(GenUiError::CollectionLimitExceeded {
                            limit: self.limits.max_collection_len,
                        });
                    }
                    self.step()?;
                    out.push(StateValue::Number(cur));
                    idx += 1;
                }
                Ok(StateValue::List(out))
            }
            BuiltinFn::Format => {
                if args.len() < 2 || args.len() > 3 {
                    return Err(GenUiError::ArityMismatch {
                        function: name.to_owned(),
                        expected: "2..=3".to_owned(),
                        actual: args.len(),
                    });
                }
                let val = self.eval(&args[0])?;
                let kind_val = self.eval(&args[1])?;
                let kind_name = expect_text(&kind_val, name)?;
                let fmt_kind = FormatKind::parse(kind_name)?;
                let precision = if args.len() == 3 {
                    let p_val = self.eval(&args[2])?;
                    let p = expect_number(&p_val, name)?;
                    if p < 0.0 || p > 8.0 || p.fract() != 0.0 {
                        return Err(GenUiError::InvalidRange {
                            message: format!("format precision must be an integer in 0..=8, got {p}"),
                        });
                    }
                    Some(p as u8)
                } else {
                    None
                };
                Ok(StateValue::Text(format_value(&val, fmt_kind, precision)?))
            }
            BuiltinFn::Contains => {
                let vals = self.eval_exact_args(args, 2, name)?;
                let found = match &vals[0] {
                    StateValue::Text(haystack) => {
                        let needle = expect_text(&vals[1], name)?;
                        haystack.contains(needle)
                    }
                    StateValue::List(items) => items.iter().any(|item| item.structural_eq(&vals[1])),
                    StateValue::Record(_) => {
                        let key = expect_text(&vals[1], name)?;
                        vals[0].get_field(key).is_some()
                    }
                    StateValue::Null | StateValue::Bool(_) | StateValue::Number(_) => {
                        return Err(GenUiError::TypeMismatch {
                            context: name.to_owned(),
                            expected: "text, list, or record".to_owned(),
                            actual: vals[0].type_name().to_owned(),
                        });
                    }
                };
                Ok(StateValue::Bool(found))
            }
            BuiltinFn::Lower => {
                let vals = self.eval_exact_args(args, 1, name)?;
                Ok(StateValue::Text(expect_text(&vals[0], name)?.to_lowercase()))
            }
            BuiltinFn::Upper => {
                let vals = self.eval_exact_args(args, 1, name)?;
                Ok(StateValue::Text(expect_text(&vals[0], name)?.to_uppercase()))
            }
            BuiltinFn::Trim => {
                let vals = self.eval_exact_args(args, 1, name)?;
                Ok(StateValue::Text(expect_text(&vals[0], name)?.trim().to_owned()))
            }
            BuiltinFn::Concat => {
                if args.is_empty() {
                    return Ok(StateValue::Text(String::new()));
                }
                let first = self.eval(&args[0])?;
                if let StateValue::List(mut items) = first {
                    if items.len() > self.limits.max_collection_len {
                        return Err(GenUiError::CollectionLimitExceeded {
                            limit: self.limits.max_collection_len,
                        });
                    }
                    for arg in &args[1..] {
                        let next = self.eval(arg)?;
                        match next {
                            StateValue::List(more) => {
                                if items.len().saturating_add(more.len()) > self.limits.max_collection_len {
                                    return Err(GenUiError::CollectionLimitExceeded {
                                        limit: self.limits.max_collection_len,
                                    });
                                }
                                items.extend(more);
                            }
                            StateValue::Null | StateValue::Bool(_) | StateValue::Number(_) | StateValue::Text(_) | StateValue::Record(_) => {
                                if items.len() >= self.limits.max_collection_len {
                                    return Err(GenUiError::CollectionLimitExceeded {
                                        limit: self.limits.max_collection_len,
                                    });
                                }
                                items.push(next);
                            }
                        }
                    }
                    return Ok(StateValue::List(items));
                }
                let mut out = first.to_display_string();
                if out.len() > self.limits.max_string_len {
                    return Err(GenUiError::StringLimitExceeded {
                        limit: self.limits.max_string_len,
                    });
                }
                for arg in &args[1..] {
                    let piece = self.eval(arg)?.to_display_string();
                    if out.len().saturating_add(piece.len()) > self.limits.max_string_len {
                        return Err(GenUiError::StringLimitExceeded {
                            limit: self.limits.max_string_len,
                        });
                    }
                    out.push_str(&piece);
                }
                Ok(StateValue::Text(out))
            }
            BuiltinFn::Str => {
                let vals = self.eval_exact_args(args, 1, name)?;
                Ok(StateValue::Text(vals[0].to_display_string()))
            }
            BuiltinFn::Num => {
                let vals = self.eval_exact_args(args, 1, name)?;
                match &vals[0] {
                    StateValue::Number(n) => checked_finite(*n, name),
                    StateValue::Bool(b) => Ok(StateValue::Number(if *b { 1.0 } else { 0.0 })),
                    StateValue::Text(s) => {
                        let parsed: f64 = s.trim().parse().map_err(|_| GenUiError::TypeMismatch {
                            context: name.to_owned(),
                            expected: "numeric text".to_owned(),
                            actual: s.clone(),
                        })?;
                        checked_finite(parsed, name)
                    }
                    StateValue::Null | StateValue::List(_) | StateValue::Record(_) => Err(GenUiError::TypeMismatch {
                        context: name.to_owned(),
                        expected: "number, bool, or numeric text".to_owned(),
                        actual: vals[0].type_name().to_owned(),
                    }),
                }
            }
        }
    }

    fn eval_exact_args(&mut self, args: &[Expr], expected: usize, fn_name: &str) -> Result<Vec<StateValue>, GenUiError> {
        if args.len() != expected {
            return Err(GenUiError::ArityMismatch {
                function: fn_name.to_owned(),
                expected: expected.to_string(),
                actual: args.len(),
            });
        }
        let mut out = Vec::with_capacity(expected);
        for arg in args {
            out.push(self.eval(arg)?);
        }
        Ok(out)
    }

    fn eval_numeric_args(&mut self, args: &[Expr], fn_name: &str) -> Result<Vec<f64>, GenUiError> {
        if args.is_empty() {
            return Err(GenUiError::ArityMismatch {
                function: fn_name.to_owned(),
                expected: ">= 1".to_owned(),
                actual: 0,
            });
        }
        let mut nums = Vec::new();
        if args.len() == 1 {
            let val = self.eval(&args[0])?;
            match val {
                StateValue::List(items) => {
                    for item in items {
                        self.step()?;
                        match item {
                            StateValue::Number(n) => nums.push(n),
                            StateValue::Null => {}
                            StateValue::Bool(_) | StateValue::Text(_) | StateValue::List(_) | StateValue::Record(_) => {
                                return Err(GenUiError::TypeMismatch {
                                    context: fn_name.to_owned(),
                                    expected: "number".to_owned(),
                                    actual: item.type_name().to_owned(),
                                });
                            }
                        }
                    }
                    return Ok(nums);
                }
                StateValue::Number(n) => return Ok(vec![n]),
                StateValue::Null | StateValue::Bool(_) | StateValue::Text(_) | StateValue::Record(_) => {
                    return Err(GenUiError::TypeMismatch {
                        context: fn_name.to_owned(),
                        expected: "number or list of numbers".to_owned(),
                        actual: val.type_name().to_owned(),
                    });
                }
            }
        }
        for arg in args {
            let val = self.eval(arg)?;
            nums.push(expect_number(&val, fn_name)?);
        }
        Ok(nums)
    }
}
