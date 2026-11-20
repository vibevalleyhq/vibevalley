use indexmap::IndexMap;
use serde::{Deserialize, Serialize};

use crate::util::yaml::{YamlValue, merge_yaml_maps};

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct FlowchartConfig {
    pub curve: Option<String>,
    pub node_spacing: Option<f64>,
    pub rank_spacing: Option<f64>,
    pub wrapping_width: Option<f64>,
    pub inherit_dir: bool,
    pub use_max_width: Option<bool>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum MessageAlign {
    Left,
    Center,
    Right,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct SequenceConfig {
    pub wrap: bool,
    pub mirror_actors: Option<bool>,
    pub right_angles: bool,
    pub actor_margin: Option<f64>,
    pub width: Option<f64>,
    pub height: Option<f64>,
    pub message_margin: Option<f64>,
    pub note_margin: Option<f64>,
    pub box_margin: Option<f64>,
    pub message_align: Option<MessageAlign>,
    pub show_sequence_numbers: bool,
    pub hide_unused_participants: bool,
    pub use_max_width: Option<bool>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct PieConfig {
    pub text_position: Option<f64>,
    pub donut_hole: Option<f64>,
    pub legend_position: Option<String>,
    pub use_max_width: Option<bool>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct GanttConfig {
    pub display_mode: Option<String>,
    pub use_max_width: Option<bool>,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct ThemeVariables {
    pub values: IndexMap<String, String>,
    pub xy_plot_color_palette: Option<String>,
}

/// Typed diagram configuration decoded once at the front-matter / directive boundary.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct DiagramConfig {
    pub wrap: Option<bool>,
    pub flowchart: FlowchartConfig,
    pub sequence: SequenceConfig,
    pub pie: PieConfig,
    pub gantt: GanttConfig,
    pub theme_variables: ThemeVariables,
    pub use_max_width_by_section: IndexMap<String, bool>,
    /// Raw YAML sections preserved for diagram families added in parallel slices.
    pub sections: IndexMap<String, IndexMap<String, YamlValue>>,
}

impl DiagramConfig {
    pub fn from_yaml_map(map: &IndexMap<String, YamlValue>) -> Self {
        let mut config = Self::default();
        config.apply_yaml_map(map);
        config
    }

    pub fn merge_over(&mut self, overrides: &DiagramConfig) {
        if overrides.wrap.is_some() {
            self.wrap = overrides.wrap;
        }
        merge_opt(&mut self.flowchart.curve, &overrides.flowchart.curve);
        merge_opt(&mut self.flowchart.node_spacing, &overrides.flowchart.node_spacing);
        merge_opt(&mut self.flowchart.rank_spacing, &overrides.flowchart.rank_spacing);
        merge_opt(&mut self.flowchart.wrapping_width, &overrides.flowchart.wrapping_width);
        if overrides.flowchart.inherit_dir {
            self.flowchart.inherit_dir = true;
        }
        merge_opt(&mut self.flowchart.use_max_width, &overrides.flowchart.use_max_width);

        if overrides.sequence.wrap {
            self.sequence.wrap = true;
        }
        merge_opt(&mut self.sequence.mirror_actors, &overrides.sequence.mirror_actors);
        if overrides.sequence.right_angles {
            self.sequence.right_angles = true;
        }
        merge_opt(&mut self.sequence.actor_margin, &overrides.sequence.actor_margin);
        merge_opt(&mut self.sequence.width, &overrides.sequence.width);
        merge_opt(&mut self.sequence.height, &overrides.sequence.height);
        merge_opt(&mut self.sequence.message_margin, &overrides.sequence.message_margin);
        merge_opt(&mut self.sequence.note_margin, &overrides.sequence.note_margin);
        merge_opt(&mut self.sequence.box_margin, &overrides.sequence.box_margin);
        merge_opt(&mut self.sequence.message_align, &overrides.sequence.message_align);
        if overrides.sequence.show_sequence_numbers {
            self.sequence.show_sequence_numbers = true;
        }
        if overrides.sequence.hide_unused_participants {
            self.sequence.hide_unused_participants = true;
        }
        merge_opt(&mut self.sequence.use_max_width, &overrides.sequence.use_max_width);

        merge_opt(&mut self.pie.text_position, &overrides.pie.text_position);
        merge_opt(&mut self.pie.donut_hole, &overrides.pie.donut_hole);
        merge_opt(&mut self.pie.legend_position, &overrides.pie.legend_position);
        merge_opt(&mut self.pie.use_max_width, &overrides.pie.use_max_width);

        merge_opt(&mut self.gantt.display_mode, &overrides.gantt.display_mode);
        merge_opt(&mut self.gantt.use_max_width, &overrides.gantt.use_max_width);

        for (k, v) in &overrides.theme_variables.values {
            self.theme_variables.values.insert(k.clone(), v.clone());
        }
        merge_opt(
            &mut self.theme_variables.xy_plot_color_palette,
            &overrides.theme_variables.xy_plot_color_palette,
        );

        for (k, v) in &overrides.use_max_width_by_section {
            self.use_max_width_by_section.insert(k.clone(), *v);
        }
        for (sec, entries) in &overrides.sections {
            let target = self.sections.entry(sec.clone()).or_default();
            merge_yaml_maps(target, entries);
        }
    }

    pub fn apply_yaml_map(&mut self, map: &IndexMap<String, YamlValue>) {
        if let Some(w) = map.get("wrap").and_then(YamlValue::as_bool) {
            self.wrap = Some(w);
        }
        if let Some(flow) = map.get("flowchart").and_then(YamlValue::as_map) {
            if let Some(v) = flow.get("curve").and_then(YamlValue::as_str) {
                self.flowchart.curve = Some(v.to_string());
            }
            if let Some(v) = flow.get("nodeSpacing").and_then(YamlValue::as_f64) {
                self.flowchart.node_spacing = Some(v);
            }
            if let Some(v) = flow.get("rankSpacing").and_then(YamlValue::as_f64) {
                self.flowchart.rank_spacing = Some(v);
            }
            if let Some(v) = flow.get("wrappingWidth").and_then(YamlValue::as_f64) {
                self.flowchart.wrapping_width = Some(v);
            }
            if let Some(v) = flow.get("inheritDir").and_then(YamlValue::as_bool) {
                self.flowchart.inherit_dir = v;
            }
            if let Some(v) = flow.get("useMaxWidth").and_then(YamlValue::as_bool) {
                self.flowchart.use_max_width = Some(v);
            }
        }
        if let Some(seq) = map.get("sequence").and_then(YamlValue::as_map) {
            if let Some(v) = seq.get("wrap").and_then(YamlValue::as_bool) {
                self.sequence.wrap = v;
            }
            if let Some(v) = seq.get("mirrorActors").and_then(YamlValue::as_bool) {
                self.sequence.mirror_actors = Some(v);
            }
            if let Some(v) = seq.get("rightAngles").and_then(YamlValue::as_bool) {
                self.sequence.right_angles = v;
            }
            if let Some(v) = seq.get("actorMargin").and_then(YamlValue::as_f64) {
                self.sequence.actor_margin = Some(v);
            }
            if let Some(v) = seq.get("width").and_then(YamlValue::as_f64) {
                self.sequence.width = Some(v);
            }
            if let Some(v) = seq.get("height").and_then(YamlValue::as_f64) {
                self.sequence.height = Some(v);
            }
            if let Some(v) = seq.get("messageMargin").and_then(YamlValue::as_f64) {
                self.sequence.message_margin = Some(v);
            }
            if let Some(v) = seq.get("noteMargin").and_then(YamlValue::as_f64) {
                self.sequence.note_margin = Some(v);
            }
            if let Some(v) = seq.get("boxMargin").and_then(YamlValue::as_f64) {
                self.sequence.box_margin = Some(v);
            }
            if let Some(v) = seq.get("messageAlign").and_then(YamlValue::as_str) {
                self.sequence.message_align = match v {
                    "left" => Some(MessageAlign::Left),
                    "right" => Some(MessageAlign::Right),
                    "center" => Some(MessageAlign::Center),
                    _ => None,
                };
            }
            if let Some(v) = seq.get("showSequenceNumbers").and_then(YamlValue::as_bool) {
                self.sequence.show_sequence_numbers = v;
            }
            if let Some(v) = seq.get("hideUnusedParticipants").and_then(YamlValue::as_bool) {
                self.sequence.hide_unused_participants = v;
            }
            if let Some(v) = seq.get("useMaxWidth").and_then(YamlValue::as_bool) {
                self.sequence.use_max_width = Some(v);
            }
        }
        if let Some(pie) = map.get("pie").and_then(YamlValue::as_map) {
            if let Some(v) = pie.get("textPosition").and_then(YamlValue::as_f64) {
                self.pie.text_position = Some(v);
            }
            if let Some(v) = pie.get("donutHole").and_then(YamlValue::as_f64) {
                self.pie.donut_hole = Some(v);
            }
            if let Some(v) = pie.get("legendPosition").and_then(YamlValue::as_str) {
                self.pie.legend_position = Some(v.to_string());
            }
            if let Some(v) = pie.get("useMaxWidth").and_then(YamlValue::as_bool) {
                self.pie.use_max_width = Some(v);
            }
        }
        if let Some(gantt) = map.get("gantt").and_then(YamlValue::as_map) {
            if let Some(v) = gantt.get("displayMode").and_then(YamlValue::as_str) {
                self.gantt.display_mode = Some(v.to_string());
            }
            if let Some(v) = gantt.get("useMaxWidth").and_then(YamlValue::as_bool) {
                self.gantt.use_max_width = Some(v);
            }
        }
        if let Some(tv) = map.get("themeVariables").and_then(YamlValue::as_map) {
            for (k, v) in tv {
                if k == "xyChart"
                    && let Some(xy) = v.as_map()
                    && let Some(pal) = xy.get("plotColorPalette").and_then(YamlValue::as_str)
                {
                    self.theme_variables.xy_plot_color_palette = Some(pal.to_string());
                } else if let Some(s) = v.as_str() {
                    self.theme_variables.values.insert(k.clone(), s.to_string());
                }
            }
        }
        for (k, v) in map {
            if let Some(sub) = v.as_map() {
                if let Some(umw) = sub.get("useMaxWidth").and_then(YamlValue::as_bool) {
                    self.use_max_width_by_section.insert(k.clone(), umw);
                }
                let entry = self.sections.entry(k.clone()).or_default();
                merge_yaml_maps(entry, sub);
            }
        }
    }

    pub fn section_use_max_width(&self, section: &str) -> Option<bool> {
        match section {
            "flowchart" => self.flowchart.use_max_width,
            "sequence" => self.sequence.use_max_width,
            "pie" => self.pie.use_max_width,
            "gantt" => self.gantt.use_max_width,
            other => self.use_max_width_by_section.get(other).copied(),
        }
    }

    pub fn section(&self, name: &str) -> Option<&IndexMap<String, YamlValue>> {
        self.sections.get(name)
    }
}

fn merge_opt<T: Clone>(target: &mut Option<T>, src: &Option<T>) {
    if let Some(v) = src {
        *target = Some(v.clone());
    }
}
