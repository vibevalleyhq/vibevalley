use std::collections::HashMap;

use super::raw::{GroupDecl, RawCondition, RawExpr, RawRef};
use super::validate::{check_left_recursion, validate_expr};
use crate::ast::{BackrefTarget, ConditionKind, Expr, ParsedPattern, collect_group_bodies};
use crate::options::{CompileError, CompileErrorKind, FindOption};

/// Phase 2: resolve capture group numbering, backrefs, subroutines, lookbehind checks, and left-recursion checks.
pub(super) fn resolve_ast(raw: RawExpr, groups: &[GroupDecl], has_named_group: bool, whole_options: FindOption) -> Result<ParsedPattern, CompileError> {
    let dont_capture_unnamed =
        whole_options.contains(FindOption::DONT_CAPTURE_GROUP) || (has_named_group && !whole_options.contains(FindOption::CAPTURE_GROUP));
    let forbid_numbered_ref = has_named_group && !whole_options.contains(FindOption::CAPTURE_GROUP);

    let mut raw_to_final: Vec<Option<usize>> = Vec::with_capacity(groups.len());
    let mut named_map: HashMap<String, Vec<usize>> = HashMap::new();
    let mut named_order: Vec<String> = Vec::new();
    let mut next_group = 1usize;

    for decl in groups {
        match &decl.name {
            Some(name) => {
                let idx = next_group;
                next_group += 1;
                raw_to_final.push(Some(idx));
                if !named_map.contains_key(name) {
                    named_order.push(name.clone());
                }
                named_map.entry(name.clone()).or_default().push(idx);
            }
            None => {
                if dont_capture_unnamed {
                    raw_to_final.push(None);
                } else {
                    let idx = next_group;
                    next_group += 1;
                    raw_to_final.push(Some(idx));
                }
            }
        }
    }

    let num_captures = next_group - 1;
    let ctx = ResolveCtx {
        raw_to_final: &raw_to_final,
        named_map: &named_map,
        num_captures,
        forbid_numbered_ref,
    };

    let expr = resolve_expr(raw, &ctx)?;

    // Validate lookbehind constraints and left-recursive subroutine calls.
    let mut group_bodies: Vec<Option<&Expr>> = vec![None; num_captures + 1];
    group_bodies[0] = Some(&expr);
    collect_group_bodies(&expr, &mut group_bodies);

    validate_expr(&expr, &group_bodies)?;
    check_left_recursion(&group_bodies)?;

    let has_g_anchor = expr.contains_g_anchor();
    let named_groups: Vec<(String, Vec<usize>)> = named_order
        .into_iter()
        .map(|name| {
            let ids = named_map.remove(&name).unwrap_or_default();
            (name, ids)
        })
        .collect();

    Ok(ParsedPattern {
        expr,
        num_captures,
        named_groups,
        has_g_anchor,
        whole_options,
    })
}

struct ResolveCtx<'a> {
    raw_to_final: &'a [Option<usize>],
    named_map: &'a HashMap<String, Vec<usize>>,
    num_captures: usize,
    forbid_numbered_ref: bool,
}

impl<'a> ResolveCtx<'a> {
    fn resolve_backref(&self, r: &RawRef) -> Result<Vec<usize>, CompileError> {
        match r {
            RawRef::Number { num, offset } => {
                if self.forbid_numbered_ref {
                    return Err(CompileError::new(
                        CompileErrorKind::NumberedRefWithNamedGroup,
                        *offset,
                        "numbered backref/call is not allowed (use name)",
                    ));
                }
                if *num == 0 || *num > self.num_captures {
                    return Err(CompileError::new(
                        CompileErrorKind::UndefinedGroup,
                        *offset,
                        format!("invalid backref number {num}"),
                    ));
                }
                Ok(vec![*num])
            }
            RawRef::Relative { delta, groups_before, offset } => {
                if self.forbid_numbered_ref {
                    return Err(CompileError::new(
                        CompileErrorKind::NumberedRefWithNamedGroup,
                        *offset,
                        "numbered backref/call is not allowed (use name)",
                    ));
                }
                let final_before = self.raw_to_final[..*groups_before].iter().filter(|x| x.is_some()).count();
                let target = if *delta < 0 {
                    (final_before as isize) + (*delta as isize) + 1
                } else {
                    (final_before as isize) + (*delta as isize)
                };
                if target < 1 || (target as usize) > self.num_captures {
                    return Err(CompileError::new(
                        CompileErrorKind::UndefinedGroup,
                        *offset,
                        format!("invalid relative backref {delta}"),
                    ));
                }
                Ok(vec![target as usize])
            }
            RawRef::Name { name, offset } => {
                let Some(ids) = self.named_map.get(name) else {
                    return Err(CompileError::new(
                        CompileErrorKind::UndefinedGroup,
                        *offset,
                        format!("undefined name <{name}> reference"),
                    ));
                };
                // Oniguruma checks duplicate named groups from last defined to first.
                let mut rev = ids.clone();
                rev.reverse();
                Ok(rev)
            }
        }
    }

