use super::types::RelationType;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Tok {
    End,
    Error,
    ClassDiagram,
    Newline,
    Eof,
    Sqs,
    Str,
    Sqe,
    Dot,
    GenericType,
    Label,
    AccTitle,
    AccTitleValue,
    AccDescr,
    AccDescrValue,
    AccDescrMultilineValue,
    StructStart,
    StructStop,
    Namespace,
    StyleSeparator,
    AnnotationStart,
    AnnotationEnd,
    Class,
    Member,
    NoteFor,
    Note,
    ClassDef,
    Alpha,
    Comma,
    DirectionTb,
    DirectionBt,
    DirectionRl,
    DirectionLr,
    Aggregation,
    Extension,
    Composition,
    Dependency,
    Lollipop,
    Line,
    DottedLine,
    Callback,
    Link,
    LinkTarget,
    Click,
    CallbackName,
    CallbackArgs,
    Href,
    Style,
    CssClass,
    Colon,
    Brkt,
    Pct,
    Minus,
    UnicodeText,
    BquoteStr,
    EdgeState,
    EofInStruct,
    OpenInStruct,
    Plus,
    Equals,
    Punctuation,
}

impl Tok {
    pub const fn name(self) -> &'static str {
        match self {
            Self::End => "$end",
            Self::Error => "INVALID",
            Self::ClassDiagram => "CLASS_DIAGRAM",
            Self::Newline => "NEWLINE",
            Self::Eof => "EOF",
            Self::Sqs => "SQS",
            Self::Str => "STR",
            Self::Sqe => "SQE",
            Self::Dot => "DOT",
            Self::GenericType => "GENERICTYPE",
            Self::Label => "LABEL",
            Self::AccTitle => "acc_title",
            Self::AccTitleValue => "acc_title_value",
            Self::AccDescr => "acc_descr",
            Self::AccDescrValue => "acc_descr_value",
            Self::AccDescrMultilineValue => "acc_descr_multiline_value",
            Self::StructStart => "STRUCT_START",
            Self::StructStop => "STRUCT_STOP",
            Self::Namespace => "NAMESPACE",
            Self::StyleSeparator => "STYLE_SEPARATOR",
            Self::AnnotationStart => "ANNOTATION_START",
            Self::AnnotationEnd => "ANNOTATION_END",
            Self::Class => "CLASS",
            Self::Member => "MEMBER",
            Self::NoteFor => "NOTE_FOR",
            Self::Note => "NOTE",
            Self::ClassDef => "CLASSDEF",
            Self::Alpha => "ALPHA",
            Self::Comma => "COMMA",
            Self::DirectionTb => "direction_tb",
            Self::DirectionBt => "direction_bt",
            Self::DirectionRl => "direction_rl",
            Self::DirectionLr => "direction_lr",
            Self::Aggregation => "AGGREGATION",
            Self::Extension => "EXTENSION",
            Self::Composition => "COMPOSITION",
            Self::Dependency => "DEPENDENCY",
            Self::Lollipop => "LOLLIPOP",
            Self::Line => "LINE",
            Self::DottedLine => "DOTTED_LINE",
            Self::Callback => "CALLBACK",
            Self::Link => "LINK",
            Self::LinkTarget => "LINK_TARGET",
            Self::Click => "CLICK",
            Self::CallbackName => "CALLBACK_NAME",
            Self::CallbackArgs => "CALLBACK_ARGS",
            Self::Href => "HREF",
            Self::Style => "STYLE",
            Self::CssClass => "CSSCLASS",
            Self::Colon => "COLON",
            Self::Brkt => "BRKT",
            Self::Pct => "PCT",
            Self::Minus => "MINUS",
            Self::UnicodeText => "UNICODE_TEXT",
            Self::BquoteStr => "BQUOTE_STR",
            Self::EdgeState => "EDGE_STATE",
            Self::EofInStruct => "EOF_IN_STRUCT",
            Self::OpenInStruct => "OPEN_IN_STRUCT",
            Self::Plus => "PLUS",
            Self::Equals => "EQUALS",
            Self::Punctuation => "PUNCTUATION",
        }
    }

    pub const fn is_alphanum(self) -> bool {
        match self {
            Self::UnicodeText | Self::Alpha | Self::Minus => true,
            Self::End
            | Self::Error
            | Self::ClassDiagram
            | Self::Newline
            | Self::Eof
            | Self::Sqs
            | Self::Str
            | Self::Sqe
            | Self::Dot
            | Self::GenericType
            | Self::Label
            | Self::AccTitle
            | Self::AccTitleValue
            | Self::AccDescr
            | Self::AccDescrValue
            | Self::AccDescrMultilineValue
            | Self::StructStart
            | Self::StructStop
            | Self::Namespace
            | Self::StyleSeparator
            | Self::AnnotationStart
            | Self::AnnotationEnd
            | Self::Class
            | Self::Member
            | Self::NoteFor
            | Self::Note
            | Self::ClassDef
            | Self::Comma
            | Self::DirectionTb
            | Self::DirectionBt
            | Self::DirectionRl
            | Self::DirectionLr
            | Self::Aggregation
            | Self::Extension
            | Self::Composition
            | Self::Dependency
            | Self::Lollipop
            | Self::Line
            | Self::DottedLine
            | Self::Callback
            | Self::Link
            | Self::LinkTarget
            | Self::Click
            | Self::CallbackName
            | Self::CallbackArgs
            | Self::Href
            | Self::Style
            | Self::CssClass
            | Self::Colon
            | Self::Brkt
            | Self::Pct
            | Self::BquoteStr
            | Self::EdgeState
            | Self::EofInStruct
            | Self::OpenInStruct
            | Self::Plus
            | Self::Equals
            | Self::Punctuation => false,
        }
    }

    pub const fn is_style_part(self) -> bool {
        match self {
            Self::Alpha | Self::Colon | Self::Brkt | Self::Style | Self::Pct | Self::Label => true,
            Self::End
            | Self::Error
            | Self::ClassDiagram
            | Self::Newline
            | Self::Eof
            | Self::Sqs
            | Self::Str
            | Self::Sqe
            | Self::Dot
            | Self::GenericType
            | Self::AccTitle
            | Self::AccTitleValue
            | Self::AccDescr
            | Self::AccDescrValue
            | Self::AccDescrMultilineValue
            | Self::StructStart
            | Self::StructStop
            | Self::Namespace
            | Self::StyleSeparator
            | Self::AnnotationStart
            | Self::AnnotationEnd
            | Self::Class
            | Self::Member
            | Self::NoteFor
            | Self::Note
            | Self::ClassDef
            | Self::Comma
            | Self::DirectionTb
            | Self::DirectionBt
            | Self::DirectionRl
            | Self::DirectionLr
            | Self::Aggregation
            | Self::Extension
            | Self::Composition
            | Self::Dependency
            | Self::Lollipop
            | Self::Line
            | Self::DottedLine
            | Self::Callback
            | Self::Link
            | Self::LinkTarget
            | Self::Click
            | Self::CallbackName
            | Self::CallbackArgs
            | Self::Href
            | Self::CssClass
            | Self::Minus
            | Self::UnicodeText
            | Self::BquoteStr
            | Self::EdgeState
            | Self::EofInStruct
            | Self::OpenInStruct
            | Self::Plus
            | Self::Equals
            | Self::Punctuation => false,
        }
    }

    pub const fn relation_end(self) -> Option<RelationType> {
        match self {
            Self::Aggregation => Some(RelationType::Aggregation),
            Self::Extension => Some(RelationType::Extension),
            Self::Composition => Some(RelationType::Composition),
            Self::Dependency => Some(RelationType::Dependency),
            Self::Lollipop => Some(RelationType::Lollipop),
            Self::End
            | Self::Error
            | Self::ClassDiagram
            | Self::Newline
            | Self::Eof
            | Self::Sqs
            | Self::Str
            | Self::Sqe
            | Self::Dot
            | Self::GenericType
            | Self::Label
            | Self::AccTitle
            | Self::AccTitleValue
            | Self::AccDescr
            | Self::AccDescrValue
            | Self::AccDescrMultilineValue
            | Self::StructStart
            | Self::StructStop
            | Self::Namespace
            | Self::StyleSeparator
            | Self::AnnotationStart
            | Self::AnnotationEnd
            | Self::Class
            | Self::Member
            | Self::NoteFor
            | Self::Note
            | Self::ClassDef
            | Self::Alpha
            | Self::Comma
            | Self::DirectionTb
            | Self::DirectionBt
            | Self::DirectionRl
            | Self::DirectionLr
            | Self::Line
            | Self::DottedLine
            | Self::Callback
            | Self::Link
            | Self::LinkTarget
            | Self::Click
            | Self::CallbackName
            | Self::CallbackArgs
            | Self::Href
            | Self::Style
            | Self::CssClass
            | Self::Colon
            | Self::Brkt
            | Self::Pct
            | Self::Minus
            | Self::UnicodeText
            | Self::BquoteStr
            | Self::EdgeState
            | Self::EofInStruct
            | Self::OpenInStruct
            | Self::Plus
            | Self::Equals
            | Self::Punctuation => None,
        }
    }
}
