mod initial;
mod scan;
mod states;

use super::tokens::AgentToken;

pub struct AgentTokens {
    pub types: Vec<AgentToken>,
    pub texts: Vec<String>,
    pub starts: Vec<usize>,
    /// Four numbers per token matching Jison: first_line, first_col, last_line, last_col.
    /// Lines start at 1, columns at 0.
    pub locs: Vec<usize>,
}

pub fn tokenize(src: &str) -> AgentTokens {
    scan::Lexer::new(src).run()
}