    fn resolve_call(&self, r: &RawRef) -> Result<usize, CompileError> {
        match r {
            RawRef::Number { num, offset } => {
                if *num == 0 {
                    return Ok(0);
                }
                if self.forbid_numbered_ref {
                    return Err(CompileError::new(
                        CompileErrorKind::NumberedRefWithNamedGroup,
                        *offset,
                        "numbered backref/call is not allowed (use name)",
                    ));
                }
                if *num > self.num_captures {
                    return Err(CompileError::new(
                        CompileErrorKind::UndefinedGroup,
                        *offset,
                        format!("undefined group <{num}> reference"),
                    ));
                }
                Ok(*num)
            }
            RawRef::Relative { delta, groups_before, offset } => {
                if self.forbid_numbered_ref {
                    return Err(CompileError::new(
                        CompileErrorKind::NumberedRefWithNamedGroup,
                        *offset,
                        "numbered backref/call is not allowed (use name)",
                    ));
                }
                let final_before = self.raw_to_final[..*groups_before].iter().filter(|x| x.is_some()).count();
                let target = if *delta < 0 {
                    (final_before as isize) + (*delta as isize) + 1
                } else {
                    (final_before as isize) + (*delta as isize)
                };
                if target < 1 || (target as usize) > self.num_captures {
                    return Err(CompileError::new(
                        CompileErrorKind::UndefinedGroup,
                        *offset,
                        format!("undefined relative group <{delta}> reference"),
                    ));
                }
                Ok(target as usize)
            }
            RawRef::Name { name, offset } => {
                let Some(ids) = self.named_map.get(name) else {
                    return Err(CompileError::new(
                        CompileErrorKind::UndefinedGroup,
                        *offset,
                        format!("undefined name <{name}> reference"),
                    ));
                };
                if ids.len() > 1 {
                    return Err(CompileError::new(
                        CompileErrorKind::DuplicateNamedCall,
                        *offset,
                        format!("multiplex definition name <{name}> call"),
                    ));
                }
                Ok(ids[0])
            }
        }
    }
}

