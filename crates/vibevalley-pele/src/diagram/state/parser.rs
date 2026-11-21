use crate::detect::DiagramType;
use crate::error::{ErrorCode, PeleError, SourceMap, locate, syntax_error};

use super::lexer::{tokenize, trim_js};
use super::tokens::StateToken;
use super::types::{
    ApplyClassStmt, ClassDefStmt, ClickStmt, ClickTarget, DirectionStmt, RelationStmt, StateDescription, StateNote, StateStmt, StateType, Stmt, StyleStmt,
};

/// The calls Mermaid's state grammar makes on its `yy` builder.
pub trait StateBuilder {
    fn set_root_doc(&mut self, doc: Vec<Stmt>) -> Result<(), PeleError>;
    fn trim_colon(&self, text: &str) -> String;
    fn get_divider_id(&mut self) -> String;
    fn set_direction(&mut self, dir: &str);
    fn set_acc_title(&mut self, text: &str);
    fn set_acc_description(&mut self, text: &str);
}

const STATEMENT: &str = "'NL', 'ID', 'HIDE_EMPTY', 'scale', 'COMPOSIT_STATE', 'STATE_DESCR', 'FORK', 'JOIN', 'CHOICE', 'CONCURRENT', 'note', \
'acc_title', 'acc_descr', 'acc_descr_multiline_value', 'CLICK', 'classDef', 'style', 'class', 'direction_tb', \
'direction_bt', 'direction_rl', 'direction_lr', 'EDGE_STATE'";

struct OpenComposite {
    parent_doc: Vec<Stmt>,
    id: String,
    description: String,
}

