#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QuadrantToken {
    End,
    Error,
    Newline,
    Title,
    TitleValue,
    AccTitle,
    AccTitleValue,
    AccDescr,
    AccDescrValue,
    AccDescrMultilineValue,
    XAxis,
    YAxis,
    Delimiter,
    Quadrant1,
    Quadrant2,
    Quadrant3,
    Quadrant4,
    ClassDef,
    MdStr,
    Str,
    ClassName,
    PointStart,
    PointX,
    PointY,
    Quadrant,
    Alpha,
    UnicodeText,
    Colon,
    Plus,
    Comma,
    Equals,
    Mult,
    Brkt,
    Underscore,
    Dot,
    Amp,
    Minus,
    Num,
    Space,
    Semi,
    Punctuation,
    Eof,
}

impl QuadrantToken {
    pub const fn name(self) -> &'static str {
        match self {
            Self::End => "$end",
            Self::Error => "INVALID",
            Self::Newline => "NEWLINE",
            Self::Title => "title",
            Self::TitleValue => "title_value",
            Self::AccTitle => "acc_title",
            Self::AccTitleValue => "acc_title_value",
            Self::AccDescr => "acc_descr",
            Self::AccDescrValue => "acc_descr_value",
            Self::AccDescrMultilineValue => "acc_descr_multiline_value",
            Self::XAxis => "X-AXIS",
            Self::YAxis => "Y-AXIS",
            Self::Delimiter => "AXIS-TEXT-DELIMITER",
            Self::Quadrant1 => "QUADRANT_1",
            Self::Quadrant2 => "QUADRANT_2",
            Self::Quadrant3 => "QUADRANT_3",
            Self::Quadrant4 => "QUADRANT_4",
            Self::ClassDef => "CLASSDEF",
            Self::MdStr => "MD_STR",
            Self::Str => "STR",
            Self::ClassName => "class_name",
            Self::PointStart => "point_start",
            Self::PointX => "point_x",
            Self::PointY => "point_y",
            Self::Quadrant => "QUADRANT",
            Self::Alpha => "ALPHA",
            Self::UnicodeText => "UNICODE_TEXT",
            Self::Colon => "COLON",
            Self::Plus => "PLUS",
            Self::Comma => "COMMA",
            Self::Equals => "EQUALS",
            Self::Mult => "MULT",
            Self::Brkt => "BRKT",
            Self::Underscore => "UNDERSCORE",
            Self::Dot => "DOT",
            Self::Amp => "AMP",
            Self::Minus => "MINUS",
            Self::Num => "NUM",
            Self::Space => "SPACE",
            Self::Semi => "SEMI",
            Self::Punctuation => "PUNCTUATION",
            Self::Eof => "EOF",
        }
    }

    pub const fn is_word(self) -> bool {
        matches!(
            self,
            Self::Punctuation
                | Self::Amp
                | Self::Num
                | Self::Alpha
                | Self::Comma
                | Self::Plus
                | Self::Equals
                | Self::Mult
                | Self::Dot
                | Self::Brkt
                | Self::Underscore
                | Self::UnicodeText
        )
    }

    pub const fn is_id(self) -> bool {
        matches!(
            self,
            Self::Alpha | Self::Num | Self::Minus | Self::Comma | Self::Colon | Self::Amp | Self::Brkt | Self::Mult | Self::UnicodeText
        )
    }

    pub const fn is_style(self) -> bool {
        matches!(self, Self::Alpha | Self::Num | Self::Colon | Self::Space | Self::Brkt | Self::Minus)
    }

    pub const fn is_eol(self) -> bool {
        matches!(self, Self::Newline | Self::Semi | Self::Eof)
    }

    pub const fn is_text(self) -> bool {
        matches!(self, Self::Str | Self::MdStr) || self.is_word()
    }
}