fn resolve_expr(raw: RawExpr, ctx: &ResolveCtx<'_>) -> Result<Expr, CompileError> {
    match raw {
        RawExpr::Empty => Ok(Expr::Empty),
        RawExpr::Fail => Ok(Expr::Fail),
        RawExpr::Literal {
            text,
            ignore_case,
            ascii_icase,
        } => Ok(Expr::Literal {
            text,
            ignore_case,
            ascii_icase,
        }),
        RawExpr::AnyChar { dot_all } => Ok(Expr::AnyChar { dot_all }),
        RawExpr::GeneralNewline => Ok(Expr::GeneralNewline),
        RawExpr::TextSegment(mode) => Ok(Expr::TextSegment(mode)),
        RawExpr::CharClass { set, multi_folds, ascii_icase } => {
            if set.is_empty() && multi_folds.is_empty() {
                return Ok(Expr::Fail);
            }
            if multi_folds.is_empty() {
                Ok(Expr::CharClass(set))
            } else {
                let mut alts = Vec::with_capacity(1 + multi_folds.len());
                alts.push(Expr::CharClass(set));
                for s in multi_folds {
                    alts.push(Expr::Literal {
                        text: s,
                        ignore_case: true,
                        ascii_icase,
                    });
                }
                Ok(Expr::Alt(alts))
            }
        }
        RawExpr::Anchor(a) => Ok(Expr::Anchor(a)),
        RawExpr::Keep => Ok(Expr::Keep),
        RawExpr::Seq(items) => {
            let mut out: Vec<Expr> = Vec::with_capacity(items.len());
            for item in items {
                let resolved = resolve_expr(item, ctx)?;
                match resolved {
                    Expr::Empty => {}
                    Expr::Literal {
                        text,
                        ignore_case,
                        ascii_icase,
                    } => {
                        if let Some(Expr::Literal {
                            text: prev_text,
                            ignore_case: prev_ic,
                            ascii_icase: prev_aic,
                        }) = out.last_mut()
                            && *prev_ic == ignore_case
                            && *prev_aic == ascii_icase
                        {
                            prev_text.push_str(&text);
                            continue;
                        }
                        out.push(Expr::Literal {
                            text,
                            ignore_case,
                            ascii_icase,
                        });
                    }
                    Expr::Seq(nested) => {
                        for sub in nested {
                            push_coalesced(&mut out, sub);
                        }
                    }
                    other => out.push(other),
                }
            }
            match out.len() {
                0 => Ok(Expr::Empty),
                1 => Ok(out.pop().unwrap()),
                _ => Ok(Expr::Seq(out)),
            }
        }
        RawExpr::Alt(branches) => {
            let mut out = Vec::with_capacity(branches.len());
            for b in branches {
                out.push(resolve_expr(b, ctx)?);
            }
            Ok(Expr::Alt(out))
        }
        RawExpr::Repeat { expr, min, max, mode } => Ok(Expr::Repeat {
            expr: Box::new(resolve_expr(*expr, ctx)?),
            min,
            max,
            mode,
        }),
        RawExpr::Group { raw_id, expr } => {
            let inner = resolve_expr(*expr, ctx)?;
            if let Some(index) = ctx.raw_to_final[raw_id] {
                Ok(Expr::Capture { index, expr: Box::new(inner) })
            } else {
                Ok(inner)
            }
        }
        RawExpr::NonCapturing(expr) => resolve_expr(*expr, ctx),
        RawExpr::Atomic(expr) => Ok(Expr::Atomic(Box::new(resolve_expr(*expr, ctx)?))),
        RawExpr::Lookaround { kind, expr } => Ok(Expr::Lookaround {
            kind,
            expr: Box::new(resolve_expr(*expr, ctx)?),
        }),
        RawExpr::Backref {
            target,
            level,
            ignore_case,
            ascii_icase,
        } => {
            let groups = ctx.resolve_backref(&target)?;
            let target = match level {
                Some(lv) => BackrefTarget::WithLevel { groups, level: lv },
                None => BackrefTarget::Groups(groups),
            };
            Ok(Expr::Backref {
                target,
                ignore_case,
                ascii_icase,
            })
        }
        RawExpr::Call { target } => {
            let target_group = ctx.resolve_call(&target)?;
            Ok(Expr::Call { target_group })
        }
        RawExpr::Condition {
            cond,
            then_branch,
            else_branch,
        } => {
            let cond = match cond {
                RawCondition::Ref { target, level } => {
                    let groups = ctx.resolve_backref(&target)?;
                    ConditionKind::BackrefValid { groups, level }
                }
                RawCondition::Expr(e) => ConditionKind::Expr(Box::new(resolve_expr(*e, ctx)?)),
            };
            let then_branch = Box::new(resolve_expr(*then_branch, ctx)?);
            let else_branch = match else_branch {
                Some(e) => Some(Box::new(resolve_expr(*e, ctx)?)),
                None => None,
            };
            Ok(Expr::Condition {
                cond,
                then_branch,
                else_branch,
            })
        }
        RawExpr::AbsentRepeater(e) => Ok(Expr::AbsentRepeater(Box::new(resolve_expr(*e, ctx)?))),
        RawExpr::AbsentExpression { absent, expr } => Ok(Expr::AbsentExpression {
            absent: Box::new(resolve_expr(*absent, ctx)?),
            expr: Box::new(resolve_expr(*expr, ctx)?),
        }),
        RawExpr::AbsentStopper(e) => Ok(Expr::AbsentStopper(Box::new(resolve_expr(*e, ctx)?))),
        RawExpr::RangeClear => Ok(Expr::RangeClear),
    }
}

fn push_coalesced(out: &mut Vec<Expr>, item: Expr) {
    if let Expr::Literal {
        text,
        ignore_case,
        ascii_icase,
    } = item
    {
        if let Some(Expr::Literal {
            text: prev_text,
            ignore_case: prev_ic,
            ascii_icase: prev_aic,
        }) = out.last_mut()
            && *prev_ic == ignore_case
            && *prev_aic == ascii_icase
        {
            prev_text.push_str(&text);
            return;
        }
        out.push(Expr::Literal {
            text,
            ignore_case,
            ascii_icase,
        });
    } else if !matches!(item, Expr::Empty) {
        out.push(item);
    }
}