pub fn parse_state<B: StateBuilder>(src: &str, db: &mut B, origin: Option<&SourceMap<'_>>) -> Result<(), PeleError> {
    let tokens = tokenize(src);
    let mut i = 0usize;

    let fail = |i: usize, expected: &str| -> PeleError {
        let t = tokens.types[i];
        if t == StateToken::Error {
            if let Some(msg) = &tokens.error {
                return PeleError::new(msg.clone(), ErrorCode::Syntax)
                    .with_diagram_type(DiagramType::State)
                    .with_location(locate(src, tokens.starts[i], origin));
            }
            return syntax_error(DiagramType::State, src, tokens.starts[i], "", true, origin);
        }
        syntax_error(
            DiagramType::State,
            src,
            tokens.starts[i],
            &format!("Expecting {expected}, got '{}'", t.name()),
            false,
            origin,
        )
    };

    let expect = |i: &mut usize, expected_tok: StateToken| -> Result<String, PeleError> {
        if tokens.types[*i] != expected_tok {
            return Err(fail(*i, &format!("'{}'", expected_tok.name())));
        }
        let text = tokens.texts[*i].clone();
        *i += 1;
        Ok(text)
    };

    let id_statement = |i: &mut usize| -> Result<StateStmt, PeleError> {
        let t = tokens.types[*i];
        if t != StateToken::Id && t != StateToken::EdgeState {
            return Err(fail(*i, "'ID', 'EDGE_STATE'"));
        }
        let id = trim_js(&tokens.texts[*i]).to_string();
        *i += 1;
        let mut stmt = StateStmt::new(id, Some(StateType::Default));
        stmt.description = Some(StateDescription::Single(String::new()));
        if tokens.types[*i] == StateToken::StyleSeparator {
            *i += 1;
            let cls = expect(i, StateToken::Id)?;
            stmt.classes.push(trim_js(&cls).to_string());
        }
        Ok(stmt)
    };

    while tokens.types[i] == StateToken::Nl {
        i += 1;
    }
    if tokens.types[i] != StateToken::Sd {
        return Err(fail(i, "'NL', 'SD'"));
    }
    i += 1;

    let mut doc: Vec<Stmt> = Vec::new();
    let mut outer: Vec<OpenComposite> = Vec::new();

    // The grammar drops a statement whose value is the string it uses for a blank line.
    let add = |doc: &mut Vec<Stmt>, value: Stmt| {
        if !matches!(&value, Stmt::Raw(s) if s == "nl") {
            doc.push(value);
        }
    };

    let open = |i: &mut usize, doc: &mut Vec<Stmt>, outer: &mut Vec<OpenComposite>, id: String, description: String| {
        *i += 1;
        outer.push(OpenComposite {
            parent_doc: std::mem::take(doc),
            id,
            description,
        });
    };

    loop {
        let t = tokens.types[i];
        match t {
            StateToken::Nl => {
                i += 1;
            }
            StateToken::Id | StateToken::EdgeState => {
                let mut first = id_statement(&mut i)?;
                if tokens.types[i] == StateToken::Descr {
                    let descr = db.trim_colon(&tokens.texts[i]);
                    i += 1;
                    first.description = Some(StateDescription::Single(descr));
                    add(&mut doc, Stmt::State(Box::new(first)));
                } else if tokens.types[i] == StateToken::Arrow {
                    i += 1;
                    let second = id_statement(&mut i)?;
                    let description = if tokens.types[i] == StateToken::Descr {
                        let descr = db.trim_colon(&tokens.texts[i]);
                        i += 1;
                        Some(descr)
                    } else {
                        None
                    };
                    add(
                        &mut doc,
                        Stmt::Relation(Box::new(RelationStmt {
                            state1: first,
                            state2: second,
                            description,
                        })),
                    );
                } else {
                    add(&mut doc, Stmt::State(Box::new(first)));
                }
            }
            StateToken::HideEmpty => {
                let text = tokens.texts[i].clone();
                i += 1;
                add(&mut doc, Stmt::Raw(text));
            }
            StateToken::Scale => {
                let kw = tokens.texts[i].clone();
                i += 1;
                expect(&mut i, StateToken::Width)?;
                add(&mut doc, Stmt::Raw(kw));
            }
            StateToken::CompositState => {
                let id = tokens.texts[i].clone();
                i += 1;
                if tokens.types[i] == StateToken::StructStart {
                    open(&mut i, &mut doc, &mut outer, id, String::new());
                } else {
                    add(&mut doc, Stmt::Raw(id));
                }
            }
            StateToken::StateDescr => {
                let description = tokens.texts[i].clone();
                i += 1;
                expect(&mut i, StateToken::As)?;
                let id = expect(&mut i, StateToken::Id)?;
                if tokens.types[i] == StateToken::StructStart {
                    open(&mut i, &mut doc, &mut outer, id, description);
                } else if let Some(colon) = id.find(':') {
                    let first = id[..colon].to_string();
                    let rest = id[colon + 1..].split(':').next().unwrap_or("").to_string();
                    let mut stmt = StateStmt::new(first, Some(StateType::Default));
                    stmt.description = Some(StateDescription::Multi(vec![trim_js(&description).to_string(), rest]));
                    add(&mut doc, Stmt::State(Box::new(stmt)));
                } else {
                    let mut stmt = StateStmt::new(id, Some(StateType::Default));
                    stmt.description = Some(StateDescription::Single(trim_js(&description).to_string()));
                    add(&mut doc, Stmt::State(Box::new(stmt)));
                }
            }
            StateToken::Fork => {
                let id = tokens.texts[i].clone();
                i += 1;
                add(&mut doc, Stmt::State(Box::new(StateStmt::new(id, Some(StateType::Fork)))));
            }
            StateToken::Join => {
                let id = tokens.texts[i].clone();
                i += 1;
                add(&mut doc, Stmt::State(Box::new(StateStmt::new(id, Some(StateType::Join)))));
            }
            StateToken::Choice => {
                let id = tokens.texts[i].clone();
                i += 1;
                add(&mut doc, Stmt::State(Box::new(StateStmt::new(id, Some(StateType::Choice)))));
            }
            StateToken::Concurrent => {
                i += 1;
                let id = db.get_divider_id();
                add(&mut doc, Stmt::State(Box::new(StateStmt::new(id, Some(StateType::Divider)))));
            }
            StateToken::Note => {
                let keyword = tokens.texts[i].clone();
                i += 1;
                if tokens.types[i] == StateToken::LeftOf || tokens.types[i] == StateToken::RightOf {
                    let position = trim_js(&tokens.texts[i]).to_string();
                    i += 1;
                    let id = trim_js(&expect(&mut i, StateToken::Id)?).to_string();
                    let note_text = trim_js(&expect(&mut i, StateToken::NoteText)?).to_string();
                    let mut stmt = StateStmt::new(id, None);
                    stmt.note = Some(StateNote {
                        position: Some(position),
                        text: note_text,
                    });
                    add(&mut doc, Stmt::State(Box::new(stmt)));
                } else {
                    if tokens.types[i] != StateToken::NoteText {
                        return Err(fail(i, "'NOTE_TEXT', 'left_of', 'right_of'"));
                    }
                    i += 1;
                    expect(&mut i, StateToken::As)?;
                    expect(&mut i, StateToken::Id)?;
                    add(&mut doc, Stmt::Raw(keyword));
                }
            }
            StateToken::DirectionTb => {
                i += 1;
                db.set_direction("TB");
                add(&mut doc, Stmt::Direction(DirectionStmt { value: "TB".to_string() }));
            }
            StateToken::DirectionBt => {
                i += 1;
                db.set_direction("BT");
                add(&mut doc, Stmt::Direction(DirectionStmt { value: "BT".to_string() }));
            }
            StateToken::DirectionRl => {
                i += 1;
                db.set_direction("RL");
                add(&mut doc, Stmt::Direction(DirectionStmt { value: "RL".to_string() }));
            }
            StateToken::DirectionLr => {
                i += 1;
                db.set_direction("LR");
                add(&mut doc, Stmt::Direction(DirectionStmt { value: "LR".to_string() }));
            }
            StateToken::AccTitle => {
                i += 1;
                let value = trim_js(&expect(&mut i, StateToken::AccTitleValue)?).to_string();
                db.set_acc_title(&value);
                add(&mut doc, Stmt::Raw(value));
            }
            StateToken::AccDescr => {
                i += 1;
                let value = trim_js(&expect(&mut i, StateToken::AccDescrValue)?).to_string();
                db.set_acc_description(&value);
                add(&mut doc, Stmt::Raw(value));
            }
            StateToken::AccDescrMultilineValue => {
                let value = trim_js(&tokens.texts[i]).to_string();
                i += 1;
                db.set_acc_description(&value);
                add(&mut doc, Stmt::Raw(value));
            }
            StateToken::Click => {
                i += 1;
                let id = id_statement(&mut i)?;
                let (url, tooltip) = if tokens.types[i] == StateToken::Href {
                    i += 1;
                    (expect(&mut i, StateToken::String)?, String::new())
                } else {
                    if tokens.types[i] != StateToken::String {
                        return Err(fail(i, "'STRING', 'HREF'"));
                    }
                    let u = tokens.texts[i].clone();
                    i += 1;
                    let tip = expect(&mut i, StateToken::String)?;
                    (u, tip)
                };
                expect(&mut i, StateToken::Nl)?;
                add(
                    &mut doc,
                    Stmt::Click(ClickStmt {
                        id: ClickTarget::State(Box::new(id)),
                        url,
                        tooltip,
                    }),
                );
            }
            StateToken::ClassDef => {
                i += 1;
                let id = trim_js(&expect(&mut i, StateToken::ClassDefId)?).to_string();
                let classes = trim_js(&expect(&mut i, StateToken::ClassDefStyleOpts)?).to_string();
                add(&mut doc, Stmt::ClassDef(ClassDefStmt { id, classes }));
            }
            StateToken::Style => {
                i += 1;
                let id = trim_js(&expect(&mut i, StateToken::StyleIds)?).to_string();
                let style_class = trim_js(&expect(&mut i, StateToken::StyleDefStyleOpts)?).to_string();
                add(&mut doc, Stmt::Style(StyleStmt { id, style_class }));
            }
            StateToken::Class => {
                i += 1;
                let id = trim_js(&expect(&mut i, StateToken::ClassEntityIds)?).to_string();
                let style_class = trim_js(&expect(&mut i, StateToken::StyleClass)?).to_string();
                add(&mut doc, Stmt::ApplyClass(ApplyClassStmt { id, style_class }));
            }
            StateToken::StructStop => {
                let Some(frame) = outer.pop() else {
                    return Err(fail(i, &format!("'$end', {STATEMENT}")));
                };
                i += 1;
                let inner = std::mem::replace(&mut doc, frame.parent_doc);
                let mut stmt = StateStmt::new(frame.id, Some(StateType::Default));
                stmt.description = Some(StateDescription::Single(frame.description));
                stmt.doc = Some(inner);
                doc.push(Stmt::State(Box::new(stmt)));
            }
            StateToken::End => {
                if !outer.is_empty() {
                    return Err(fail(i, &format!("'STRUCT_STOP', {STATEMENT}")));
                }
                db.set_root_doc(doc)?;
                return Ok(());
            }
            StateToken::Error
            | StateToken::Sd
            | StateToken::Descr
            | StateToken::Arrow
            | StateToken::Width
            | StateToken::StructStart
            | StateToken::As
            | StateToken::NoteText
            | StateToken::AccTitleValue
            | StateToken::AccDescrValue
            | StateToken::String
            | StateToken::Href
            | StateToken::ClassDefId
            | StateToken::DefaultClassDefId
            | StateToken::ClassDefStyleOpts
            | StateToken::Default
            | StateToken::StyleIds
            | StateToken::StyleDefStyleOpts
            | StateToken::ClassEntityIds
            | StateToken::StyleClass
            | StateToken::StyleSeparator
            | StateToken::LeftOf
            | StateToken::RightOf
            | StateToken::Invalid => {
                let expected = if outer.is_empty() {
                    format!("'$end', {STATEMENT}")
                } else {
                    format!("'STRUCT_STOP', {STATEMENT}")
                };
                return Err(fail(i, &expected));
            }
        }
    }
}
