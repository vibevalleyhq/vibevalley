use std::collections::HashMap;

use crate::config::DiagramConfig;
use crate::detect::{Detected, DiagramType, MermaidType, detect_diagram};
use crate::error::{ErrorCode, PeleError, SourceMap};
use crate::measure::{METRICS_MEASURER, TextMeasurer};
use crate::preprocess::{encode_entities, preprocess};
use crate::svg::palette::palette_overrides;
use crate::svg::theme::SvgTheme;
use crate::text::entities::decode_entities;
use crate::{IconResolver, ParseOptions, RenderOptions, RenderResult, Rendered};

use super::{
    DEFAULT_LIMIT, DEFAULT_MAX_EDGES, DEFAULT_OUTPUT_LIMIT, DiagramSpec, ParseContext, ParsedModel, RenderContext, agentflow, architecture, block, c4, class,
    cynefin, er, eventmodeling, flowchart, gantt, git, info, ishikawa, journey, kanban, mindmap, packet, pie, quadrant, radar, railroad, requirement, sankey,
    sequence, state, swimlane, timeline, treemap, treeview, usecase, venn, wardley, xychart,
};

impl ParsedModel {
    pub const fn diagram_type(&self) -> DiagramType {
        match self {
            Self::Flowchart(_) => DiagramType::Flowchart,
            Self::Sequence(_) => DiagramType::Sequence,
            Self::Pie(_) => DiagramType::Pie,
            Self::Class(_) => DiagramType::Class,
            Self::State(_) => DiagramType::State,
            Self::Er(_) => DiagramType::Er,
            Self::Requirement(_) => DiagramType::Requirement,
            Self::Usecase(_) => DiagramType::Usecase,
            Self::Architecture(_) => DiagramType::Architecture,
            Self::Swimlane(_) => DiagramType::Swimlane,
            Self::Agentflow(_) => DiagramType::Agentflow,
            Self::Block(_) => DiagramType::Block,
            Self::Gantt(_) => DiagramType::Gantt,
            Self::C4(_) => DiagramType::C4,
            Self::GitGraph(_) => DiagramType::GitGraph,
            Self::EventModeling(_) => DiagramType::EventModeling,
            Self::Timeline(_) => DiagramType::Timeline,
            Self::Journey(_) => DiagramType::Journey,
            Self::XyChart(_) => DiagramType::XyChart,
            Self::QuadrantChart(_) => DiagramType::QuadrantChart,
            Self::Radar(_) => DiagramType::Radar,
            Self::Sankey(_) => DiagramType::Sankey,
            Self::Venn(_) => DiagramType::Venn,
            Self::Wardley(_) => DiagramType::Wardley,
            Self::Railroad(_) => DiagramType::Railroad,
            Self::TreeView(_) => DiagramType::TreeView,
            Self::Treemap(_) => DiagramType::Treemap,
            Self::Cynefin(_) => DiagramType::Cynefin,
            Self::Ishikawa(_) => DiagramType::Ishikawa,
            Self::Kanban(_) => DiagramType::Kanban,
            Self::Mindmap(_) => DiagramType::Mindmap,
            Self::Packet(_) => DiagramType::Packet,
            Self::Info(_) => DiagramType::Info,
        }
    }

    pub fn render(&self, ctx: &RenderContext<'_>) -> Result<Rendered, PeleError> {
        match self {
            Self::Flowchart(db) => Ok(flowchart::render_flowchart(db, ctx, None)),
            Self::Sequence(db) => Ok(sequence::render_sequence(db, ctx)),
            Self::Pie(model) => Ok(pie::render::render_pie(model, ctx)),
            Self::Class(db) => Ok(class::render_class(db, ctx)),
            Self::State(db) => Ok(state::render_state(db, ctx)),
            Self::Er(db) => Ok(er::render_er(db, ctx)),
            Self::Requirement(db) => Ok(requirement::render_requirement(db, ctx)),
            Self::Usecase(model) => Ok(usecase::render_usecase(model, ctx)),
            Self::Architecture(db) => Ok(architecture::render_architecture(db, ctx)),
            Self::Swimlane(db) => Ok(swimlane::render_swimlane(db, ctx)),
            Self::Agentflow(db) => Ok(agentflow::render_agentflow(db, ctx)),
            Self::Block(db) => Ok(block::render_block(db, ctx)),
            Self::Gantt(db) => gantt::render::try_render_gantt(db, ctx),
            Self::C4(db) => c4::render::try_render_c4(db, ctx),
            Self::GitGraph(model) => Ok(git::render::render_git(model, ctx)),
            Self::EventModeling(model) => Ok(eventmodeling::render::render_event_model(model, ctx)),
            Self::Timeline(model) => Ok(timeline::render::render_timeline(model, ctx)),
            Self::Journey(model) => Ok(journey::render::render_journey(model, ctx)),
            Self::XyChart(model) => xychart::render::render_xychart(model, ctx),
            Self::QuadrantChart(model) => Ok(quadrant::render::render_quadrant(model, ctx)),
            Self::Radar(model) => Ok(radar::render::render_radar(model, ctx)),
            Self::Sankey(model) => sankey::render::render_sankey(model, ctx),
            Self::Venn(model) => Ok(venn::render::render_venn(model, ctx)),
            Self::Wardley(model) => Ok(wardley::render::render_wardley(model, ctx)),
            Self::Railroad(model) => Ok(railroad::render::render_railroad(model, ctx)),
            Self::TreeView(model) => Ok(treeview::render::render_tree_view(model, ctx)),
            Self::Treemap(model) => Ok(treemap::render::render_treemap(model, ctx)),
            Self::Cynefin(model) => Ok(cynefin::render::render_cynefin(model, ctx)),
            Self::Ishikawa(model) => Ok(ishikawa::render::render_ishikawa(model, ctx)),
            Self::Kanban(model) => Ok(kanban::render::render_kanban(model, ctx)),
            Self::Mindmap(model) => Ok(mindmap::render::render_mindmap(model, ctx)),
            Self::Packet(model) => Ok(packet::render::render_packet(model, ctx)),
            Self::Info(model) => Ok(info::render::render_info(model, ctx)),
        }
    }
}

