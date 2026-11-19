use crate::detect::DiagramType;
use crate::diagram::timeline::scan::strip_keyword_sep;
use crate::error::{PeleError, SourceMap, syntax_error};

use super::db::C4Db;
use super::lexer::tokenize;
use super::tokens::C4Token;
use super::types::{C4Attr, C4Named, C4RelKind};

const HEADERS: &str =
    "'direction_tb', 'direction_bt', 'direction_rl', 'direction_lr', 'C4_CONTEXT', 'C4_CONTAINER', 'C4_COMPONENT', 'C4_DYNAMIC', 'C4_DEPLOYMENT'";
const ATTRIBUTES: &str = "'STR', 'STR_KEY', 'ATTRIBUTE', 'ATTRIBUTE_EMPTY'";

#[derive(Clone, Copy, PartialEq, Eq)]
enum ParseState {
    Item,
    Diagram,
    ItemOrEnd,
    AfterOther,
    AfterDiagram,
}

fn shape_kind(tok: C4Token) -> Option<&'static str> {
    match tok {
        C4Token::Person => Some("person"),
        C4Token::PersonExt => Some("external_person"),
        C4Token::System => Some("system"),
        C4Token::SystemDb => Some("system_db"),
        C4Token::SystemQueue => Some("system_queue"),
        C4Token::SystemExt => Some("external_system"),
        C4Token::SystemExtDb => Some("external_system_db"),
        C4Token::SystemExtQueue => Some("external_system_queue"),
        C4Token::Container => Some("container"),
        C4Token::ContainerDb => Some("container_db"),
        C4Token::ContainerQueue => Some("container_queue"),
        C4Token::ContainerExt => Some("external_container"),
        C4Token::ContainerExtDb => Some("external_container_db"),
        C4Token::ContainerExtQueue => Some("external_container_queue"),
        C4Token::Component => Some("component"),
        C4Token::ComponentDb => Some("component_db"),
        C4Token::ComponentQueue => Some("component_queue"),
        C4Token::ComponentExt => Some("external_component"),
        C4Token::ComponentExtDb => Some("external_component_db"),
        C4Token::ComponentExtQueue => Some("external_component_queue"),
        C4Token::End
        | C4Token::Error
        | C4Token::DirectionTb
        | C4Token::DirectionBt
        | C4Token::DirectionRl
        | C4Token::DirectionLr
        | C4Token::Title
        | C4Token::AccDescription
        | C4Token::AccTitle
        | C4Token::AccTitleValue
        | C4Token::AccDescr
        | C4Token::AccDescrValue
        | C4Token::AccDescrMultilineValue
        | C4Token::Newline
        | C4Token::C4Context
        | C4Token::C4Container
        | C4Token::C4Component
        | C4Token::C4Dynamic
        | C4Token::C4Deployment
        | C4Token::EnterpriseBoundary
        | C4Token::SystemBoundary
        | C4Token::Boundary
        | C4Token::ContainerBoundary
        | C4Token::Node
        | C4Token::NodeL
        | C4Token::NodeR
        | C4Token::Rel
        | C4Token::BiRel
        | C4Token::RelU
        | C4Token::RelD
        | C4Token::RelL
        | C4Token::RelR
        | C4Token::RelB
        | C4Token::RelIndex
        | C4Token::UpdateElStyle
        | C4Token::UpdateRelStyle
        | C4Token::UpdateLayoutConfig
        | C4Token::EofInStruct
        | C4Token::AttributeEmpty
        | C4Token::Str
        | C4Token::StrKey
        | C4Token::StrValue
        | C4Token::LBrace
        | C4Token::RBrace
        | C4Token::Eof => None,
    }
}

