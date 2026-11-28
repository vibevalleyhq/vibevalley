mod initial;
mod links;
mod scan;
mod states;

use super::tokens::FlowToken;

pub struct FlowTokens {
    pub types: Vec<FlowToken>,
    pub texts: Vec<String>,
    pub starts: Vec<usize>,
}

pub fn tokenize(src: &str) -> FlowTokens {
    scan::Lexer::new(src).run()
}
