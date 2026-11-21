/// Injection priority prefix in TextMate scope selectors (`L:`, default, `R:`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum InjectionPriority {
    /// `L:` — matches before normal grammar rules on tie.
    Left = -1,
    /// No prefix — standard injection priority.
    Default = 0,
    /// `R:` — matches after normal grammar rules on tie.
    Right = 1,
}

/// Compiled AST of a single branch in a TextMate scope selector expression.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SelectorExpr {
    /// Logical AND over sub-expressions (empty matches everything).
    And(Vec<SelectorExpr>),
    /// Logical OR over sub-expressions (`|` or `,` inside parentheses).
    Or(Vec<SelectorExpr>),
    /// Logical negation (`- expr`).
    Not(Box<SelectorExpr>),
    /// Ordered sequence of scope name prefixes to match along the scope stack.
    Path(Vec<String>),
    /// Invalid/empty operand after `-`.
    False,
}

impl SelectorExpr {
    /// Evaluates this selector against a scope stack using a custom scope-sequence matcher.
    pub fn matches_with<T>(&self, input: &T, matches_name: &impl Fn(&[String], &T) -> bool) -> bool {
        match self {
            SelectorExpr::And(parts) => parts.iter().all(|part| part.matches_with(input, matches_name)),
            SelectorExpr::Or(parts) => parts.iter().any(|part| part.matches_with(input, matches_name)),
            SelectorExpr::Not(inner) => !inner.matches_with(input, matches_name),
            SelectorExpr::Path(identifiers) => matches_name(identifiers, input),
            SelectorExpr::False => false,
        }
    }

    /// Evaluates this selector against a slice of scope names using TextMate prefix matching.
    pub fn matches_scopes(&self, scopes: &[String]) -> bool {
        self.matches_with(&scopes, &|identifiers, stack| name_matcher(identifiers, stack))
    }
}

/// A top-level selector branch paired with its `L:` / default / `R:` injection priority.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MatcherWithPriority {
    pub matcher: SelectorExpr,
    pub priority: InjectionPriority,
}

/// Parses a TextMate scope selector expression into prioritized matchers.
///
/// Supports `L:` / `R:` priorities, comma alternatives, `|` inside parentheses,
/// `-` negation, and space-separated scope descendant paths.
pub fn create_matchers(selector: &str) -> Vec<MatcherWithPriority> {
    let tokens = tokenize_selector(selector);
    let mut parser = SelectorParser { tokens: &tokens, pos: 0 };
    let mut results = Vec::new();

    while let Some(token) = parser.peek() {
        let priority = if token.len() == 2 && token.as_bytes()[1] == b':' {
            let prio = match token.as_bytes()[0] {
                b'L' => InjectionPriority::Left,
                b'R' => InjectionPriority::Right,
                _ => InjectionPriority::Default,
            };
            parser.advance();
            prio
        } else {
            InjectionPriority::Default
        };

        let matcher = parser.parse_conjunction();
        results.push(MatcherWithPriority { matcher, priority });

        if parser.peek() != Some(",") {
            break;
        }
        parser.advance();
    }

    results
}

/// TextMate prefix-aware scope stack matcher: each identifier must match a scope in
/// `scopes` in increasing depth order, either identically or as a dot-delimited prefix.
pub fn name_matcher(identifiers: &[String], scopes: &[String]) -> bool {
    if scopes.len() < identifiers.len() {
        return false;
    }
    let mut last_index = 0;
    for identifier in identifiers {
        let mut found = false;
        for (i, scope) in scopes.iter().enumerate().skip(last_index) {
            if scopes_are_matching(scope, identifier) {
                last_index = i + 1;
                found = true;
                break;
            }
        }
        if !found {
            return false;
        }
    }
    true
}

/// Returns true when `this_scope` equals `target_scope` or starts with `target_scope`
/// followed immediately by `.`.
pub fn scopes_are_matching(this_scope: &str, target_scope: &str) -> bool {
    if this_scope.is_empty() {
        return false;
    }
    if this_scope == target_scope {
        return true;
    }
    let len = target_scope.len();
    this_scope.len() > len && this_scope.as_bytes()[len] == b'.' && this_scope.starts_with(target_scope)
}

struct SelectorParser<'a> {
    tokens: &'a [&'a str],
    pos: usize,
}

impl<'a> SelectorParser<'a> {
    fn peek(&self) -> Option<&'a str> {
        self.tokens.get(self.pos).copied()
    }

    fn advance(&mut self) -> Option<&'a str> {
        let tok = self.peek()?;
        self.pos += 1;
        Some(tok)
    }

    fn parse_operand(&mut self) -> Option<SelectorExpr> {
        let token = self.peek()?;
        if token == "-" {
            self.advance();
            let inner = self.parse_operand();
            return Some(match inner {
                Some(expr) => SelectorExpr::Not(Box::new(expr)),
                None => SelectorExpr::False,
            });
        }
        if token == "(" {
            self.advance();
            let inner = self.parse_inner_expression();
            if self.peek() == Some(")") {
                self.advance();
            }
            return Some(inner);
        }
        if is_identifier(token) {
            let mut identifiers = Vec::new();
            while let Some(tok) = self.peek() {
                if !is_identifier(tok) {
                    break;
                }
                identifiers.push(tok.to_string());
                self.advance();
            }
            return Some(SelectorExpr::Path(identifiers));
        }
        None
    }

    fn parse_conjunction(&mut self) -> SelectorExpr {
        let mut matchers = Vec::new();
        while let Some(expr) = self.parse_operand() {
            matchers.push(expr);
        }
        SelectorExpr::And(matchers)
    }

    fn parse_inner_expression(&mut self) -> SelectorExpr {
        let mut matchers = Vec::new();
        loop {
            let expr = self.parse_conjunction();
            matchers.push(expr);
            if matches!(self.peek(), Some("|" | ",")) {
                while matches!(self.peek(), Some("|" | ",")) {
                    self.advance();
                }
            } else {
                break;
            }
        }
        SelectorExpr::Or(matchers)
    }
}

fn is_identifier_start(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_' || b == b'.' || b == b':'
}

fn is_identifier_cont(b: u8) -> bool {
    is_identifier_start(b) || b == b'-'
}

fn is_identifier(token: &str) -> bool {
    token.bytes().any(is_identifier_start)
}

/// Tokenizes `selector` identically to `vscode-textmate`'s `/([LR]:|[\w\.:][\w\.:\-]*|[\,\|\-\(\)])/g`.
fn tokenize_selector(input: &str) -> Vec<&str> {
    let bytes = input.as_bytes();
    let len = bytes.len();
    let mut tokens = Vec::new();
    let mut i = 0;

    while i < len {
        let b = bytes[i];
        if (b == b'L' || b == b'R') && i + 1 < len && bytes[i + 1] == b':' {
            tokens.push(&input[i..i + 2]);
            i += 2;
            continue;
        }
        if is_identifier_start(b) {
            let start = i;
            i += 1;
            while i < len && is_identifier_cont(bytes[i]) {
                i += 1;
            }
            tokens.push(&input[start..i]);
            continue;
        }
        if matches!(b, b',' | b'|' | b'-' | b'(' | b')') {
            tokens.push(&input[i..i + 1]);
            i += 1;
            continue;
        }
        i += 1;
    }

    tokens
}
