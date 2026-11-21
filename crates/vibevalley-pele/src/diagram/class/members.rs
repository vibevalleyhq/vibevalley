use crate::diagram::common::parse_generic_types;
use crate::util::chars::{is_line_end, is_space, is_space_char};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Visibility {
    Protected,
    Public,
    Package,
    Private,
    None,
}

impl Visibility {
    pub const fn from_char(ch: char) -> Option<Self> {
        match ch {
            '#' => Some(Self::Protected),
            '+' => Some(Self::Public),
            '~' => Some(Self::Package),
            '-' => Some(Self::Private),
            _ => None,
        }
    }

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Protected => "#",
            Self::Public => "+",
            Self::Package => "~",
            Self::Private => "-",
            Self::None => "",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Classifier {
    Abstract,
    Static,
    None,
}

impl Classifier {
    pub const fn from_char(ch: char) -> Option<Self> {
        match ch {
            '*' => Some(Self::Abstract),
            '$' => Some(Self::Static),
            _ => None,
        }
    }

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Abstract => "*",
            Self::Static => "$",
            Self::None => "",
        }
    }

    pub const fn css_style(self) -> &'static str {
        match self {
            Self::Abstract => "font-style:italic;",
            Self::Static => "text-decoration:underline;",
            Self::None => "",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MemberType {
    Method,
    Attribute,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MemberDisplay {
    pub display_text: String,
    pub css_style: &'static str,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClassMember {
    pub id: String,
    pub member_type: MemberType,
    pub visibility: Visibility,
    pub classifier: Classifier,
    pub parameters: String,
    pub return_type: String,
}

fn trim_js(s: &str) -> &str {
    s.trim_matches(is_space_char)
}

impl ClassMember {
    pub fn parse(input: &str, member_type: MemberType) -> Self {
        let mut member = Self {
            id: String::new(),
            member_type,
            visibility: Visibility::None,
            classifier: Classifier::None,
            parameters: String::new(),
            return_type: String::new(),
        };
        // Mermaid throws a TypeError for a method with no opening parenthesis, such as `run)`.
        // Keep it as an attribute so it is shown as written.
        let parsed_method = match member_type {
            MemberType::Method => member.parse_method(input),
            MemberType::Attribute => false,
        };
        if !parsed_method {
            member.parse_attribute(input);
        }
        member.id = if member.id.starts_with(' ') {
            format!(" {}", trim_js(&member.id))
        } else {
            trim_js(&member.id).to_string()
        };
        member
    }

    /// Matches Mermaid's `/([#+~-])?(.+)\((.*)\)([\s$*])?(.*)([$*])?/` in a single linear pass.
    fn parse_method(&mut self, input: &str) -> bool {
        let bytes = input.as_bytes();
        let n = bytes.len();
        let mut start = 0;
        while start < n {
            let mut end = start;
            let mut next_start = n;
            for (rel, ch) in input[start..].char_indices() {
                if is_line_end(ch as u32) {
                    end = start + rel;
                    next_start = end + ch.len_utf8();
                    break;
                }
                end = start + rel + ch.len_utf8();
            }

            let close = input[start..end].rfind(')').map(|rel| start + rel);
            if let Some(close) = close
                && close > start
                && let Some(open_rel) = input[start..close].rfind('(')
            {
                let open = start + open_rel;
                if open > start {
                    let first = input[start..].chars().next().unwrap();
                    let visible = Visibility::from_char(first).filter(|_| open > start + 1);
                    if let Some(vis) = visible {
                        self.visibility = vis;
                    }
                    let id_start = if visible.is_some() { start + 1 } else { start };
                    self.id = input[id_start..open].to_string();
                    self.parameters = trim_js(&input[open + 1..close]).to_string();

                    let mut rest = close + 1;
                    let mut classifier = Classifier::None;
                    if rest < n {
                        let next = input[rest..].chars().next().unwrap();
                        if let Some(cls) = Classifier::from_char(next) {
                            classifier = cls;
                            rest += next.len_utf8();
                        } else if is_space(next as u32) {
                            rest += next.len_utf8();
                        }
                    }

                    let mut stop = rest;
                    for (rel, ch) in input[rest..].char_indices() {
                        if is_line_end(ch as u32) {
                            stop = rest + rel;
                            break;
                        }
                        stop = rest + rel + ch.len_utf8();
                    }
                    let mut return_type = trim_js(&input[rest..stop]).to_string();
                    if classifier == Classifier::None
                        && let Some(last) = return_type.chars().next_back()
                        && let Some(cls) = Classifier::from_char(last)
                    {
                        classifier = cls;
                        return_type.pop();
                    }
                    self.return_type = return_type;
                    self.classifier = classifier;
                    return true;
                }
            }

            start = next_start;
        }
        self.member_type = MemberType::Attribute;
        false
    }

    fn parse_attribute(&mut self, input: &str) {
        if let Some(first) = input.chars().next()
            && let Some(vis) = Visibility::from_char(first)
        {
            self.visibility = vis;
        }
        if let Some(last) = input.chars().next_back()
            && let Some(cls) = Classifier::from_char(last)
        {
            self.classifier = cls;
        }
        let start = if self.visibility == Visibility::None { 0 } else { 1 };
        let end = if self.classifier == Classifier::None {
            input.len()
        } else {
            input.len().saturating_sub(1)
        };
        self.id = if start <= end { input[start..end].to_string() } else { String::new() };
    }

    pub fn get_display_details(&self) -> MemberDisplay {
        let mut display_text = format!("{}{}", self.visibility.as_str(), parse_generic_types(&self.id));
        match self.member_type {
            MemberType::Method => {
                display_text.push('(');
                display_text.push_str(&parse_generic_types(trim_js(&self.parameters)));
                display_text.push(')');
                if !self.return_type.is_empty() {
                    display_text.push_str(" : ");
                    display_text.push_str(&parse_generic_types(&self.return_type));
                }
            }
            MemberType::Attribute => {}
        }
        MemberDisplay {
            display_text: trim_js(&display_text).to_string(),
            css_style: self.parse_classifier(),
        }
    }

    pub const fn parse_classifier(&self) -> &'static str {
        self.classifier.css_style()
    }
}
