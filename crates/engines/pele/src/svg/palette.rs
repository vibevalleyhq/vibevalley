use crate::config::ThemeVariables;
use crate::detect::DiagramType;
use crate::svg::builder::esc;
use crate::svg::ink::{InkTone, ink_tone, plain_color};
use crate::svg::theme::SvgTheme;
use crate::util::chars::is_word;

const SLOTS: usize = 8;

#[derive(Debug, Clone, Default, PartialEq)]
pub struct PaletteOverrides {
    pub style: String,
    pub colors: [Option<String>; SLOTS],
    pub inks: [Option<InkTone>; SLOTS],
}

impl PaletteOverrides {
    pub fn series_ink_fill(&self, index: usize, theme: &SvgTheme) -> String {
        match self.inks[index % SLOTS] {
            Some(tone) => format!(r#" fill="{}""#, tone.paint(theme)),
            None => String::new(),
        }
    }
}

fn is_allowed_color_fn(name: &str) -> bool {
    matches!(
        name,
        "rgb" | "rgba" | "hsl" | "hsla" | "hwb" | "lab" | "lch" | "oklab" | "oklch" | "color" | "color-mix" | "light-dark" | "var"
    )
}

fn is_safe_color_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c.is_whitespace() || matches!(c, '_' | '#' | '%' | '.' | ',' | '+' | '-' | '/' | '(' | ')')
}

fn safe_color(raw: &str) -> Option<String> {
    let color = raw.trim();
    if color.is_empty() || color.len() > 200 || !color.chars().all(is_safe_color_char) {
        return None;
    }
    if !color.contains('(') {
        return plain_color(color).then(|| color.to_string());
    }
    let mut depth: i32 = 0;
    for ch in color.chars() {
        if ch == '(' {
            depth += 1;
        } else if ch == ')' {
            depth -= 1;
            if depth < 0 {
                return None;
            }
        }
    }
    if depth != 0 {
        return None;
    }
    let bytes = color.as_bytes();
    for (idx, &b) in bytes.iter().enumerate() {
        if b == b'(' {
            let mut end = idx;
            while end > 0 && bytes[end - 1].is_ascii_whitespace() {
                end -= 1;
            }
            let mut start = end;
            while start > 0 && (is_word(bytes[start - 1] as u32) || bytes[start - 1] == b'-') {
                start -= 1;
            }
            let fn_name = color[start..end].to_ascii_lowercase();
            if !is_allowed_color_fn(&fn_name) {
                return None;
            }
            if fn_name == "var" {
                let rest = color[idx + 1..].trim_start();
                if !rest.starts_with("--pele-") {
                    return None;
                }
            }
        }
    }
    Some(color.to_string())
}

fn split_color_list(value: &str) -> Vec<String> {
    let mut parts = Vec::new();
    let mut depth = 0i32;
    let mut start = 0usize;
    for (idx, ch) in value.char_indices() {
        match ch {
            '(' => depth += 1,
            ')' => depth -= 1,
            ',' if depth == 0 => {
                parts.push(value[start..idx].trim().to_string());
                start = idx + 1;
            }
            _ => {}
        }
    }
    parts.push(value[start..].trim().to_string());
    parts
}

struct PaletteSpec {
    prefix: &'static str,
    first: usize,
    repeat: bool,
}

fn palette_spec(diagram_type: DiagramType) -> Option<PaletteSpec> {
    match diagram_type {
        DiagramType::Pie => Some(PaletteSpec {
            prefix: "pie",
            first: 1,
            repeat: false,
        }),
        DiagramType::GitGraph => Some(PaletteSpec {
            prefix: "git",
            first: 0,
            repeat: false,
        }),
        DiagramType::Timeline | DiagramType::Radar | DiagramType::Treemap => Some(PaletteSpec {
            prefix: "cScale",
            first: 0,
            repeat: false,
        }),
        DiagramType::Mindmap => Some(PaletteSpec {
            prefix: "cScale",
            first: 1,
            repeat: false,
        }),
        DiagramType::Venn => Some(PaletteSpec {
            prefix: "venn",
            first: 1,
            repeat: true,
        }),
        DiagramType::Flowchart
        | DiagramType::Sequence
        | DiagramType::Class
        | DiagramType::State
        | DiagramType::Er
        | DiagramType::Gantt
        | DiagramType::Journey
        | DiagramType::XyChart
        | DiagramType::QuadrantChart
        | DiagramType::Requirement
        | DiagramType::C4
        | DiagramType::Sankey
        | DiagramType::Block
        | DiagramType::Packet
        | DiagramType::Kanban
        | DiagramType::Architecture
        | DiagramType::Info
        | DiagramType::Agentflow
        | DiagramType::Usecase
        | DiagramType::Railroad
        | DiagramType::TreeView
        | DiagramType::Cynefin
        | DiagramType::Wardley
        | DiagramType::Swimlane
        | DiagramType::Ishikawa
        | DiagramType::EventModeling => None,
    }
}

pub fn palette_overrides(diagram_type: DiagramType, vars: &ThemeVariables) -> PaletteOverrides {
    let (list, repeat): (Vec<Option<String>>, bool) = if diagram_type == DiagramType::XyChart {
        let Some(pal) = &vars.xy_plot_color_palette else {
            return PaletteOverrides::default();
        };
        (split_color_list(pal).into_iter().map(Some).collect(), true)
    } else {
        let Some(spec) = palette_spec(diagram_type) else {
            return PaletteOverrides::default();
        };
        let mut items: Vec<Option<String>> = (0..SLOTS)
            .map(|i| vars.values.get(&format!("{}{}", spec.prefix, spec.first + i)).cloned())
            .collect();
        if spec.repeat {
            items.retain(|v| v.as_deref().is_some_and(|s| !s.is_empty()));
        }
        (items, spec.repeat)
    };
    if list.is_empty() {
        return PaletteOverrides::default();
    }
    let mut style = String::new();
    let mut colors: [Option<String>; SLOTS] = Default::default();
    let mut inks: [Option<InkTone>; SLOTS] = Default::default();
    for i in 0..SLOTS {
        if !repeat && i >= list.len() {
            break;
        }
        let Some(raw) = &list[i % list.len()] else {
            continue;
        };
        let Some(color) = safe_color(raw) else {
            continue;
        };
        style.push_str(&format!(";--pele-series-{}:{color}", i + 1));
        inks[i] = ink_tone(&format!(";fill:{color}"), "");
        colors[i] = Some(color);
    }
    if style.is_empty() {
        PaletteOverrides::default()
    } else {
        PaletteOverrides {
            style: esc(&style),
            colors,
            inks,
        }
    }
}
