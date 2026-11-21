use crate::options::FindOption;
use crate::unicode::CharSet;
use crate::unicode::segment::SegmentMode;

#[derive(Debug, Clone)]
pub struct ParsedPattern {
    pub expr: Expr,
    pub num_captures: usize,
    pub named_groups: Vec<(String, Vec<usize>)>,
    pub has_g_anchor: bool,
    pub whole_options: FindOption,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QuantifierMode {
    Greedy,
    Lazy,
    Possessive,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Anchor {
    BeginLine,
    EndLine,
    BeginBuf,
    EndBuf,
    SemiEndBuf,
    BeginPosition,
    WordBoundary { ascii_only: bool },
    NotWordBoundary { ascii_only: bool },
    TextSegmentBoundary { mode: SegmentMode, negated: bool },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LookaroundKind {
    PosLookahead,
    NegLookahead,
    PosLookbehind,
    NegLookbehind,
}

#[derive(Debug, Clone)]
pub enum BackrefTarget {
    /// One or more group indices (for duplicate group names, ordered highest-to-lowest
    /// so Oniguruma checks the most recently defined matching group first).
    Groups(Vec<usize>),
    /// Backreference with recursion level (e.g. `\k<name+0>`, `\k<1-1>`).
    WithLevel { groups: Vec<usize>, level: i32 },
}

#[derive(Debug, Clone)]
pub enum ConditionKind {
    BackrefValid { groups: Vec<usize>, level: Option<i32> },
    Expr(Box<Expr>),
}

#[derive(Debug, Clone)]
pub enum Expr {
    Empty,
    Fail,
    Literal {
        text: String,
        ignore_case: bool,
        ascii_icase: bool,
    },
    AnyChar {
        dot_all: bool,
    },
    GeneralNewline,
    TextSegment(SegmentMode),
    CharClass(CharSet),
    Anchor(Anchor),
    Keep,
    Seq(Vec<Expr>),
    Alt(Vec<Expr>),
    Repeat {
        expr: Box<Expr>,
        min: u32,
        max: Option<u32>,
        mode: QuantifierMode,
    },
    Capture {
        index: usize,
        expr: Box<Expr>,
    },
    Atomic(Box<Expr>),
    Lookaround {
        kind: LookaroundKind,
        expr: Box<Expr>,
    },
    Backref {
        target: BackrefTarget,
        ignore_case: bool,
        ascii_icase: bool,
    },
    /// Subroutine call (`\g<0>` calls whole regex, `\g<n>` calls capture group `n`).
    Call {
        target_group: usize,
    },
    Condition {
        cond: ConditionKind,
        then_branch: Box<Expr>,
        else_branch: Option<Box<Expr>>,
    },
    /// `(?~absent)` — matches shortest-to-longest string not containing `absent`.
    AbsentRepeater(Box<Expr>),
    /// `(?~|absent|expr)` — matches `expr` within a slice not containing `absent`.
    AbsentExpression {
        absent: Box<Expr>,
        expr: Box<Expr>,
    },
    /// `(?~|absent)` — limits remaining match range so it doesn't include `absent`.
    AbsentStopper(Box<Expr>),
    /// `(?~|)` — clears active absent stopper range limits.
    RangeClear,
}

impl Expr {
    pub fn contains_g_anchor(&self) -> bool {
        match self {
            Self::Anchor(Anchor::BeginPosition) => true,
            Self::Seq(items) | Self::Alt(items) => items.iter().any(Self::contains_g_anchor),
            Self::Repeat { expr, .. }
            | Self::Capture { expr, .. }
            | Self::Atomic(expr)
            | Self::Lookaround { expr, .. }
            | Self::AbsentRepeater(expr)
            | Self::AbsentStopper(expr) => expr.contains_g_anchor(),
            Self::Condition {
                cond,
                then_branch,
                else_branch,
            } => {
                let cond_has = match cond {
                    ConditionKind::Expr(e) => e.contains_g_anchor(),
                    ConditionKind::BackrefValid { .. } => false,
                };
                cond_has || then_branch.contains_g_anchor() || else_branch.as_deref().is_some_and(Self::contains_g_anchor)
            }
            Self::AbsentExpression { absent, expr } => absent.contains_g_anchor() || expr.contains_g_anchor(),
            Self::Empty
            | Self::Fail
            | Self::Literal { .. }
            | Self::AnyChar { .. }
            | Self::GeneralNewline
            | Self::TextSegment(_)
            | Self::CharClass(_)
            | Self::Anchor(_)
            | Self::Keep
            | Self::Backref { .. }
            | Self::Call { .. }
            | Self::RangeClear => false,
        }
    }
}

pub fn collect_group_bodies<'a>(expr: &'a Expr, out: &mut [Option<&'a Expr>]) {
    match expr {
        Expr::Capture { index, expr } => {
            out[*index] = Some(expr);
            collect_group_bodies(expr, out);
        }
        Expr::Seq(items) | Expr::Alt(items) => {
            for item in items {
                collect_group_bodies(item, out);
            }
        }
        Expr::Repeat { expr, .. } | Expr::Atomic(expr) | Expr::Lookaround { expr, .. } | Expr::AbsentRepeater(expr) | Expr::AbsentStopper(expr) => {
            collect_group_bodies(expr, out)
        }
        Expr::AbsentExpression { absent, expr } => {
            collect_group_bodies(absent, out);
            collect_group_bodies(expr, out);
        }
        Expr::Condition {
            cond,
            then_branch,
            else_branch,
        } => {
            match cond {
                ConditionKind::Expr(e) => collect_group_bodies(e, out),
                ConditionKind::BackrefValid { .. } => {}
            }
            collect_group_bodies(then_branch, out);
            if let Some(e) = else_branch {
                collect_group_bodies(e, out);
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
}

pub fn expr_can_match_empty(expr: &Expr, group_bodies: &[Option<&Expr>]) -> bool {
    let mut visited = vec![false; group_bodies.len()];
    expr_can_match_empty_rec(expr, group_bodies, &mut visited)
}

fn expr_can_match_empty_rec(expr: &Expr, group_bodies: &[Option<&Expr>], visited: &mut [bool]) -> bool {
    match expr {
        Expr::Empty | Expr::Anchor(_) | Expr::Keep | Expr::Lookaround { .. } | Expr::RangeClear => true,
        Expr::Fail | Expr::AnyChar { .. } | Expr::GeneralNewline | Expr::TextSegment(_) | Expr::CharClass(_) => false,
        Expr::Literal { text, .. } => text.is_empty(),
        Expr::Backref { .. } => true,
        Expr::Seq(items) => items.iter().all(|i| expr_can_match_empty_rec(i, group_bodies, visited)),
        Expr::Alt(branches) => branches.iter().any(|b| expr_can_match_empty_rec(b, group_bodies, visited)),
        Expr::Repeat { expr, min, .. } => *min == 0 || expr_can_match_empty_rec(expr, group_bodies, visited),
        Expr::Capture { expr, .. } | Expr::Atomic(expr) => expr_can_match_empty_rec(expr, group_bodies, visited),
        Expr::Call { target_group } => {
            if visited[*target_group] {
                return true;
            }
            visited[*target_group] = true;
            let res = group_bodies[*target_group].is_some_and(|b| expr_can_match_empty_rec(b, group_bodies, visited));
            visited[*target_group] = false;
            res
        }
        Expr::Condition { then_branch, else_branch, .. } => {
            expr_can_match_empty_rec(then_branch, group_bodies, visited)
                || else_branch.as_deref().is_none_or(|e| expr_can_match_empty_rec(e, group_bodies, visited))
        }
        Expr::AbsentRepeater(_) | Expr::AbsentStopper(_) => true,
        Expr::AbsentExpression { expr, .. } => expr_can_match_empty_rec(expr, group_bodies, visited),
    }
}
