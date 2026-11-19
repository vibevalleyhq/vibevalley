#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum XyToken {
    End,
    Error,
    Newline,
    Title,
    AccTitle,
    AccTitleValue,
    AccDescr,
    AccDescrValue,
    AccDescrMultilineValue,
    XyChart,
    ChartOrientation,
    XAxis,
    YAxis,
    ArrowDelimiter,
    Line,
    Bar,
    NumberWithDecimal,
    SquareBracesStart,
    SquareBracesEnd,
    Str,
    Alpha,
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
    Semi,
    Eof,
}

impl XyToken {
    pub const fn name(self) -> &'static str {
        match self {
            Self::End => "$end",
            Self::Error => "INVALID",
            Self::Newline => "NEWLINE",
            Self::Title => "title",
            Self::AccTitle => "acc_title",
            Self::AccTitleValue => "acc_title_value",
            Self::AccDescr => "acc_descr",
            Self::AccDescrValue => "acc_descr_value",
            Self::AccDescrMultilineValue => "acc_descr_multiline_value",
            Self::XyChart => "XYCHART",
            Self::ChartOrientation => "CHART_ORIENTATION",
            Self::XAxis => "X_AXIS",
            Self::YAxis => "Y_AXIS",
            Self::ArrowDelimiter => "ARROW_DELIMITER",
            Self::Line => "LINE",
            Self::Bar => "BAR",
            Self::NumberWithDecimal => "NUMBER_WITH_DECIMAL",
            Self::SquareBracesStart => "SQUARE_BRACES_START",
            Self::SquareBracesEnd => "SQUARE_BRACES_END",
            Self::Str => "STR",
            Self::Alpha => "ALPHA",
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
            Self::Semi => "SEMI",
            Self::Eof => "EOF",
        }
    }

    pub const fn is_word(self) -> bool {
        matches!(
            self,
            Self::Amp | Self::Num | Self::Alpha | Self::Plus | Self::Equals | Self::Mult | Self::Dot | Self::Brkt | Self::Minus | Self::Underscore
        )
    }

    pub const fn is_eol(self) -> bool {
        matches!(self, Self::Newline | Self::Semi | Self::Eof)
    }

    pub const fn is_text(self) -> bool {
        matches!(self, Self::Str) || self.is_word()
    }
}
