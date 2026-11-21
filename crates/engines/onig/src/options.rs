use std::fmt;
use std::ops::{BitAnd, BitAndAssign, BitOr, BitOrAssign};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default)]
pub struct FindOption(u32);

impl FindOption {
    pub const NONE: Self = Self(0);
    pub const DEFAULT: Self = Self(0);
    pub const IGNORECASE: Self = Self(1 << 0);
    pub const EXTEND: Self = Self(1 << 1);
    pub const MULTILINE: Self = Self(1 << 2);
    pub const SINGLELINE: Self = Self(1 << 3);
    pub const FIND_LONGEST: Self = Self(1 << 4);
    pub const FIND_NOT_EMPTY: Self = Self(1 << 5);
    pub const NEGATE_SINGLELINE: Self = Self(1 << 6);
    pub const DONT_CAPTURE_GROUP: Self = Self(1 << 7);
    pub const CAPTURE_GROUP: Self = Self(1 << 8);
    pub const NOTBOL: Self = Self(1 << 9);
    pub const NOTEOL: Self = Self(1 << 10);
    pub const IGNORECASE_IS_ASCII: Self = Self(1 << 11);
    pub const WORD_IS_ASCII: Self = Self(1 << 12);
    pub const DIGIT_IS_ASCII: Self = Self(1 << 13);
    pub const SPACE_IS_ASCII: Self = Self(1 << 14);
    pub const POSIX_IS_ASCII: Self = Self(1 << 15);
    pub const TEXT_SEGMENT_EXTENDED_GRAPHEME_CLUSTER: Self = Self(1 << 16);
    pub const TEXT_SEGMENT_WORD: Self = Self(1 << 17);
    pub const NOT_BEGIN_STRING: Self = Self(1 << 18);
    pub const NOT_END_STRING: Self = Self(1 << 19);
    pub const NOT_BEGIN_POSITION: Self = Self(1 << 20);

    pub const fn bits(self) -> u32 {
        self.0
    }

    pub const fn is_empty(self) -> bool {
        self.0 == 0
    }

    pub const fn contains(self, other: Self) -> bool {
        (self.0 & other.0) == other.0
    }

    pub const fn union(self, other: Self) -> Self {
        Self(self.0 | other.0)
    }

    pub const fn difference(self, other: Self) -> Self {
        Self(self.0 & !other.0)
    }
}

impl BitOr for FindOption {
    type Output = Self;

    fn bitor(self, rhs: Self) -> Self::Output {
        Self(self.0 | rhs.0)
    }
}

impl BitOrAssign for FindOption {
    fn bitor_assign(&mut self, rhs: Self) {
        self.0 |= rhs.0;
    }
}

impl BitAnd for FindOption {
    type Output = Self;

    fn bitand(self, rhs: Self) -> Self::Output {
        Self(self.0 & rhs.0)
    }
}

impl BitAndAssign for FindOption {
    fn bitand_assign(&mut self, rhs: Self) {
        self.0 &= rhs.0;
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default)]
pub enum Syntax {
    #[default]
    Oniguruma,
    Default,
    Ruby,
    Perl,
    PerlNg,
    Java,
    Python,
    PosixBasic,
    PosixExtended,
    Asis,
}

impl Syntax {
    /// True in Perl/Java/Python syntaxes where `(?s)` sets dotall and `(?m)` controls `^`/`$`.
    pub const fn uses_perl_ms_semantics(self) -> bool {
        matches!(self, Self::Perl | Self::PerlNg | Self::Java | Self::Python)
    }

    /// True when `(?P<name>...)` / `(?P=name)` Python-style named groups are recognized.
    pub const fn supports_python_named_groups(self) -> bool {
        matches!(self, Self::Python | Self::PerlNg)
    }

    /// True when `{n,m}+` and `{n}?` are possessive/lazy interval quantifiers instead of chained quantifiers.
    pub const fn supports_interval_modifiers(self) -> bool {
        matches!(self, Self::Perl | Self::PerlNg | Self::Java)
    }

    /// True when `\Q...\E` literal quoting is enabled.
    pub const fn supports_quote_escape(self) -> bool {
        matches!(self, Self::Perl | Self::PerlNg | Self::Java)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ExecLimits {
    pub max_steps: usize,
    pub max_backtrack_stack: usize,
    pub max_call_depth: usize,
}

impl Default for ExecLimits {
    fn default() -> Self {
        Self {
            max_steps: 2_000_000,
            max_backtrack_stack: 65_536,
            max_call_depth: 64,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ScannerConfig {
    pub options: FindOption,
    pub syntax: Syntax,
    pub limits: ExecLimits,
}

impl Default for ScannerConfig {
    fn default() -> Self {
        // Matches vscode-oniguruma's default scanner option (`FindOption.CaptureGroup`).
        Self {
            options: FindOption::CAPTURE_GROUP,
            syntax: Syntax::Oniguruma,
            limits: ExecLimits::default(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CompileErrorKind {
    Syntax,
    InvalidEscape,
    InvalidCharacterClass,
    InvalidQuantifier,
    InvalidGroupOption,
    UndefinedGroup,
    DuplicateNamedCall,
    NumberedRefWithNamedGroup,
    InvalidLookbehind,
    LeftRecursiveCall,
    UnknownProperty,
    UnsupportedFeature,
    PatternTooLarge,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompileError {
    pub kind: CompileErrorKind,
    pub offset: usize,
    pub message: String,
}

impl CompileError {
    pub(crate) fn new(kind: CompileErrorKind, offset: usize, message: impl Into<String>) -> Self {
        Self {
            kind,
            offset,
            message: message.into(),
        }
    }
}

impl fmt::Display for CompileError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "onig compile error ({:?}) at byte {}: {}", self.kind, self.offset, self.message)
    }
}

impl std::error::Error for CompileError {}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ExecError {
    StepLimitExceeded,
    StackLimitExceeded,
    CallDepthExceeded,
    InvalidStartOffset,
}

impl fmt::Display for ExecError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::StepLimitExceeded => write!(f, "regex execution step limit exceeded"),
            Self::StackLimitExceeded => write!(f, "regex backtrack stack limit exceeded"),
            Self::CallDepthExceeded => write!(f, "regex subroutine call depth exceeded"),
            Self::InvalidStartOffset => write!(f, "invalid start byte offset"),
        }
    }
}

impl std::error::Error for ExecError {}
