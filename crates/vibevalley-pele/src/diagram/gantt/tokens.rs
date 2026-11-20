#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GanttToken {
    End,
    Error,
    OpenDirective,
    AccTitle,
    AccTitleValue,
    AccDescr,
    AccDescrValue,
    AccDescrMultilineValue,
    Nl,
    Href,
    CallbackName,
    CallbackArgs,
    Click,
    Gantt,
    DateFormat,
    InclusiveEndDates,
    TopAxis,
    AxisFormat,
    TickInterval,
    Includes,
    Excludes,
    TodayMarker,
    WeekdayMonday,
    WeekdayTuesday,
    WeekdayWednesday,
    WeekdayThursday,
    WeekdayFriday,
    WeekdaySaturday,
    WeekdaySunday,
    WeekendFriday,
    WeekendSaturday,
    Date,
    Title,
    AccDescription,
    Section,
    TaskTxt,
    TaskData,
    Colon,
    Eof,
}

impl GanttToken {
    pub const fn name(self) -> &'static str {
        match self {
            Self::End => "1",
            Self::Error => "INVALID",
            Self::OpenDirective => "open_directive",
            Self::AccTitle => "acc_title",
            Self::AccTitleValue => "acc_title_value",
            Self::AccDescr => "acc_descr",
            Self::AccDescrValue => "acc_descr_value",
            Self::AccDescrMultilineValue => "acc_descr_multiline_value",
            Self::Nl => "NL",
            Self::Href => "href",
            Self::CallbackName => "callbackname",
            Self::CallbackArgs => "callbackargs",
            Self::Click => "click",
            Self::Gantt => "gantt",
            Self::DateFormat => "dateFormat",
            Self::InclusiveEndDates => "inclusiveEndDates",
            Self::TopAxis => "topAxis",
            Self::AxisFormat => "axisFormat",
            Self::TickInterval => "tickInterval",
            Self::Includes => "includes",
            Self::Excludes => "excludes",
            Self::TodayMarker => "todayMarker",
            Self::WeekdayMonday => "weekday_monday",
            Self::WeekdayTuesday => "weekday_tuesday",
            Self::WeekdayWednesday => "weekday_wednesday",
            Self::WeekdayThursday => "weekday_thursday",
            Self::WeekdayFriday => "weekday_friday",
            Self::WeekdaySaturday => "weekday_saturday",
            Self::WeekdaySunday => "weekday_sunday",
            Self::WeekendFriday => "weekend_friday",
            Self::WeekendSaturday => "weekend_saturday",
            Self::Date => "date",
            Self::Title => "title",
            Self::AccDescription => "accDescription",
            Self::Section => "section",
            Self::TaskTxt => "taskTxt",
            Self::TaskData => "taskData",
            Self::Colon => ":",
            Self::Eof => "EOF",
        }
    }

    pub const fn starts_line(self) -> bool {
        matches!(
            self,
            Self::Eof
                | Self::Nl
                | Self::WeekdayMonday
                | Self::WeekdayTuesday
                | Self::WeekdayWednesday
                | Self::WeekdayThursday
                | Self::WeekdayFriday
                | Self::WeekdaySaturday
                | Self::WeekdaySunday
                | Self::WeekendFriday
                | Self::WeekendSaturday
                | Self::DateFormat
                | Self::InclusiveEndDates
                | Self::TopAxis
                | Self::AxisFormat
                | Self::TickInterval
                | Self::Excludes
                | Self::Includes
                | Self::TodayMarker
                | Self::Title
                | Self::AccTitle
                | Self::AccDescr
                | Self::AccDescrMultilineValue
                | Self::Section
                | Self::TaskTxt
                | Self::Click
        )
    }
}
