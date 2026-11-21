use indexmap::IndexMap;

use crate::util::yaml::YamlValue;

/// Message and control-flow kinds, numbered as in Mermaid.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum LineType {
    Solid,
    Dotted,
    Note,
    SolidCross,
    DottedCross,
    SolidOpen,
    DottedOpen,
    LoopStart,
    LoopEnd,
    AltStart,
    AltElse,
    AltEnd,
    OptStart,
    OptEnd,
    ActiveStart,
    ActiveEnd,
    ParStart,
    ParAnd,
    ParEnd,
    RectStart,
    RectEnd,
    SolidPoint,
    DottedPoint,
    Autonumber,
    CriticalStart,
    CriticalOption,
    CriticalEnd,
    BreakStart,
    BreakEnd,
    ParOverStart,
    BidirectionalSolid,
    BidirectionalDotted,
    SolidTop,
    SolidBottom,
    StickTop,
    StickBottom,
    SolidArrowTopReverse,
    SolidArrowBottomReverse,
    StickArrowTopReverse,
    StickArrowBottomReverse,
    SolidTopDotted,
    SolidBottomDotted,
    StickTopDotted,
    StickBottomDotted,
    SolidArrowTopReverseDotted,
    SolidArrowBottomReverseDotted,
    StickArrowTopReverseDotted,
    StickArrowBottomReverseDotted,
    CentralConnection,
    CentralConnectionReverse,
    CentralConnectionDual,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Placement {
    LeftOf,
    RightOf,
    Over,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SeqText {
    pub text: String,
    pub wrap: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SeqBoxData {
    pub text: Option<String>,
    pub color: String,
    pub wrap: Option<bool>,
}

#[derive(Debug, Clone)]
pub struct SeqBox {
    pub name: Option<String>,
    pub wrap: bool,
    pub fill: String,
    pub actor_keys: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct SeqActor {
    pub box_idx: Option<usize>,
    pub name: String,
    pub description: String,
    pub wrap: bool,
    pub prev_actor: Option<String>,
    pub next_actor: Option<String>,
    pub links: IndexMap<String, YamlValue>,
    pub properties: IndexMap<String, YamlValue>,
    pub details: Option<String>,
    pub actor_type: String,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SeqNumbering {
    pub start: Option<f64>,
    pub step: Option<f64>,
    pub visible: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub enum SeqMessageBody {
    Text(String),
    Numbering(SeqNumbering),
}

impl SeqMessageBody {
    pub fn as_text(&self) -> Option<&str> {
        match self {
            Self::Text(s) => Some(s.as_str()),
            Self::Numbering(_) => None,
        }
    }
}

#[derive(Debug, Clone)]
pub struct SeqMessage {
    pub id: String,
    pub from: Option<String>,
    pub to: Option<String>,
    pub message: SeqMessageBody,
    pub wrap: bool,
    pub line_type: Option<LineType>,
    pub activate: bool,
    pub placement: Option<Placement>,
    pub central_connection: Option<LineType>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SeqNoteTarget {
    Single(String),
    Pair(String, String),
}

#[derive(Debug, Clone)]
pub struct SeqNote {
    pub actor: SeqNoteTarget,
    pub placement: Placement,
    pub message: String,
    pub wrap: bool,
}

#[derive(Debug, Clone)]
pub enum SeqStatement {
    SequenceIndex {
        start: Option<f64>,
        step: Option<f64>,
        visible: bool,
    },
    AddParticipant {
        actor: String,
        draw: Option<String>,
        description: Option<SeqText>,
        config: Option<String>,
    },
    CreateParticipant {
        actor: String,
        draw: Option<String>,
        description: Option<SeqText>,
        config: Option<String>,
    },
    DestroyParticipant {
        actor: String,
    },
    ActorSignal {
        actor: String,
        signal_type: LineType,
    },
    AddNote {
        actor: SeqNoteTarget,
        placement: Placement,
        text: SeqText,
    },
    AddLinks {
        actor: String,
        text: SeqText,
    },
    AddALink {
        actor: String,
        text: SeqText,
    },
    AddProperties {
        actor: String,
        text: SeqText,
    },
    AddDetails {
        actor: String,
        text: SeqText,
    },
    AddMessage {
        from: String,
        to: String,
        msg: SeqText,
        signal_type: LineType,
        activate: bool,
        central_connection: Option<LineType>,
    },
    BoxStart(SeqBoxData),
    BoxEnd,
    BlockStart {
        text: SeqText,
        signal_type: LineType,
    },
    BlockDivider {
        text: SeqText,
        signal_type: LineType,
    },
    BlockEnd {
        signal_type: LineType,
    },
}

#[derive(Debug, Clone)]
pub enum SeqItem {
    Stmt(SeqStatement),
    Ignored,
    List(Vec<SeqItem>),
}
