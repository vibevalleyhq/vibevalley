#[derive(Debug, Clone, PartialEq)]
pub enum RailroadNode {
    Terminal(String),
    NonTerminal(String),
    Special(String),
    Sequence(Vec<RailroadNode>),
    Choice(Vec<RailroadNode>),
    Optional(Box<RailroadNode>),
    /// `max` is `f64::INFINITY` when unbounded.
    Repetition {
        element: Box<RailroadNode>,
        min: f64,
        max: f64,
    },
}

impl Drop for RailroadNode {
    fn drop(&mut self) {
        let mut stack: Vec<RailroadNode> = Vec::new();
        let take_children = |node: &mut RailroadNode, stack: &mut Vec<RailroadNode>| match node {
            RailroadNode::Terminal(_) | RailroadNode::NonTerminal(_) | RailroadNode::Special(_) => {}
            RailroadNode::Sequence(elems) | RailroadNode::Choice(elems) => {
                stack.append(elems);
            }
            RailroadNode::Optional(inner) | RailroadNode::Repetition { element: inner, .. } => {
                let placeholder = RailroadNode::Terminal(String::new());
                stack.push(std::mem::replace(inner.as_mut(), placeholder));
            }
        };
        take_children(self, &mut stack);
        while let Some(mut node) = stack.pop() {
            take_children(&mut node, &mut stack);
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct RailroadRule {
    pub name: String,
    pub definition: RailroadNode,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Notation {
    Railroad,
    Ebnf,
    Abnf,
    Peg,
}

impl Notation {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Railroad => "railroad",
            Self::Ebnf => "ebnf",
            Self::Abnf => "abnf",
            Self::Peg => "peg",
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct RailroadModel {
    pub notation: Notation,
    pub title: Option<String>,
    pub acc_title: Option<String>,
    pub acc_descr: Option<String>,
    pub rules: Vec<RailroadRule>,
}
