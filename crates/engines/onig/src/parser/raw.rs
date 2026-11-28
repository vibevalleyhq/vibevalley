use crate::ast::{Anchor, LookaroundKind, QuantifierMode};
use crate::options::{FindOption, Syntax};
use crate::unicode::CharSet;
use crate::unicode::segment::SegmentMode;

pub(super) const MAX_NESTING_DEPTH: usize = 256;
pub(super) const MAX_REPEAT_BOUND: u32 = 100_000;

#[derive(Debug, Clone, Copy)]
pub(super) struct Flags {
    pub(super) ignore_case: bool,
    pub(super) dot_all: bool,
    pub(super) single_line: bool,
    pub(super) extend: bool,
    pub(super) ignore_case_ascii: bool,
    pub(super) word_ascii: bool,
    pub(super) digit_ascii: bool,
    pub(super) space_ascii: bool,
    pub(super) posix_ascii: bool,
    pub(super) segment_mode: SegmentMode,
}

impl Flags {
    pub(super) fn from_options(options: FindOption, syntax: Syntax) -> Self {
        let default_single_line = syntax.uses_perl_ms_semantics();
        let single_line = if options.contains(FindOption::NEGATE_SINGLELINE) {
            false
        } else if options.contains(FindOption::SINGLELINE) {
            true
        } else {
            default_single_line
        };
        let posix_ascii = options.contains(FindOption::POSIX_IS_ASCII);
        let segment_mode = if options.contains(FindOption::TEXT_SEGMENT_WORD) {
            SegmentMode::Word
        } else {
            SegmentMode::ExtendedGraphemeCluster
        };
        Self {
            ignore_case: options.contains(FindOption::IGNORECASE),
            dot_all: options.contains(FindOption::MULTILINE),
            single_line,
            extend: options.contains(FindOption::EXTEND),
            ignore_case_ascii: options.contains(FindOption::IGNORECASE_IS_ASCII),
            word_ascii: posix_ascii || options.contains(FindOption::WORD_IS_ASCII),
            digit_ascii: posix_ascii || options.contains(FindOption::DIGIT_IS_ASCII),
            space_ascii: posix_ascii || options.contains(FindOption::SPACE_IS_ASCII),
            posix_ascii,
            segment_mode,
        }
    }
}

#[derive(Debug, Clone)]
pub(super) enum RawRef {
    Number { num: usize, offset: usize },
    Relative { delta: i32, groups_before: usize, offset: usize },
    Name { name: String, offset: usize },
}

#[derive(Debug, Clone)]
pub(super) enum RawCondition {
    Ref { target: RawRef, level: Option<i32> },
    Expr(Box<RawExpr>),
}

#[derive(Debug, Clone)]
pub(super) enum RawExpr {
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
    CharClass {
        set: CharSet,
        /// Multi-codepoint fold expansions (e.g. `(?i:[ß])` also matches `"ss"`).
        multi_folds: Vec<String>,
        ascii_icase: bool,
    },
    Anchor(Anchor),
    Keep,
    Seq(Vec<RawExpr>),
    Alt(Vec<RawExpr>),
    Repeat {
        expr: Box<RawExpr>,
        min: u32,
        max: Option<u32>,
        mode: QuantifierMode,
    },
    Group {
        raw_id: usize,
        expr: Box<RawExpr>,
    },
    NonCapturing(Box<RawExpr>),
    Atomic(Box<RawExpr>),
    Lookaround {
        kind: LookaroundKind,
        expr: Box<RawExpr>,
    },
    Backref {
        target: RawRef,
        level: Option<i32>,
        ignore_case: bool,
        ascii_icase: bool,
    },
    Call {
        target: RawRef,
    },
    Condition {
        cond: RawCondition,
        then_branch: Box<RawExpr>,
        else_branch: Option<Box<RawExpr>>,
    },
    AbsentRepeater(Box<RawExpr>),
    AbsentExpression {
        absent: Box<RawExpr>,
        expr: Box<RawExpr>,
    },
    AbsentStopper(Box<RawExpr>),
    RangeClear,
}

impl RawExpr {
    pub(super) fn is_quantifiable(&self) -> bool {
        !matches!(self, Self::Anchor(_) | Self::Lookaround { .. } | Self::Keep)
    }
}

pub(super) struct GroupDecl {
    pub(super) name: Option<String>,
}

pub(super) struct IntervalSpec {
    pub(super) lo: u32,
    pub(super) hi: Option<u32>,
    pub(super) has_comma: bool,
    pub(super) end_pos: usize,
}

pub(super) enum SpecialGroup {
    Comment,
    IsolatedFlags { has_whole: bool },
}

pub(super) enum FlagTerminator {
    Colon,
    CloseParen,
}

pub(super) enum ClassAtom {
    Single(char),
    SingleCp(u32),
    MultiCp(Vec<u32>),
    Set(CharSet),
}
