use crate::detect::DiagramType;
use crate::diagram::flowchart::graph::{FlowGraph, GraphNode};
use crate::diagram::flowchart::types::LabelType;
use crate::diagram::flowchart::{self, FlowDb, FlowDbOptions, FlowVariant, render_flowchart};
use crate::diagram::{DiagramSpec, ParseContext, ParsedModel, RenderContext};
use crate::error::PeleError;
use crate::layout::compound::{CEdge, CNode, CompoundResult, Dir};
use crate::layout::lanes::lane_layout;
use crate::layout::layered::LayeredOptions;
use crate::svg::builder::{label_svg, num};
use crate::svg::ink::ink_fill;
use crate::svg::theme::{ResolvedStyle, SvgTheme};
use crate::text::label::Label;
use crate::{IconResolver, Rendered};

const DEFAULT_LANE: &str = "__swimlane_default__";

struct SwimlaneVariant;

impl FlowVariant for SwimlaneVariant {
    fn diagram_type(&self) -> &'static str {
        "swimlane"
    }

    fn prepare(&self, graph: &mut FlowGraph) {
        let mut loose = false;
        for node in &mut graph.nodes {
            if node.is_group {
                node.dir = None;
            } else if node.parent_id.is_none() {
                loose = true;
            }
        }
        if !loose {
            return;
        }
        for node in &mut graph.nodes {
            if !node.is_group && node.parent_id.is_none() {
                node.parent_id = Some(DEFAULT_LANE.to_string());
            }
        }
        graph.nodes.push(GraphNode {
            id: DEFAULT_LANE.to_string(),
            label: None,
            label_type: LabelType::Text,
            shape: "rect".to_string(),
            is_group: true,
            parent_id: None,
            css_styles: Vec::new(),
            css_compiled_styles: Vec::new(),
            css_classes: String::new(),
            dir: None,
            link: None,
            link_target: None,
            tooltip: None,
            icon: None,
            pos: None,
            img: None,
            asset_width: None,
            asset_height: None,
            constraint: None,
            color_index: None,
            metadata: None,
        });
    }

    fn layout(&self, nodes: &mut [CNode], edges: &mut [CEdge], dir: Dir, opt: &LayeredOptions, tight: bool) -> CompoundResult {
        lane_layout(nodes, edges, dir, opt, if tight { Some(12.0) } else { None })
    }

    fn draw_group(
        &self,
        c: &CNode,
        label: &Label,
        style: &ResolvedStyle,
        classes: &str,
        id: &str,
        dir: Dir,
        theme: &SvgTheme,
        icons: Option<&IconResolver<'_>>,
    ) -> Option<String> {
        let left = c.x - c.w / 2.0;
        let top = c.y - c.h / 2.0;
        let sideways = dir == Dir::LR || dir == Dir::RL;
        let cx = if sideways { left + c.pad_top / 2.0 } else { c.x };
        let cy = if sideways { c.y } else { top + c.pad_top / 2.0 };
        let ink = ink_fill(&style.shape, &style.text, theme, Some(theme.muted()));
        let text = label_svg(label, cx, cy, &format!(r#" class="pele-cluster-label"{ink}{}"#, style.text), theme, icons);
        let title_part = if sideways && !text.is_empty() {
            format!(r#"<g transform="rotate(-90 {} {})">{text}</g>"#, num(cx), num(cy))
        } else {
            text
        };
        let band_w = if sideways { c.pad_top } else { c.w };
        let band_h = if sideways { c.h } else { c.pad_top };
        Some(format!(
            r#"<g class="pele-cluster pele-lane{classes}" data-id="{id}"><rect x="{}" y="{}" width="{}" height="{}" fill="none" stroke="{}"/><rect x="{}" y="{}" width="{}" height="{}" fill="{}" stroke="{}"{}/>{title_part}</g>"#,
            num(left),
            num(top),
            num(c.w),
            num(c.h),
            theme.border(),
            num(left),
            num(top),
            num(band_w),
            num(band_h),
            theme.surface_alt(),
            theme.border(),
            style.shape,
        ))
    }

    fn filled_box(&self, c: &CNode, dir: Dir) -> Option<[f64; 4]> {
        let left = c.x - c.w / 2.0;
        let top = c.y - c.h / 2.0;
        Some(if dir == Dir::LR || dir == Dir::RL {
            [left, top, left + c.pad_top, top + c.h]
        } else {
            [left, top, left + c.w, top + c.pad_top]
        })
    }
}

pub fn render_swimlane(db: &FlowDb, ctx: &RenderContext<'_>) -> Rendered {
    render_flowchart(db, ctx, Some(&SwimlaneVariant))
}

pub struct SwimlaneDiagram;

impl DiagramSpec for SwimlaneDiagram {
    fn diagram_type(&self) -> DiagramType {
        DiagramType::Swimlane
    }

    fn supports_math(&self) -> bool {
        true
    }

    fn parse_model(&self, src: &str, ctx: &ParseContext<'_>) -> Result<ParsedModel, PeleError> {
        let mut db = FlowDb::new(FlowDbOptions {
            max_edges: Some(ctx.max_edges),
            inherit_dir: ctx.config.flowchart.inherit_dir,
            direction: None,
        });
        if let Some(title) = ctx.title
            && !title.is_empty()
        {
            db.title = Some(title.to_string());
        }
        flowchart::parser::parse_flowchart(src, &mut db, ctx.origin).map_err(|e| e.with_diagram_type(DiagramType::Swimlane))?;
        Ok(ParsedModel::Swimlane(db))
    }
}