pub fn parse_c4(src: &str, db: &mut C4Db, origin: Option<&SourceMap<'_>>) -> Result<(), PeleError> {
    let tokens = tokenize(src);
    let mut i = 0usize;

    let text = |at: usize| -> &str { &src[tokens.starts[at]..tokens.ends[at]] };
    let fail = |at: usize, expected: &str| -> PeleError {
        let t = tokens.types[at];
        if t == C4Token::Error {
            syntax_error(DiagramType::C4, src, tokens.starts[at], "", true, origin)
        } else {
            syntax_error(
                DiagramType::C4,
                src,
                tokens.starts[at],
                &format!("Expecting {expected}, got '{}'", t.name()),
                false,
                origin,
            )
        }
    };

    let expect = |idx: &mut usize, expected: C4Token| -> Result<(), PeleError> {
        if tokens.types[*idx] != expected {
            return Err(fail(*idx, &format!("'{}'", expected.name())));
        }
        *idx += 1;
        Ok(())
    };

    let read_attributes = |idx: &mut usize| -> Result<Vec<C4Attr>, PeleError> {
        let mut attrs = Vec::new();
        loop {
            match tokens.types[*idx] {
                C4Token::Str => {
                    attrs.push(C4Attr::Positional(text(*idx).trim().to_string()));
                    *idx += 1;
                }
                C4Token::AttributeEmpty => {
                    attrs.push(C4Attr::Positional(String::new()));
                    *idx += 1;
                }
                C4Token::StrKey => {
                    let key_idx = *idx;
                    *idx += 1;
                    if tokens.types[*idx] != C4Token::StrValue {
                        return Err(fail(*idx, "'STR_VALUE'"));
                    }
                    attrs.push(C4Attr::Named(C4Named {
                        key: text(key_idx).trim().to_string(),
                        value: text(*idx).trim().to_string(),
                    }));
                    *idx += 1;
                }
                C4Token::End
                | C4Token::Error
                | C4Token::DirectionTb
                | C4Token::DirectionBt
                | C4Token::DirectionRl
                | C4Token::DirectionLr
                | C4Token::Title
                | C4Token::AccDescription
                | C4Token::AccTitle
                | C4Token::AccTitleValue
                | C4Token::AccDescr
                | C4Token::AccDescrValue
                | C4Token::AccDescrMultilineValue
                | C4Token::Newline
                | C4Token::C4Context
                | C4Token::C4Container
                | C4Token::C4Component
                | C4Token::C4Dynamic
                | C4Token::C4Deployment
                | C4Token::Person
                | C4Token::PersonExt
                | C4Token::System
                | C4Token::SystemDb
                | C4Token::SystemQueue
                | C4Token::SystemExt
                | C4Token::SystemExtDb
                | C4Token::SystemExtQueue
                | C4Token::Container
                | C4Token::ContainerDb
                | C4Token::ContainerQueue
                | C4Token::ContainerExt
                | C4Token::ContainerExtDb
                | C4Token::ContainerExtQueue
                | C4Token::Component
                | C4Token::ComponentDb
                | C4Token::ComponentQueue
                | C4Token::ComponentExt
                | C4Token::ComponentExtDb
                | C4Token::ComponentExtQueue
                | C4Token::EnterpriseBoundary
                | C4Token::SystemBoundary
                | C4Token::Boundary
                | C4Token::ContainerBoundary
                | C4Token::Node
                | C4Token::NodeL
                | C4Token::NodeR
                | C4Token::Rel
                | C4Token::BiRel
                | C4Token::RelU
                | C4Token::RelD
                | C4Token::RelL
                | C4Token::RelR
                | C4Token::RelB
                | C4Token::RelIndex
                | C4Token::UpdateElStyle
                | C4Token::UpdateRelStyle
                | C4Token::UpdateLayoutConfig
                | C4Token::EofInStruct
                | C4Token::StrValue
                | C4Token::LBrace
                | C4Token::RBrace
                | C4Token::Eof => break,
            }
        }
        if attrs.is_empty() {
            return Err(fail(*idx, ATTRIBUTES));
        }
        Ok(attrs)
    };

    let header = tokens.types[i];
    if !header.is_header() {
        return Err(fail(i, HEADERS));
    }
    i += 1;
    expect(&mut i, C4Token::Newline)?;

    let mut depth = 0usize;
    let mut state = ParseState::Item;
    loop {
        let t = tokens.types[i];
        if matches!(state, ParseState::AfterOther | ParseState::AfterDiagram) {
            if t == C4Token::Newline {
                i += 1;
                state = ParseState::ItemOrEnd;
                continue;
            }
            if state == ParseState::AfterOther && t.is_diagram() {
                state = ParseState::Diagram;
                continue;
            }
        } else if t.is_diagram() {
            i += 1;
            let mut attrs = read_attributes(&mut i)?;
            let opens_boundary = dispatch_diagram_stmt(t, &mut attrs, db, &tokens.types, &mut i, &fail, &expect)?;
            if opens_boundary {
                depth += 1;
                state = ParseState::Diagram;
            } else {
                state = ParseState::AfterDiagram;
            }
            continue;
        } else if t.is_other() && state != ParseState::Diagram {
            dispatch_other_stmt(t, db, &tokens.types, &mut i, &text, &fail)?;
            state = ParseState::AfterOther;
            continue;
        } else if state != ParseState::ItemOrEnd {
            return Err(fail(
                i,
                "'title', 'accDescription', 'acc_title', 'acc_descr', 'acc_descr_multiline_value', 'PERSON', 'REL'",
            ));
        }

        if depth > 0 {
            if t != C4Token::RBrace {
                return Err(fail(i, "'NEWLINE', 'RBRACE'"));
            }
            i += 1;
            db.pop_boundary_parse_stack();
            depth -= 1;
            state = ParseState::AfterDiagram;
        } else {
            if t != C4Token::Eof {
                return Err(fail(i, "'NEWLINE', 'EOF'"));
            }
            i += 1;
            expect(&mut i, C4Token::End)?;
            db.set_c4_type(text(0));
            return Ok(());
        }
    }
}

