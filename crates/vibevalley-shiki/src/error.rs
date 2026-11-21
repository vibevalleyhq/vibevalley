use thiserror::Error;

/// Errors raised by a `RegexEngine` implementation during compilation or execution.
#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum RegexError {
    #[error("failed to compile regex pattern #{index} `{pattern}`: {message}")]
    Compile { index: usize, pattern: String, message: String },

    #[error("regex execution failed: {message}")]
    Exec { message: String },
}

/// Errors returned by grammar, theme, registry, and highlighter operations.
#[derive(Debug, Error)]
pub enum ShikiError {
    #[error("grammar parse error: {0}")]
    GrammarParse(String),

    #[error("theme parse error: {0}")]
    ThemeParse(String),

    #[error("plist parse error at offset {offset}: {message}")]
    PlistParse { offset: usize, message: String },

    #[error("no grammar provided for scope `{0}`")]
    MissingGrammar(String),

    #[error("theme `{0}` is not loaded")]
    MissingTheme(String),

    #[error("language `{0}` is not loaded")]
    MissingLanguage(String),

    #[error("theme include cycle detected at `{0}`")]
    ThemeIncludeCycle(String),

    #[error("invalid theme options: {0}")]
    InvalidOptions(String),

    #[error("grammar state mismatch: {0}")]
    GrammarStateMismatch(String),

    #[error(transparent)]
    Regex(#[from] RegexError),

    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
}
