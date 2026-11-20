use crate::detect::DiagramType;
use crate::error::{ErrorCode, PeleError};

use super::scan::{collapse_newline_ws, trim_leading_ws};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TimelineDirection {
    Lr,
    Td,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TimelinePeriod {
    pub text: String,
    pub events: Vec<String>,
    pub section: String,
    pub section_index: isize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TimelineModel {
    pub title: Option<String>,
    pub acc_title: Option<String>,
    pub acc_descr: Option<String>,
    pub direction: TimelineDirection,
    pub sections: Vec<String>,
    pub periods: Vec<TimelinePeriod>,
    current_section: String,
}

impl Default for TimelineModel {
    fn default() -> Self {
        Self::new()
    }
}

impl TimelineModel {
    pub fn new() -> Self {
        Self {
            title: None,
            acc_title: None,
            acc_descr: None,
            direction: TimelineDirection::Lr,
            sections: Vec::new(),
            periods: Vec::new(),
            current_section: String::new(),
        }
    }

    pub fn set_diagram_title(&mut self, text: &str) {
        self.title = Some(text.to_string());
    }

    pub fn set_acc_title(&mut self, text: &str) {
        self.acc_title = Some(trim_leading_ws(text));
    }

    pub fn set_acc_description(&mut self, text: &str) {
        self.acc_descr = Some(collapse_newline_ws(text));
    }

    pub fn set_direction(&mut self, direction: TimelineDirection) {
        self.direction = direction;
    }

    pub fn add_section(&mut self, text: &str) {
        self.current_section = text.to_string();
        self.sections.push(text.to_string());
    }

    pub fn add_task(&mut self, period: &str, event: Option<&str>) {
        let events = match event {
            Some(e) if !e.is_empty() => vec![e.to_string()],
            _ => Vec::new(),
        };
        self.periods.push(TimelinePeriod {
            text: period.to_string(),
            events,
            section: self.current_section.clone(),
            section_index: self.sections.len() as isize - 1,
        });
    }

    pub fn add_event(&mut self, event: &str) -> Result<(), PeleError> {
        let Some(period) = self.periods.last_mut() else {
            return Err(PeleError::new("An event needs a time period before it.", ErrorCode::Semantic).with_diagram_type(DiagramType::Timeline));
        };
        period.events.push(event.to_string());
        Ok(())
    }
}