#[derive(Debug, Clone)]
pub struct ParsedDiagram {
    pub diagram_type: DiagramType,
    pub mermaid_type: MermaidType,
    pub model: ParsedModel,
    pub config: DiagramConfig,
    pub section_name: Option<&'static str>,
    pub supports_math: bool,
}

pub struct Registry {
    diagrams: HashMap<DiagramType, Box<dyn DiagramSpec>>,
}

impl Default for Registry {
    fn default() -> Self {
        Self::with_builtins()
    }
}

impl Registry {
    pub fn new() -> Self {
        Self { diagrams: HashMap::new() }
    }

    pub fn with_builtins() -> Self {
        let mut reg = Self::new();
        reg.register(Box::new(flowchart::FlowchartDiagram));
        reg.register(Box::new(sequence::SequenceDiagram));
        reg.register(Box::new(pie::PieDiagram));
        reg.register(Box::new(class::ClassDiagram));
        reg.register(Box::new(state::StateDiagram));
        reg.register(Box::new(er::ErDiagram));
        reg.register(Box::new(requirement::RequirementDiagram));
        reg.register(Box::new(usecase::UsecaseDiagram));
        reg.register(Box::new(architecture::ArchitectureDiagram));
        reg.register(Box::new(swimlane::SwimlaneDiagram));
        reg.register(Box::new(agentflow::AgentflowDiagram));
        reg.register(Box::new(block::BlockDiagram));
        reg.register(Box::new(gantt::GanttDiagram));
        reg.register(Box::new(c4::C4Diagram));
        reg.register(Box::new(git::GitGraphDiagram));
        reg.register(Box::new(eventmodeling::EventModelingDiagram));
        reg.register(Box::new(timeline::TimelineDiagram));
        reg.register(Box::new(journey::JourneyDiagram));
        reg.register(Box::new(xychart::XyChartDiagram));
        reg.register(Box::new(quadrant::QuadrantDiagram));
        reg.register(Box::new(radar::RadarDiagram));
        reg.register(Box::new(sankey::SankeyDiagram));
        reg.register(Box::new(venn::VennDiagram));
        reg.register(Box::new(wardley::WardleyDiagram));
        reg.register(Box::new(railroad::RailroadDiagram));
        reg.register(Box::new(treeview::TreeViewDiagram));
        reg.register(Box::new(treemap::TreemapDiagram));
        reg.register(Box::new(cynefin::CynefinDiagram));
        reg.register(Box::new(ishikawa::IshikawaDiagram));
        reg.register(Box::new(kanban::KanbanDiagram));
        reg.register(Box::new(mindmap::MindmapDiagram));
        reg.register(Box::new(packet::PacketDiagram));
        reg.register(Box::new(info::InfoDiagram));
        reg
    }

    pub fn register(&mut self, spec: Box<dyn DiagramSpec>) {
        self.diagrams.insert(spec.diagram_type(), spec);
    }

    pub fn registered(&self, diagram_type: DiagramType) -> bool {
        self.diagrams.contains_key(&diagram_type)
    }

    pub fn detect_type(&self, text: &str) -> Option<DiagramType> {
        let pre = preprocess(text, None).ok()?;
        detect_diagram(&pre.text).map(|d| d.diagram_type)
    }

