pub mod agentflow;
pub mod architecture;
pub mod block;
pub mod c4;
pub mod class;
pub mod common;
pub mod cynefin;
mod dispatch;
pub mod er;
pub mod eventmodeling;
pub mod flowchart;
pub mod gantt;
pub mod git;
pub mod info;
pub mod ishikawa;
pub mod journey;
pub mod kanban;
pub mod mindmap;
pub mod packet;
pub mod pie;
pub mod quadrant;
pub mod radar;
pub mod railroad;
pub mod requirement;
pub mod sankey;
pub mod sequence;
pub mod state;
pub mod swimlane;
pub mod timeline;
pub mod treemap;
pub mod treeview;
pub mod usecase;
pub mod venn;
pub mod wardley;
pub mod xychart;

pub use dispatch::{ParsedDiagram, Registry};

use crate::config::DiagramConfig;
use crate::detect::DiagramType;
use crate::error::{PeleError, SourceMap};
use crate::measure::TextMeasurer;
use crate::svg::palette::PaletteOverrides;
use crate::svg::theme::SvgTheme;
use crate::{IconResolver, MathResolver, RenderOptions};

pub const DEFAULT_LIMIT: usize = 50_000;
pub const DEFAULT_OUTPUT_LIMIT: usize = 4_000_000;
pub const DEFAULT_MAX_EDGES: usize = 5_000;

pub struct ParseContext<'a> {
    pub config: &'a DiagramConfig,
    pub title: Option<&'a str>,
    pub line_offset: usize,
    pub max_edges: usize,
    pub origin: Option<&'a SourceMap<'a>>,
}

pub struct RenderContext<'a> {
    pub config: &'a DiagramConfig,
    pub options: &'a RenderOptions<'a>,
    pub responsive: bool,
    pub theme: &'a SvgTheme,
    pub palette: &'a PaletteOverrides,
    pub measurer: &'a dyn TextMeasurer,
    pub icons: Option<&'a IconResolver<'a>>,
    pub math: Option<&'a MathResolver<'a>>,
}

/// Strongly typed parsed diagram models for all registered built-in diagram families.
#[derive(Debug, Clone)]
pub enum ParsedModel {
    Flowchart(flowchart::FlowDb),
    Sequence(sequence::SeqDb),
    Pie(pie::PieModel),
    Class(class::ClassDb),
    State(state::StateDb),
    Er(er::ErDb),
    Requirement(requirement::RequirementDb),
    Usecase(usecase::UsecaseModel),
    Architecture(architecture::ArchitectureDb),
    Swimlane(flowchart::FlowDb),
    Agentflow(Box<agentflow::AgentflowDb>),
    Block(block::BlockDb),
    Gantt(gantt::GanttDb),
    C4(c4::C4Db),
    GitGraph(git::GitModel),
    EventModeling(eventmodeling::EventModelingModel),
    Timeline(timeline::TimelineModel),
    Journey(journey::JourneyModel),
    XyChart(xychart::XyChartModel),
    QuadrantChart(quadrant::QuadrantModel),
    Radar(radar::RadarModel),
    Sankey(sankey::SankeyModel),
    Venn(venn::VennModel),
    Wardley(wardley::WardleyModel),
    Railroad(railroad::RailroadModel),
    TreeView(treeview::TreeViewModel),
    Treemap(treemap::TreemapModel),
    Cynefin(cynefin::CynefinModel),
    Ishikawa(ishikawa::IshikawaModel),
    Kanban(kanban::KanbanModel),
    Mindmap(mindmap::MindmapModel),
    Packet(packet::PacketModel),
    Info(info::InfoModel),
}

/// Trait implemented by each diagram family so the registry can parse and dispatch uniformly.
pub trait DiagramSpec: Send + Sync {
    fn diagram_type(&self) -> DiagramType;

    fn section_name(&self) -> Option<&'static str> {
        None
    }

    fn keep_comments(&self) -> bool {
        false
    }

    fn supports_math(&self) -> bool {
        false
    }

    fn parse_model(&self, src: &str, ctx: &ParseContext<'_>) -> Result<ParsedModel, PeleError>;
}
