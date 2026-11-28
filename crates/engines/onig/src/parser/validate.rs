use crate::ast::{ConditionKind, Expr, LookaroundKind, expr_can_match_empty};
use crate::options::{CompileError, CompileErrorKind};

pub(super) fn validate_expr(expr: &Expr, group_bodies: &[Option<&Expr>]) -> Result<(), CompileError> {
    match expr {
        Expr::Lookaround {
            kind: LookaroundKind::PosLookbehind,
            expr,
        } => {
            let mut visited = vec![false; group_bodies.len()];
            validate_lookbehind_inner(expr, false, group_bodies, &mut visited)?;
        }
        Expr::Lookaround {
            kind: LookaroundKind::NegLookbehind,
            expr,
        } => {
            let mut visited = vec![false; group_bodies.len()];
            validate_lookbehind_inner(expr, true, group_bodies, &mut visited)?;
        }
        Expr::Seq(items) | Expr::Alt(items) => {
            for item in items {
                validate_expr(item, group_bodies)?;
            }
        }
        Expr::Repeat { expr, .. }
        | Expr::Capture { expr, .. }
        | Expr::Atomic(expr)
        | Expr::Lookaround {
            kind: LookaroundKind::PosLookahead | LookaroundKind::NegLookahead,
            expr,
        }
        | Expr::AbsentRepeater(expr)
        | Expr::AbsentStopper(expr) => validate_expr(expr, group_bodies)?,
        Expr::AbsentExpression { absent, expr } => {
            validate_expr(absent, group_bodies)?;
            validate_expr(expr, group_bodies)?;
        }
        Expr::Condition {
            cond,
            then_branch,
            else_branch,
        } => {
            match cond {
                ConditionKind::Expr(e) => validate_expr(e, group_bodies)?,
                ConditionKind::BackrefValid { .. } => {}
            }
            validate_expr(then_branch, group_bodies)?;
            if let Some(e) = else_branch {
                validate_expr(e, group_bodies)?;
            }
        }
        Expr::Empty
        | Expr::Fail
        | Expr::Literal { .. }
        | Expr::AnyChar { .. }
        | Expr::GeneralNewline
        | Expr::TextSegment(_)
        | Expr::CharClass(_)
        | Expr::Anchor(_)
        | Expr::Keep
        | Expr::Backref { .. }
        | Expr::Call { .. }
        | Expr::RangeClear => {}
    }
    Ok(())
}

fn validate_lookbehind_inner(expr: &Expr, is_negative: bool, group_bodies: &[Option<&Expr>], visited: &mut [bool]) -> Result<(), CompileError> {
    match expr {
        Expr::AbsentStopper(_) | Expr::RangeClear => {
            return Err(CompileError::new(
                CompileErrorKind::InvalidLookbehind,
                0,
                "absent stopper or range clear not allowed in look-behind",
            ));
        }
        Expr::Lookaround {
            kind: LookaroundKind::PosLookahead | LookaroundKind::NegLookahead,
            ..
        } => {
            return Err(CompileError::new(
                CompileErrorKind::InvalidLookbehind,
                0,
                "look-ahead not allowed in look-behind",
            ));
        }
        Expr::Lookaround {
            kind: LookaroundKind::NegLookbehind,
            ..
        } if !is_negative => {
            return Err(CompileError::new(
                CompileErrorKind::InvalidLookbehind,
                0,
                "negative look-behind not allowed in positive look-behind",
            ));
        }
        Expr::Capture { expr, .. } => {
            if is_negative {
                return Err(CompileError::new(
                    CompileErrorKind::InvalidLookbehind,
                    0,
                    "capturing group not allowed in negative look-behind",
                ));
            }
            validate_lookbehind_inner(expr, is_negative, group_bodies, visited)?;
        }
        Expr::Call { target_group } => {
            if !visited[*target_group] {
                visited[*target_group] = true;
                if let Some(body) = group_bodies[*target_group] {
                    validate_lookbehind_inner(body, is_negative, group_bodies, visited)?;
                }
            }
        }
        Expr::Seq(items) | Expr::Alt(items) => {
            for item in items {
                validate_lookbehind_inner(item, is_negative, group_bodies, visited)?;
            }
        }
        Expr::Repeat { expr, min, .. } => {
            if check_repeat_len_overflow(expr, u64::from(*min)) {
                return Err(CompileError::new(CompileErrorKind::InvalidLookbehind, 0, "look-behind repeat length overflow"));
            }
            validate_lookbehind_inner(expr, is_negative, group_bodies, visited)?;
        }
        Expr::Atomic(expr)
        | Expr::Lookaround {
            kind: LookaroundKind::PosLookbehind | LookaroundKind::NegLookbehind,
            expr,
        }
        | Expr::AbsentRepeater(expr) => {
            validate_lookbehind_inner(expr, is_negative, group_bodies, visited)?;
        }
        Expr::AbsentExpression { absent, expr } => {
            validate_lookbehind_inner(absent, is_negative, group_bodies, visited)?;
            validate_lookbehind_inner(expr, is_negative, group_bodies, visited)?;
        }
        Expr::Condition {
            cond,
            then_branch,
            else_branch,
        } => {
            match cond {
                ConditionKind::Expr(e) => validate_lookbehind_inner(e, is_negative, group_bodies, visited)?,
                ConditionKind::BackrefValid { .. } => {}
            }
            validate_lookbehind_inner(then_branch, is_negative, group_bodies, visited)?;
            if let Some(e) = else_branch {
                validate_lookbehind_inner(e, is_negative, group_bodies, visited)?;
            }
        }
        Expr::Empty
        | Expr::Fail
        | Expr::Literal { .. }
        | Expr::AnyChar { .. }
        | Expr::GeneralNewline
        | Expr::TextSegment(_)
        | Expr::CharClass(_)
        | Expr::Anchor(_)
        | Expr::Keep
        | Expr::Backref { .. } => {}
    }
    Ok(())
}