fn dispatch_diagram_stmt<F, E>(
    t: C4Token,
    attrs: &mut Vec<C4Attr>,
    db: &mut C4Db,
    types: &[C4Token],
    i: &mut usize,
    fail: &F,
    expect: &E,
) -> Result<bool, PeleError>
where
    F: Fn(usize, &str) -> PeleError,
    E: Fn(&mut usize, C4Token) -> Result<(), PeleError>,
{
    let opens_boundary = match t {
        C4Token::Person
        | C4Token::PersonExt
        | C4Token::System
        | C4Token::SystemDb
        | C4Token::SystemQueue
        | C4Token::SystemExt
        | C4Token::SystemExtDb
        | C4Token::SystemExtQueue => {
            db.add_person_or_system(shape_kind(t).unwrap(), attrs);
            false
        }
        C4Token::Container | C4Token::ContainerDb | C4Token::ContainerQueue | C4Token::ContainerExt | C4Token::ContainerExtDb | C4Token::ContainerExtQueue => {
            db.add_container(shape_kind(t).unwrap(), attrs);
            false
        }
        C4Token::Component | C4Token::ComponentDb | C4Token::ComponentQueue | C4Token::ComponentExt | C4Token::ComponentExtDb | C4Token::ComponentExtQueue => {
            db.add_component(shape_kind(t).unwrap(), attrs);
            false
        }
        C4Token::EnterpriseBoundary => {
            let pos = attrs.len().min(2);
            attrs.insert(pos, C4Attr::Positional("ENTERPRISE".to_string()));
            db.add_person_or_system_boundary(attrs, "system");
            true
        }
        C4Token::SystemBoundary => {
            let pos = attrs.len().min(2);
            attrs.insert(pos, C4Attr::Positional("SYSTEM".to_string()));
            db.add_person_or_system_boundary(attrs, "system");
            true
        }
        C4Token::Boundary => {
            db.add_person_or_system_boundary(attrs, "system");
            true
        }
        C4Token::ContainerBoundary => {
            let pos = attrs.len().min(2);
            attrs.insert(pos, C4Attr::Positional("CONTAINER".to_string()));
            db.add_container_boundary(attrs);
            true
        }
        C4Token::Node => {
            db.add_deployment_node("node", attrs);
            true
        }
        C4Token::NodeL => {
            db.add_deployment_node("nodeL", attrs);
            true
        }
        C4Token::NodeR => {
            db.add_deployment_node("nodeR", attrs);
            true
        }
        C4Token::Rel => {
            db.add_rel(C4RelKind::Rel, attrs);
            false
        }
        C4Token::BiRel => {
            db.add_rel(C4RelKind::BiRel, attrs);
            false
        }
        C4Token::RelU => {
            db.add_rel(C4RelKind::RelU, attrs);
            false
        }
        C4Token::RelD => {
            db.add_rel(C4RelKind::RelD, attrs);
            false
        }
        C4Token::RelL => {
            db.add_rel(C4RelKind::RelL, attrs);
            false
        }
        C4Token::RelR => {
            db.add_rel(C4RelKind::RelR, attrs);
            false
        }
        C4Token::RelB => {
            db.add_rel(C4RelKind::RelB, attrs);
            false
        }
        C4Token::RelIndex => {
            if !attrs.is_empty() {
                attrs.remove(0);
            }
            db.add_rel(C4RelKind::Rel, attrs);
            false
        }
        C4Token::UpdateElStyle => {
            db.update_el_style(attrs);
            false
        }
        C4Token::UpdateRelStyle => {
            db.update_rel_style(attrs);
            false
        }
        C4Token::UpdateLayoutConfig => {
            db.update_layout_config(attrs);
            false
        }
        C4Token::End
        | C4Token::Error
        | C4Token::DirectionTb
        | C4Token::DirectionBt
        | C4Token::DirectionRl
        | C4Token::DirectionLr
        | C4Token::Title
        | C4Token::AccDescription
        | C4Token::AccTitle
        | C4Token::AccTitleValue
        | C4Token::AccDescr
        | C4Token::AccDescrValue
        | C4Token::AccDescrMultilineValue
        | C4Token::Newline
        | C4Token::C4Context
        | C4Token::C4Container
        | C4Token::C4Component
        | C4Token::C4Dynamic
        | C4Token::C4Deployment
        | C4Token::EofInStruct
        | C4Token::AttributeEmpty
        | C4Token::Str
        | C4Token::StrKey
        | C4Token::StrValue
        | C4Token::LBrace
        | C4Token::RBrace
        | C4Token::Eof => unreachable!("filtered by is_diagram"),
    };
    if opens_boundary {
        if types[*i] == C4Token::LBrace {
            *i += 1;
            expect(i, C4Token::Newline)?;
        } else if types[*i] == C4Token::Newline {
            *i += 1;
            expect(i, C4Token::LBrace)?;
            if types[*i] == C4Token::Newline {
                *i += 1;
            }
        } else {
            return Err(fail(*i, "'NEWLINE', 'LBRACE'"));
        }
    }
    Ok(opens_boundary)
}

