use crate::detect::DiagramType;
use crate::error::{PeleError, SourceMap, syntax_error};

use super::db::SeqDb;
use super::lexer::tokenize;
use super::tokens::SeqToken;
use super::types::{LineType, Placement, SeqItem, SeqNoteTarget, SeqStatement, SeqText};

const SIGNAL_TOKENS: &str =
    "'SOLID_OPEN_ARROW', 'DOTTED_OPEN_ARROW', 'SOLID_ARROW', 'DOTTED_ARROW', 'SOLID_CROSS', 'DOTTED_CROSS', 'SOLID_POINT', 'DOTTED_POINT'";

fn signal_of(t: SeqToken) -> Option<LineType> {
    match t {
        SeqToken::SolidOpenArrow => Some(LineType::SolidOpen),
        SeqToken::DottedOpenArrow => Some(LineType::DottedOpen),
        SeqToken::SolidArrow => Some(LineType::Solid),
        SeqToken::DottedArrow => Some(LineType::Dotted),
        SeqToken::BidirectionalSolidArrow => Some(LineType::BidirectionalSolid),
        SeqToken::BidirectionalDottedArrow => Some(LineType::BidirectionalDotted),
        SeqToken::SolidCross => Some(LineType::SolidCross),
        SeqToken::DottedCross => Some(LineType::DottedCross),
        SeqToken::SolidPoint => Some(LineType::SolidPoint),
        SeqToken::DottedPoint => Some(LineType::DottedPoint),
        SeqToken::SolidArrowTop => Some(LineType::SolidTop),
        SeqToken::SolidArrowBottom => Some(LineType::SolidBottom),
        SeqToken::StickArrowTop => Some(LineType::StickTop),
        SeqToken::StickArrowBottom => Some(LineType::StickBottom),
        SeqToken::SolidArrowTopDotted => Some(LineType::SolidTopDotted),
        SeqToken::SolidArrowBottomDotted => Some(LineType::SolidBottomDotted),
        SeqToken::StickArrowTopDotted => Some(LineType::StickTopDotted),
        SeqToken::StickArrowBottomDotted => Some(LineType::StickBottomDotted),
        SeqToken::SolidArrowTopReverse => Some(LineType::SolidArrowTopReverse),
        SeqToken::SolidArrowBottomReverse => Some(LineType::SolidArrowBottomReverse),
        SeqToken::StickArrowTopReverse => Some(LineType::StickArrowTopReverse),
        SeqToken::StickArrowBottomReverse => Some(LineType::StickArrowBottomReverse),
        SeqToken::SolidArrowTopReverseDotted => Some(LineType::SolidArrowTopReverseDotted),
        SeqToken::SolidArrowBottomReverseDotted => Some(LineType::SolidArrowBottomReverseDotted),
        SeqToken::StickArrowTopReverseDotted => Some(LineType::StickArrowTopReverseDotted),
        SeqToken::StickArrowBottomReverseDotted => Some(LineType::StickArrowBottomReverseDotted),
        _ => None,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FrameKind {
    Top,
    Box,
    Loop,
    Rect,
    Opt,
    Break,
    Alt,
    Par,
    Critical,
}

struct Frame {
    kind: FrameKind,
    text: String,
    start_type: LineType,
    list: Vec<SeqItem>,
    sections: Vec<(Vec<SeqItem>, String)>,
}

struct Parser<'a> {
    src: &'a str,
    origin: Option<&'a SourceMap<'a>>,
    types: Vec<SeqToken>,
    texts: Vec<String>,
    starts: Vec<usize>,
    i: usize,
}

impl<'a> Parser<'a> {
    fn fail(&self, expected: &str) -> PeleError {
        let t = self.types[self.i];
        if t == SeqToken::Error {
            return syntax_error(DiagramType::Sequence, self.src, self.starts[self.i], "", true, self.origin);
        }
        syntax_error(
            DiagramType::Sequence,
            self.src,
            self.starts[self.i],
            &format!("Expecting {expected}, got '{}'", t.name()),
            false,
            self.origin,
        )
    }

    fn expect(&mut self, token: SeqToken) -> Result<String, PeleError> {
        if self.types[self.i] != token {
            return Err(self.fail(&format!("'{}'", token.name())));
        }
        let s = self.texts[self.i].clone();
        self.i += 1;
        Ok(s)
    }

    fn actor_name(&mut self) -> Result<String, PeleError> {
        let t = self.types[self.i];
        if t != SeqToken::Actor && t != SeqToken::Link {
            return Err(self.fail("'ACTOR'"));
        }
        let s = self.texts[self.i].clone();
        self.i += 1;
        Ok(s)
    }

    fn text2(&mut self, db: &SeqDb) -> Result<SeqText, PeleError> {
        let raw = self.expect(SeqToken::Txt)?;
        let trimmed = raw.trim();
        let after_colon = trimmed.strip_prefix(':').unwrap_or(trimmed);
        Ok(db.parse_message(after_colon))
    }

    fn participant(&mut self, db: &SeqDb, create: bool) -> Result<SeqStatement, PeleError> {
        let t = self.types[self.i];
        self.i += 1;
        if t == SeqToken::Destroy {
            let actor = self.actor_name()?;
            self.expect(SeqToken::Newline)?;
            if create {
                return Ok(SeqStatement::CreateParticipant {
                    actor,
                    draw: None,
                    description: None,
                    config: None,
                });
            }
            return Ok(SeqStatement::DestroyParticipant { actor });
        }
        let actor_token = self.types[self.i];
        let actor = self.actor_name()?;
        let mut config = None;
        if self.types[self.i] == SeqToken::ConfigStart && actor_token == SeqToken::Actor {
            self.i += 1;
            let content = self.expect(SeqToken::ConfigContent)?;
            self.expect(SeqToken::ConfigEnd)?;
            config = Some(content.trim().to_string());
        }
        let draw = Some(if t == SeqToken::Participant {
            "participant".to_string()
        } else {
            "actor".to_string()
        });
        let description = if self.types[self.i] == SeqToken::AsKw {
            self.i += 1;
            let alias = self.expect(SeqToken::RestOfLine)?;
            self.expect(SeqToken::Newline)?;
            Some(db.parse_message(&alias))
        } else if self.types[self.i] == SeqToken::Newline {
            self.i += 1;
            None
        } else {
            return Err(self.fail("'AS', 'NEWLINE'"));
        };
        if create {
            Ok(SeqStatement::CreateParticipant {
                actor,
                draw,
                description,
                config,
            })
        } else {
            Ok(SeqStatement::AddParticipant {
                actor,
                draw,
                description,
                config,
            })
        }
    }

    fn signal(&mut self, db: &SeqDb, from_actor: String) -> Result<SeqItem, PeleError> {
        let mut central_from = false;
        if self.types[self.i] == SeqToken::Central {
            central_from = true;
            self.i += 1;
        }
        let Some(signal_type) = signal_of(self.types[self.i]) else {
            return Err(self.fail(SIGNAL_TOKENS));
        };
        self.i += 1;
        let mark = self.types[self.i];
        if mark == SeqToken::Central || (!central_from && matches!(mark, SeqToken::Plus | SeqToken::Minus)) {
            self.i += 1;
        }
        let to_actor = self.actor_name()?;
        let msg = self.text2(db)?;

        let mut activate = false;
        let mut central_connection = None;
        let mut extra: Vec<SeqItem> = Vec::new();
        if central_from {
            let dual = mark == SeqToken::Central;
            activate = dual;
            central_connection = Some(if dual {
                LineType::CentralConnectionDual
            } else {
                LineType::CentralConnectionReverse
            });
            if dual {
                extra.push(SeqItem::Stmt(SeqStatement::ActorSignal {
                    actor: to_actor.clone(),
                    signal_type: LineType::CentralConnection,
                }));
            }
            extra.push(SeqItem::Stmt(SeqStatement::ActorSignal {
                actor: from_actor.clone(),
                signal_type: LineType::CentralConnectionReverse,
            }));
        } else if mark == SeqToken::Plus {
            activate = true;
            extra.push(SeqItem::Stmt(SeqStatement::ActorSignal {
                actor: to_actor.clone(),
                signal_type: LineType::ActiveStart,
            }));
        } else if mark == SeqToken::Minus {
            extra.push(SeqItem::Stmt(SeqStatement::ActorSignal {
                actor: from_actor.clone(),
                signal_type: LineType::ActiveEnd,
            }));
        } else if mark == SeqToken::Central {
            activate = true;
            central_connection = Some(LineType::CentralConnection);
            extra.push(SeqItem::Stmt(SeqStatement::ActorSignal {
                actor: to_actor.clone(),
                signal_type: LineType::CentralConnection,
            }));
        }

        let mut out = vec![
            SeqItem::Stmt(SeqStatement::AddParticipant {
                actor: from_actor.clone(),
                draw: None,
                description: None,
                config: None,
            }),
            SeqItem::Stmt(SeqStatement::AddParticipant {
                actor: to_actor.clone(),
                draw: None,
                description: None,
                config: None,
            }),
            SeqItem::Stmt(SeqStatement::AddMessage {
                from: from_actor,
                to: to_actor,
                msg,
                signal_type,
                activate,
                central_connection,
            }),
        ];
        out.extend(extra);
        Ok(SeqItem::List(out))
    }

    fn menu(&mut self, db: &SeqDb, kind: MenuKind) -> Result<SeqItem, PeleError> {
        self.i += 1;
        let who = self.actor_name()?;
        let text = self.text2(db)?;
        let action = match kind {
            MenuKind::Links => SeqStatement::AddLinks { actor: who.clone(), text },
            MenuKind::ALink => SeqStatement::AddALink { actor: who.clone(), text },
            MenuKind::Properties => SeqStatement::AddProperties { actor: who.clone(), text },
            MenuKind::Details => SeqStatement::AddDetails { actor: who.clone(), text },
        };
        Ok(SeqItem::List(vec![
            SeqItem::Stmt(SeqStatement::AddParticipant {
                actor: who,
                draw: None,
                description: None,
                config: None,
            }),
            SeqItem::Stmt(action),
        ]))
    }

    fn note(&mut self, db: &SeqDb) -> Result<SeqItem, PeleError> {
        self.i += 1;
        let t = self.types[self.i];
        if t == SeqToken::Over {
            self.i += 1;
            let first = self.actor_name()?;
            let mut who_items = vec![SeqItem::Stmt(SeqStatement::AddParticipant {
                actor: first.clone(),
                draw: None,
                description: None,
                config: None,
            })];
            let target = if self.types[self.i] == SeqToken::Comma {
                self.i += 1;
                let second = self.actor_name()?;
                who_items.push(SeqItem::Stmt(SeqStatement::AddParticipant {
                    actor: second.clone(),
                    draw: None,
                    description: None,
                    config: None,
                }));
                SeqNoteTarget::Pair(first, second)
            } else {
                SeqNoteTarget::Pair(first.clone(), first)
            };
            let text = self.text2(db)?;
            return Ok(SeqItem::List(vec![
                SeqItem::List(who_items),
                SeqItem::Stmt(SeqStatement::AddNote {
                    actor: target,
                    placement: Placement::Over,
                    text,
                }),
            ]));
        }
        if t != SeqToken::LeftOf && t != SeqToken::RightOf {
            return Err(self.fail("'over', 'left_of', 'right_of'"));
        }
        self.i += 1;
        let who = self.actor_name()?;
        let placement = if t == SeqToken::LeftOf { Placement::LeftOf } else { Placement::RightOf };
        let text = self.text2(db)?;
        Ok(SeqItem::List(vec![
            SeqItem::Stmt(SeqStatement::AddParticipant {
                actor: who.clone(),
                draw: None,
                description: None,
                config: None,
            }),
            SeqItem::Stmt(SeqStatement::AddNote {
                actor: SeqNoteTarget::Single(who),
                placement,
                text,
            }),
        ]))
    }

    fn autonumber(&mut self) -> Result<SeqStatement, PeleError> {
        self.i += 1;
        let mut start = None;
        let mut step = None;
        let mut visible = true;
        if self.types[self.i] == SeqToken::Num {
            start = self.texts[self.i].parse::<f64>().ok();
            self.i += 1;
            if self.types[self.i] == SeqToken::Num {
                step = self.texts[self.i].parse::<f64>().ok();
                self.i += 1;
            } else {
                step = Some(1.0);
            }
        } else if self.types[self.i] == SeqToken::Off {
            self.i += 1;
            visible = false;
        }
        if self.types[self.i] != SeqToken::Newline {
            return Err(self.fail("'NEWLINE', 'NUM', 'off'"));
        }
        self.i += 1;
        Ok(SeqStatement::SequenceIndex { start, step, visible })
    }
}

#[derive(Debug, Clone, Copy)]
enum MenuKind {
    Links,
    ALink,
    Properties,
    Details,
}

fn fold_sections(frame: Frame, db: &SeqDb, signal_type: LineType) -> Vec<SeqItem> {
    let mut list = frame.list;
    for (mut sec_list, divider_text) in frame.sections.into_iter().rev() {
        let head = SeqItem::Stmt(SeqStatement::BlockDivider {
            text: db.parse_message(&divider_text),
            signal_type,
        });
        sec_list.push(head);
        sec_list.push(SeqItem::List(list));
        list = sec_list;
    }
    list
}

fn close_frame(frame: Frame, db: &SeqDb) -> Vec<SeqItem> {
    let text = frame.text.clone();
    let kind = frame.kind;
    let start_type = frame.start_type;
    let mut list = match kind {
        FrameKind::Alt => fold_sections(frame, db, LineType::AltElse),
        FrameKind::Par => fold_sections(frame, db, LineType::ParAnd),
        FrameKind::Critical => fold_sections(frame, db, LineType::CriticalOption),
        FrameKind::Box | FrameKind::Loop | FrameKind::Rect | FrameKind::Opt | FrameKind::Break | FrameKind::Top => frame.list,
    };
    match kind {
        FrameKind::Box => {
            list[0] = SeqItem::Stmt(SeqStatement::BoxStart(db.parse_box_data(&text)));
            list.push(SeqItem::Stmt(SeqStatement::BoxEnd));
        }
        FrameKind::Loop => {
            list[0] = SeqItem::Stmt(SeqStatement::BlockStart {
                text: db.parse_message(&text),
                signal_type: LineType::LoopStart,
            });
            list.push(SeqItem::Stmt(SeqStatement::BlockEnd {
                signal_type: LineType::LoopEnd,
            }));
        }
        FrameKind::Rect => {
            list[0] = SeqItem::Stmt(SeqStatement::BlockStart {
                text: db.parse_message(&text),
                signal_type: LineType::RectStart,
            });
            list.push(SeqItem::Stmt(SeqStatement::BlockEnd {
                signal_type: LineType::RectEnd,
            }));
        }
        FrameKind::Opt => {
            list[0] = SeqItem::Stmt(SeqStatement::BlockStart {
                text: db.parse_message(&text),
                signal_type: LineType::OptStart,
            });
            list.push(SeqItem::Stmt(SeqStatement::BlockEnd { signal_type: LineType::OptEnd }));
        }
        FrameKind::Break => {
            list[0] = SeqItem::Stmt(SeqStatement::BlockStart {
                text: db.parse_message(&text),
                signal_type: LineType::BreakStart,
            });
            list.push(SeqItem::Stmt(SeqStatement::BlockEnd {
                signal_type: LineType::BreakEnd,
            }));
        }
        FrameKind::Alt => {
            list[0] = SeqItem::Stmt(SeqStatement::BlockStart {
                text: db.parse_message(&text),
                signal_type: LineType::AltStart,
            });
            list.push(SeqItem::Stmt(SeqStatement::BlockEnd { signal_type: LineType::AltEnd }));
        }
        FrameKind::Par => {
            list[0] = SeqItem::Stmt(SeqStatement::BlockStart {
                text: db.parse_message(&text),
                signal_type: start_type,
            });
            list.push(SeqItem::Stmt(SeqStatement::BlockEnd { signal_type: LineType::ParEnd }));
        }
        FrameKind::Critical | FrameKind::Top => {
            list[0] = SeqItem::Stmt(SeqStatement::BlockStart {
                text: db.parse_message(&text),
                signal_type: LineType::CriticalStart,
            });
            list.push(SeqItem::Stmt(SeqStatement::BlockEnd {
                signal_type: LineType::CriticalEnd,
            }));
        }
    }
    list
}

pub fn parse_sequence(src: &str, db: &mut SeqDb, origin: Option<&SourceMap<'_>>) -> Result<(), PeleError> {
    let tokens = tokenize(src);
    let mut p = Parser {
        src,
        origin,
        types: tokens.types,
        texts: tokens.texts,
        starts: tokens.starts,
        i: 0,
    };

    while p.types[p.i] == SeqToken::Newline {
        p.i += 1;
    }
    p.expect(SeqToken::Sd)?;

    let mut stack: Vec<Frame> = Vec::new();
    let mut frame = Frame {
        kind: FrameKind::Top,
        text: String::new(),
        start_type: LineType::ParStart,
        list: Vec::new(),
        sections: Vec::new(),
    };

    loop {
        let t = p.types[p.i];
        if frame.kind == FrameKind::Box {
            if matches!(t, SeqToken::Participant | SeqToken::ParticipantActor | SeqToken::Destroy) {
                let stmt = p.participant(db, false)?;
                frame.list.push(SeqItem::Stmt(stmt));
            } else if t == SeqToken::Newline {
                frame.list.push(SeqItem::Ignored);
                p.i += 1;
            } else if t == SeqToken::EndKw {
                p.i += 1;
                let done = close_frame(frame, db);
                frame = stack.pop().unwrap();
                frame.list.push(SeqItem::List(done));
            } else {
                return Err(p.fail("'end', 'NEWLINE', 'participant', 'participant_actor', 'destroy'"));
            }
            continue;
        }

        match t {
            SeqToken::Newline | SeqToken::Invalid => {
                frame.list.push(SeqItem::Ignored);
                p.i += 1;
            }
            SeqToken::Participant | SeqToken::ParticipantActor | SeqToken::Destroy => {
                let stmt = p.participant(db, false)?;
                frame.list.push(SeqItem::Stmt(stmt));
            }
            SeqToken::Create => {
                p.i += 1;
                let next = p.types[p.i];
                if !matches!(next, SeqToken::Participant | SeqToken::ParticipantActor | SeqToken::Destroy) {
                    return Err(p.fail("'participant', 'participant_actor', 'destroy'"));
                }
                let stmt = p.participant(db, true)?;
                frame.list.push(SeqItem::Stmt(stmt));
            }
            SeqToken::Actor => {
                let who = p.actor_name()?;
                let sig = p.signal(db, who)?;
                p.expect(SeqToken::Newline)?;
                frame.list.push(sig);
            }
            SeqToken::Link => {
                let next = p.types.get(p.i + 1).copied();
                let item = if matches!(next, Some(SeqToken::Actor | SeqToken::Link)) {
                    p.menu(db, MenuKind::ALink)?
                } else {
                    let who = p.actor_name()?;
                    p.signal(db, who)?
                };
                p.expect(SeqToken::Newline)?;
                frame.list.push(item);
            }
            SeqToken::Links => {
                let item = p.menu(db, MenuKind::Links)?;
                p.expect(SeqToken::Newline)?;
                frame.list.push(item);
            }
            SeqToken::Properties => {
                let item = p.menu(db, MenuKind::Properties)?;
                p.expect(SeqToken::Newline)?;
                frame.list.push(item);
            }
            SeqToken::Details => {
                let item = p.menu(db, MenuKind::Details)?;
                p.expect(SeqToken::Newline)?;
                frame.list.push(item);
            }
            SeqToken::Note => {
                let item = p.note(db)?;
                p.expect(SeqToken::Newline)?;
                frame.list.push(item);
            }
            SeqToken::Autonumber => {
                let stmt = p.autonumber()?;
                frame.list.push(SeqItem::Stmt(stmt));
            }
            SeqToken::Activate | SeqToken::Deactivate => {
                p.i += 1;
                let who = p.actor_name()?;
                p.expect(SeqToken::Newline)?;
                frame.list.push(SeqItem::Stmt(SeqStatement::ActorSignal {
                    actor: who,
                    signal_type: if t == SeqToken::Activate {
                        LineType::ActiveStart
                    } else {
                        LineType::ActiveEnd
                    },
                }));
            }
            SeqToken::Title | SeqToken::LegacyTitle => {
                let raw = p.texts[p.i].clone();
                p.i += 1;
                let skip = if t == SeqToken::Title { 6 } else { 7 };
                let title = if raw.len() >= skip { &raw[skip..] } else { "" };
                db.set_diagram_title(title);
                frame.list.push(SeqItem::Ignored);
            }
            SeqToken::AccTitle => {
                p.i += 1;
                let value = p.expect(SeqToken::AccTitleValue)?;
                db.set_acc_title(value.trim());
                frame.list.push(SeqItem::Ignored);
            }
            SeqToken::AccDescr => {
                p.i += 1;
                let value = p.expect(SeqToken::AccDescrValue)?;
                db.set_acc_description(value.trim());
                frame.list.push(SeqItem::Ignored);
            }
            SeqToken::AccDescrMultilineValue => {
                let value = p.texts[p.i].clone();
                p.i += 1;
                db.set_acc_description(value.trim());
                frame.list.push(SeqItem::Ignored);
            }
            SeqToken::LoopKw
            | SeqToken::RectKw
            | SeqToken::OptKw
            | SeqToken::BreakKw
            | SeqToken::AltKw
            | SeqToken::ParKw
            | SeqToken::ParOverKw
            | SeqToken::CriticalKw
            | SeqToken::BoxKw => {
                p.i += 1;
                let text = p.expect(SeqToken::RestOfLine)?;
                let kind = match t {
                    SeqToken::LoopKw => FrameKind::Loop,
                    SeqToken::RectKw => FrameKind::Rect,
                    SeqToken::OptKw => FrameKind::Opt,
                    SeqToken::BreakKw => FrameKind::Break,
                    SeqToken::AltKw => FrameKind::Alt,
                    SeqToken::ParKw | SeqToken::ParOverKw => FrameKind::Par,
                    SeqToken::CriticalKw => FrameKind::Critical,
                    SeqToken::BoxKw => FrameKind::Box,
                    _ => unreachable!(),
                };
                let start_type = if t == SeqToken::ParOverKw {
                    LineType::ParOverStart
                } else {
                    LineType::ParStart
                };
                stack.push(frame);
                frame = Frame {
                    kind,
                    text,
                    start_type,
                    list: vec![SeqItem::Ignored],
                    sections: Vec::new(),
                };
            }
            SeqToken::ElseKw | SeqToken::AndKw | SeqToken::OptionKw => {
                let want = match t {
                    SeqToken::ElseKw => FrameKind::Alt,
                    SeqToken::AndKw => FrameKind::Par,
                    SeqToken::OptionKw => FrameKind::Critical,
                    _ => unreachable!(),
                };
                if frame.kind != want {
                    return Err(p.fail("'end'"));
                }
                p.i += 1;
                let text = p.expect(SeqToken::RestOfLine)?;
                let prev = std::mem::take(&mut frame.list);
                frame.sections.push((prev, text));
            }
            SeqToken::EndKw => {
                if frame.kind == FrameKind::Top {
                    return Err(p.fail("'NEWLINE', 'EOF'"));
                }
                p.i += 1;
                let done = close_frame(frame, db);
                frame = stack.pop().unwrap();
                frame.list.push(SeqItem::List(done));
            }
            SeqToken::End => {
                if frame.kind != FrameKind::Top {
                    return Err(p.fail("'end'"));
                }
                return db.apply(SeqItem::List(frame.list));
            }
            _ => {
                return Err(p.fail("'NEWLINE', 'ACTOR', 'participant', 'note', 'end'"));
            }
        }
    }
}
