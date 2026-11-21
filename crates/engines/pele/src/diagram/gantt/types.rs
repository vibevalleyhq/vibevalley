#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GanttRaw {
    pub data: String,
    pub start: Option<String>,
    pub end: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GanttTask {
    pub id: String,
    /// The task's label, under the name Mermaid gives it.
    pub task: String,
    pub section: String,
    /// Unix epoch milliseconds (UTC calendar), unset until scheduled.
    pub start_time: Option<i64>,
    pub end_time: Option<i64>,
    /// Where the bar ends when excluded days pushed the task's end out; `None` when end was a manual date.
    pub render_end_time: Option<i64>,
    pub manual_end_time: bool,
    pub processed: bool,
    pub active: bool,
    pub done: bool,
    pub crit: bool,
    pub milestone: bool,
    pub vert: bool,
    /// Row index in source order; `-1` for vertical markers, which take no row.
    pub order: isize,
    pub classes: Vec<String>,
    pub prev_task_id: Option<String>,
    pub raw: GanttRaw,
}