fn dispatch_other_stmt<'a, T, F>(t: C4Token, db: &mut C4Db, types: &[C4Token], i: &mut usize, text: &T, fail: &F) -> Result<(), PeleError>
where
    T: Fn(usize) -> &'a str,
    F: Fn(usize, &str) -> PeleError,
{
    match t {
        C4Token::Title => {
            db.set_title(strip_keyword_sep(text(*i), 5));
            *i += 1;
        }
        C4Token::AccDescription => {
            db.set_acc_description(strip_keyword_sep(text(*i), 14));
            *i += 1;
        }
        C4Token::AccDescrMultilineValue => {
            db.set_acc_description(text(*i).trim());
            *i += 1;
        }
        C4Token::AccTitle => {
            *i += 1;
            if types[*i] != C4Token::AccTitleValue {
                return Err(fail(*i, "'acc_title_value'"));
            }
            db.set_title(text(*i).trim());
            *i += 1;
        }
        C4Token::AccDescr => {
            *i += 1;
            if types[*i] != C4Token::AccDescrValue {
                return Err(fail(*i, "'acc_descr_value'"));
            }
            db.set_acc_description(text(*i).trim());
            *i += 1;
        }
        C4Token::End
        | C4Token::Error
        | C4Token::DirectionTb
        | C4Token::DirectionBt
        | C4Token::DirectionRl
        | C4Token::DirectionLr
        | C4Token::AccTitleValue
        | C4Token::AccDescrValue
        | C4Token::Newline
        | C4Token::C4Context
        | C4Token::C4Container
        | C4Token::C4Component
        | C4Token::C4Dynamic
        | C4Token::C4Deployment
        | C4Token::Person
        | C4Token::PersonExt
        | C4Token::System
        | C4Token::SystemDb
        | C4Token::SystemQueue
        | C4Token::SystemExt
        | C4Token::SystemExtDb
        | C4Token::SystemExtQueue
        | C4Token::Container
        | C4Token::ContainerDb
        | C4Token::ContainerQueue
        | C4Token::ContainerExt
        | C4Token::ContainerExtDb
        | C4Token::ContainerExtQueue
        | C4Token::Component
        | C4Token::ComponentDb
        | C4Token::ComponentQueue
        | C4Token::ComponentExt
        | C4Token::ComponentExtDb
        | C4Token::ComponentExtQueue
        | C4Token::EnterpriseBoundary
        | C4Token::SystemBoundary
        | C4Token::Boundary
        | C4Token::ContainerBoundary
        | C4Token::Node
        | C4Token::NodeL
        | C4Token::NodeR
        | C4Token::Rel
        | C4Token::BiRel
        | C4Token::RelU
        | C4Token::RelD
        | C4Token::RelL
        | C4Token::RelR
        | C4Token::RelB
        | C4Token::RelIndex
        | C4Token::UpdateElStyle
        | C4Token::UpdateRelStyle
        | C4Token::UpdateLayoutConfig
        | C4Token::EofInStruct
        | C4Token::AttributeEmpty
        | C4Token::Str
        | C4Token::StrKey
        | C4Token::StrValue
        | C4Token::LBrace
        | C4Token::RBrace
        | C4Token::Eof => unreachable!("filtered by is_other"),
    }
    Ok(())
}
