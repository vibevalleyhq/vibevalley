#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum XyTextKind {
    Text,
    Markdown,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct XyText {
    pub text: String,
    pub kind: XyTextKind,
}

impl XyText {
    pub fn plain(text: impl Into<String>) -> Self {
        Self {
            text: text.into(),
            kind: XyTextKind::Text,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct DataPoint {
    pub value: f64,
    pub label: String,
}

#[derive(Debug, Clone, PartialEq)]
pub enum XyAxis {
    Band { title: String, categories: Vec<String> },
    Linear { title: String, min: f64, max: f64 },
}

impl XyAxis {
    pub fn title(&self) -> &str {
        match self {
            Self::Band { title, .. } | Self::Linear { title, .. } => title,
        }
    }

    pub fn set_title(&mut self, new_title: String) {
        match self {
            Self::Band { title, .. } | Self::Linear { title, .. } => *title = new_title,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Orientation {
    Vertical,
    Horizontal,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PlotKind {
    Line,
    Bar,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Plot {
    pub kind: PlotKind,
    pub title: String,
    pub data: Vec<(String, Option<f64>)>,
    pub point_labels: Option<Vec<String>>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct XyChartModel {
    pub title: Option<String>,
    pub acc_title: Option<String>,
    pub acc_descr: Option<String>,
    pub orientation: Option<Orientation>,
    pub x_axis: XyAxis,
    pub y_axis_title: String,
    pub y_min: f64,
    pub y_max: f64,
    pub has_set_x_axis: bool,
    pub has_set_y_axis: bool,
    pub plots: Vec<Plot>,
}

impl Default for XyChartModel {
    fn default() -> Self {
        Self::new()
    }
}

impl XyChartModel {
    pub fn new() -> Self {
        Self {
            title: None,
            acc_title: None,
            acc_descr: None,
            orientation: None,
            x_axis: XyAxis::Band {
                title: String::new(),
                categories: Vec::new(),
            },
            y_axis_title: String::new(),
            y_min: f64::INFINITY,
            y_max: f64::NEG_INFINITY,
            has_set_x_axis: false,
            has_set_y_axis: false,
            plots: Vec::new(),
        }
    }

    pub fn set_orientation(&mut self, raw: &str) {
        self.orientation = Some(if raw == "horizontal" {
            Orientation::Horizontal
        } else {
            Orientation::Vertical
        });
    }

    pub fn set_x_axis_title(&mut self, title: XyText) {
        self.x_axis.set_title(title.text.trim().to_string());
    }

    pub fn set_x_axis_range_data(&mut self, min: f64, max: f64) {
        let title = self.x_axis.title().to_string();
        self.x_axis = XyAxis::Linear { title, min, max };
        self.has_set_x_axis = true;
    }

    pub fn set_x_axis_band(&mut self, categories: Vec<XyText>) {
        let title = self.x_axis.title().to_string();
        self.x_axis = XyAxis::Band {
            title,
            categories: categories.into_iter().map(|c| c.text.trim().to_string()).collect(),
        };
        self.has_set_x_axis = true;
    }

    pub fn set_y_axis_title(&mut self, title: XyText) {
        self.y_axis_title = title.text.trim().to_string();
    }

    pub fn set_y_axis_range_data(&mut self, min: f64, max: f64) {
        self.y_min = min;
        self.y_max = max;
        self.has_set_y_axis = true;
    }

    fn plot_data(&mut self, mut values: Vec<f64>) -> Vec<(String, Option<f64>)> {
        if values.is_empty() {
            return Vec::new();
        }
        if !self.has_set_x_axis {
            self.set_x_axis_range_data(1.0, values.len() as f64);
        }
        if let XyAxis::Band { categories, .. } = &self.x_axis
            && values.len() > categories.len()
        {
            values.truncate(categories.len());
        }
        if !self.has_set_y_axis {
            for &value in &values {
                if value < self.y_min {
                    self.y_min = value;
                }
                if value > self.y_max {
                    self.y_max = value;
                }
            }
        }
        match &self.x_axis {
            XyAxis::Band { categories, .. } => categories.iter().enumerate().map(|(i, cat)| (cat.clone(), values.get(i).copied())).collect(),
            XyAxis::Linear { min, max, .. } => {
                if values.len() == 1 {
                    return vec![(js_number_string(*min), Some(values[0]))];
                }
                let step = (*max - *min) / ((values.len() - 1) as f64);
                values
                    .iter()
                    .enumerate()
                    .map(|(i, &v)| (js_number_string(*min + (i as f64) * step), Some(v)))
                    .collect()
            }
        }
    }

    fn add_plot(&mut self, kind: PlotKind, title: XyText, data: Vec<DataPoint>) {
        let values: Vec<f64> = data.iter().map(|d| d.value).collect();
        let plot_data = self.plot_data(values);
        let point_labels = if kind == PlotKind::Line && data.iter().any(|d| !d.label.trim().is_empty()) {
            Some(data.into_iter().map(|d| d.label.trim().to_string()).collect())
        } else {
            None
        };
        self.plots.push(Plot {
            kind,
            title: title.text.trim().to_string(),
            data: plot_data,
            point_labels,
        });
    }

    pub fn set_line_data(&mut self, title: XyText, data: Vec<DataPoint>) {
        self.add_plot(PlotKind::Line, title, data);
    }

    pub fn set_bar_data(&mut self, title: XyText, data: Vec<DataPoint>) {
        self.add_plot(PlotKind::Bar, title, data);
    }

    pub fn set_diagram_title(&mut self, text: String) {
        self.title = Some(text);
    }

    pub fn set_acc_title(&mut self, text: &str) {
        self.acc_title = Some(text.trim_start().to_string());
    }

    pub fn set_acc_description(&mut self, text: &str) {
        let mut out = String::with_capacity(text.len());
        let mut lines = text.split('\n');
        if let Some(first) = lines.next() {
            out.push_str(first);
            for line in lines {
                out.push('\n');
                out.push_str(line.trim_start());
            }
        }
        self.acc_descr = Some(out);
    }
}

/// Formats finite numbers matching ECMAScript `String(value)` (scientific notation outside `[1e-6, 1e21)`).
pub fn js_number_string(value: f64) -> String {
    if value.is_nan() {
        return "NaN".to_string();
    }
    if value.is_infinite() {
        return if value.is_sign_negative() { "-Infinity" } else { "Infinity" }.to_string();
    }
    if value == 0.0 {
        return "0".to_string();
    }
    let abs = value.abs();
    if !(1e-6..1e21).contains(&abs) {
        let s = format!("{value:e}");
        if let Some(at) = s.find('e') {
            let (mant, exp) = s.split_at(at + 1);
            if !exp.starts_with('-') && !exp.starts_with('+') {
                return format!("{mant}+{exp}");
            }
        }
        return s;
    }
    format!("{value}")
}