/// Detects left-most recursive subroutine calls (e.g. `(?<name>a|\g<name>b)` or `(()(?(2)\g<1>))`).
pub(super) fn check_left_recursion(group_bodies: &[Option<&Expr>]) -> Result<(), CompileError> {
    let n = group_bodies.len();
    for g in 0..n {
        if let Some(body) = group_bodies[g] {
            let mut visiting = vec![false; n];
            visiting[g] = true;
            if has_left_call_to(body, g, group_bodies, &mut visiting) {
                return Err(CompileError::new(
                    CompileErrorKind::LeftRecursiveCall,
                    0,
                    format!("never ending recursion in group {g}"),
                ));
            }
        }
    }
    Ok(())
}

fn has_left_call_to(expr: &Expr, target: usize, group_bodies: &[Option<&Expr>], visiting: &mut [bool]) -> bool {
    match expr {
        Expr::Call { target_group } => {
            if *target_group == target {
                return true;
            }
            if !visiting[*target_group] {
                visiting[*target_group] = true;
                let found = group_bodies[*target_group].is_some_and(|b| has_left_call_to(b, target, group_bodies, visiting));
                visiting[*target_group] = false;
                return found;
            }
            false
        }
        Expr::Seq(items) => {
            for item in items {
                if has_left_call_to(item, target, group_bodies, visiting) {
                    return true;
                }
                if !expr_can_match_empty(item, group_bodies) {
                    break;
                }
            }
            false
        }
        Expr::Alt(branches) => branches.iter().any(|b| has_left_call_to(b, target, group_bodies, visiting)),
        Expr::Repeat { expr, max, .. } => {
            if *max == Some(0) {
                return false;
            }
            has_left_call_to(expr, target, group_bodies, visiting)
        }
        Expr::Capture { expr, .. } | Expr::Atomic(expr) | Expr::Lookaround { expr, .. } | Expr::AbsentRepeater(expr) | Expr::AbsentStopper(expr) => {
            has_left_call_to(expr, target, group_bodies, visiting)
        }
        Expr::AbsentExpression { expr, .. } => has_left_call_to(expr, target, group_bodies, visiting),
        Expr::Condition {
            cond,
            then_branch,
            else_branch,
        } => {
            let (cond_calls, cond_nullable) = match cond {
                ConditionKind::Expr(e) => (has_left_call_to(e, target, group_bodies, visiting), expr_can_match_empty(e, group_bodies)),
                ConditionKind::BackrefValid { .. } => (false, true),
            };
            cond_calls
                || (cond_nullable && has_left_call_to(then_branch, target, group_bodies, visiting))
                || else_branch.as_deref().is_some_and(|e| has_left_call_to(e, target, group_bodies, visiting))
        }
        Expr::Empty
        | Expr::Fail
        | Expr::Literal { .. }
        | Expr::AnyChar { .. }
        | Expr::GeneralNewline
        | Expr::TextSegment(_)
        | Expr::CharClass(_)
        | Expr::Anchor(_)
        | Expr::Keep
        | Expr::Backref { .. }
        | Expr::RangeClear => false,
    }
}

fn check_repeat_len_overflow(expr: &Expr, outer_min: u64) -> bool {
    const LIMIT: u64 = 100_000_000;
    fn min_bytes(e: &Expr) -> Option<u64> {
        match e {
            Expr::Literal { text, .. } => Some(text.len() as u64),
            Expr::AnyChar { .. } | Expr::CharClass(_) | Expr::GeneralNewline | Expr::TextSegment(_) => Some(1),
            Expr::Seq(items) => {
                let mut sum = 0u64;
                for i in items {
                    sum = sum.checked_add(min_bytes(i)?)?;
                    if sum > LIMIT {
                        return None;
                    }
                }
                Some(sum)
            }
            Expr::Alt(branches) => {
                let mut m = u64::MAX;
                for b in branches {
                    m = m.min(min_bytes(b)?);
                }
                Some(if m == u64::MAX { 0 } else { m })
            }
            Expr::Repeat { expr, min, .. } => {
                let prod = min_bytes(expr)?.checked_mul(u64::from(*min))?;
                if prod > LIMIT { None } else { Some(prod) }
            }
            Expr::Capture { expr, .. } | Expr::Atomic(expr) => min_bytes(expr),
            Expr::Empty
            | Expr::Fail
            | Expr::Anchor(_)
            | Expr::Keep
            | Expr::Lookaround { .. }
            | Expr::Backref { .. }
            | Expr::Call { .. }
            | Expr::Condition { .. }
            | Expr::AbsentRepeater(_)
            | Expr::AbsentExpression { .. }
            | Expr::AbsentStopper(_)
            | Expr::RangeClear => Some(0),
        }
    }
    match min_bytes(expr) {
        None => true,
        Some(inner) => inner.checked_mul(outer_min).is_none_or(|p| p > LIMIT),
    }
}