    pub fn supports(&self, text: &str) -> bool {
        self.detect_type(text).is_some_and(|dt| self.diagrams.contains_key(&dt))
    }

    pub fn parse(&self, text: &str, options: &ParseOptions) -> Result<ParsedDiagram, PeleError> {
        let limit = options.limit.unwrap_or(DEFAULT_LIMIT);
        if text.chars().count() > limit {
            return Err(PeleError::new(
                format!("Diagram source is longer than the limit of {limit} characters."),
                ErrorCode::Limit,
            ));
        }
        let pre = preprocess(text, None)?;
        let Some(found) = detect_diagram(&pre.text) else {
            return Err(PeleError::new("No diagram type detected for the given text.", ErrorCode::UnsupportedDiagram));
        };
        let Some(diagram) = self.diagrams.get(&found.diagram_type) else {
            return Err(PeleError::new(
                format!("Diagram type \"{}\" is not supported yet.", found.diagram_type.as_str()),
                ErrorCode::UnsupportedDiagram,
            )
            .with_detected(found));
        };
        let config = match &options.config {
            Some(extra) => {
                let mut merged = extra.clone();
                merged.merge_over(&pre.config);
                merged
            }
            None => pre.config,
        };
        let keep_comments = diagram.keep_comments();
        let body = if keep_comments { &pre.with_comments } else { &pre.text };
        let mut parsed_src = encode_entities(body, None);
        parsed_src.push('\n');
        let origin = SourceMap::new(&parsed_src, text, keep_comments);
        let ctx = ParseContext {
            config: &config,
            title: pre.title.as_deref(),
            line_offset: pre.line_offset,
            max_edges: options.max_edges.unwrap_or(DEFAULT_MAX_EDGES),
            origin: Some(&origin),
        };
        let model = diagram.parse_model(&parsed_src, &ctx).map_err(|e| tag_error(e, found))?;
        Ok(ParsedDiagram {
            diagram_type: found.diagram_type,
            mermaid_type: found.mermaid_type,
            model,
            config,
            section_name: diagram.section_name(),
            supports_math: diagram.supports_math(),
        })
    }

    pub fn render_model(&self, parsed: &ParsedDiagram, options: &RenderOptions<'_>) -> Result<RenderResult, PeleError> {
        let section = parsed.section_name.unwrap_or_else(|| parsed.diagram_type.as_str());
        let fixed = parsed.config.section_use_max_width(section) == Some(false);
        let responsive = options.responsive.unwrap_or(!fixed);
        let theme = SvgTheme::new(options.theme_mode.clone(), options.font_family.as_deref(), options.font_family_mono.as_deref());
        let palette = palette_overrides(parsed.diagram_type, &parsed.config.theme_variables);
        let measurer: &dyn TextMeasurer = options.measurer.unwrap_or(&METRICS_MEASURER);
        let wrapped_icons = options.icons.map(|f| move |name: &str| f(&decode_entities(name)));
        let icons_ref: Option<&IconResolver<'_>> = wrapped_icons.as_ref().map(|f| f as &IconResolver<'_>);
        let math_ref = if parsed.supports_math { options.math } else { None };
        let ctx = RenderContext {
            config: &parsed.config,
            options,
            responsive,
            theme: &theme,
            palette: &palette,
            measurer,
            icons: icons_ref,
            math: math_ref,
        };
        let found = Detected {
            diagram_type: parsed.diagram_type,
            mermaid_type: parsed.mermaid_type,
        };
        let mut rendered = parsed.model.render(&ctx).map_err(|e| tag_error(e, found))?;
        let output_limit = options.output_limit.unwrap_or(DEFAULT_OUTPUT_LIMIT);
        if rendered.svg.len() > output_limit {
            return Err(PeleError::new(
                format!("Diagram output is longer than the limit of {output_limit} characters."),
                ErrorCode::Limit,
            )
            .with_detected(found));
        }
        for link in &mut rendered.links {
            link.id = decode_entities(&link.id);
        }
        Ok(RenderResult {
            diagram_type: parsed.diagram_type,
            mermaid_type: parsed.mermaid_type,
            svg: rendered.svg,
            width: rendered.width,
            height: rendered.height,
            links: rendered.links,
        })
    }

    pub fn render(&self, text: &str, options: &RenderOptions<'_>) -> Result<RenderResult, PeleError> {
        let parse_opts = ParseOptions {
            limit: options.limit,
            max_edges: options.max_edges,
            config: options.config.clone(),
        };
        let parsed = self.parse(text, &parse_opts)?;
        self.render_model(&parsed, options)
    }
}

fn tag_error(error: PeleError, found: Detected) -> PeleError {
    error.with_detected(found).restore_written_codes()
}
