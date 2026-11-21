use serde::{Deserialize, Serialize};

use crate::util::chars::is_word;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum DiagramType {
    Flowchart,
    Sequence,
    Class,
    State,
    Er,
    Pie,
    Gantt,
    GitGraph,
    Mindmap,
    Timeline,
    Journey,
    XyChart,
    QuadrantChart,
    Requirement,
    C4,
    Sankey,
    Block,
    Packet,
    Kanban,
    Architecture,
    Radar,
    Treemap,
    Info,
    Agentflow,
    Usecase,
    Railroad,
    TreeView,
    Venn,
    Cynefin,
    Wardley,
    Swimlane,
    Ishikawa,
    EventModeling,
}

impl DiagramType {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Flowchart => "flowchart",
            Self::Sequence => "sequence",
            Self::Class => "class",
            Self::State => "state",
            Self::Er => "er",
            Self::Pie => "pie",
            Self::Gantt => "gantt",
            Self::GitGraph => "gitGraph",
            Self::Mindmap => "mindmap",
            Self::Timeline => "timeline",
            Self::Journey => "journey",
            Self::XyChart => "xychart",
            Self::QuadrantChart => "quadrantChart",
            Self::Requirement => "requirement",
            Self::C4 => "c4",
            Self::Sankey => "sankey",
            Self::Block => "block",
            Self::Packet => "packet",
            Self::Kanban => "kanban",
            Self::Architecture => "architecture",
            Self::Radar => "radar",
            Self::Treemap => "treemap",
            Self::Info => "info",
            Self::Agentflow => "agentflow",
            Self::Usecase => "usecase",
            Self::Railroad => "railroad",
            Self::TreeView => "treeView",
            Self::Venn => "venn",
            Self::Cynefin => "cynefin",
            Self::Wardley => "wardley",
            Self::Swimlane => "swimlane",
            Self::Ishikawa => "ishikawa",
            Self::EventModeling => "eventmodeling",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum MermaidType {
    FlowchartElk,
    FlowchartV2,
    Mindmap,
    Architecture,
    Agentflow,
    C4,
    Kanban,
    ClassDiagram,
    Er,
    Gantt,
    Info,
    Pie,
    Requirement,
    Sequence,
    Swimlane,
    Timeline,
    GitGraph,
    StateDiagram,
    Journey,
    QuadrantChart,
    Sankey,
    Packet,
    XyChart,
    Block,
    EventModeling,
    TreeView,
    Radar,
    Ishikawa,
    Treemap,
    Railroad,
    RailroadEbnf,
    RailroadAbnf,
    RailroadPeg,
    Venn,
    Wardley,
    Cynefin,
    Usecase,
}

impl MermaidType {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::FlowchartElk => "flowchart-elk",
            Self::FlowchartV2 => "flowchart-v2",
            Self::Mindmap => "mindmap",
            Self::Architecture => "architecture",
            Self::Agentflow => "agentflow",
            Self::C4 => "c4",
            Self::Kanban => "kanban",
            Self::ClassDiagram => "classDiagram",
            Self::Er => "er",
            Self::Gantt => "gantt",
            Self::Info => "info",
            Self::Pie => "pie",
            Self::Requirement => "requirement",
            Self::Sequence => "sequence",
            Self::Swimlane => "swimlane",
            Self::Timeline => "timeline",
            Self::GitGraph => "gitGraph",
            Self::StateDiagram => "stateDiagram",
            Self::Journey => "journey",
            Self::QuadrantChart => "quadrantChart",
            Self::Sankey => "sankey",
            Self::Packet => "packet",
            Self::XyChart => "xychart",
            Self::Block => "block",
            Self::EventModeling => "eventmodeling",
            Self::TreeView => "treeView",
            Self::Radar => "radar",
            Self::Ishikawa => "ishikawa",
            Self::Treemap => "treemap",
            Self::Railroad => "railroad",
            Self::RailroadEbnf => "railroadEbnf",
            Self::RailroadAbnf => "railroadAbnf",
            Self::RailroadPeg => "railroadPeg",
            Self::Venn => "venn",
            Self::Wardley => "wardley",
            Self::Cynefin => "cynefin",
            Self::Usecase => "usecase",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Detected {
    pub diagram_type: DiagramType,
    pub mermaid_type: MermaidType,
}

fn starts_with_word(s: &str, prefix: &str) -> bool {
    if !s.starts_with(prefix) {
        return false;
    }
    s.as_bytes().get(prefix.len()).is_none_or(|&b| !is_word(b as u32))
}

fn starts_with_ascii_ci(s: &str, prefix: &str) -> bool {
    s.len() >= prefix.len() && s.as_bytes()[..prefix.len()].eq_ignore_ascii_case(prefix.as_bytes())
}

fn starts_with_word_ci(s: &str, prefix: &str) -> bool {
    if !starts_with_ascii_ci(s, prefix) {
        return false;
    }
    s.as_bytes().get(prefix.len()).is_none_or(|&b| !is_word(b as u32))
}

/// Mermaid's detectors, in registration order so the first match wins.
pub fn detect_diagram(cleaned: &str) -> Option<Detected> {
    let s = cleaned.trim_start();
    if s.starts_with("flowchart-elk") {
        return Some(Detected {
            diagram_type: DiagramType::Flowchart,
            mermaid_type: MermaidType::FlowchartElk,
        });
    }
    if s.starts_with("mindmap") {
        return Some(Detected {
            diagram_type: DiagramType::Mindmap,
            mermaid_type: MermaidType::Mindmap,
        });
    }
    if s.starts_with("architecture") {
        return Some(Detected {
            diagram_type: DiagramType::Architecture,
            mermaid_type: MermaidType::Architecture,
        });
    }
    if starts_with_word(s, "agentflow-beta") {
        return Some(Detected {
            diagram_type: DiagramType::Agentflow,
            mermaid_type: MermaidType::Agentflow,
        });
    }
    if s.starts_with("C4Context") || s.starts_with("C4Container") || s.starts_with("C4Component") || s.starts_with("C4Dynamic") || s.starts_with("C4Deployment")
    {
        return Some(Detected {
            diagram_type: DiagramType::C4,
            mermaid_type: MermaidType::C4,
        });
    }
    if s.starts_with("kanban") {
        return Some(Detected {
            diagram_type: DiagramType::Kanban,
            mermaid_type: MermaidType::Kanban,
        });
    }
    if s.starts_with("classDiagram") {
        return Some(Detected {
            diagram_type: DiagramType::Class,
            mermaid_type: MermaidType::ClassDiagram,
        });
    }
    if s.starts_with("erDiagram") {
        return Some(Detected {
            diagram_type: DiagramType::Er,
            mermaid_type: MermaidType::Er,
        });
    }
    if s.starts_with("gantt") {
        return Some(Detected {
            diagram_type: DiagramType::Gantt,
            mermaid_type: MermaidType::Gantt,
        });
    }
    if s.starts_with("info") {
        return Some(Detected {
            diagram_type: DiagramType::Info,
            mermaid_type: MermaidType::Info,
        });
    }
    if s.starts_with("pie") {
        return Some(Detected {
            diagram_type: DiagramType::Pie,
            mermaid_type: MermaidType::Pie,
        });
    }
    if s.starts_with("requirement") {
        return Some(Detected {
            diagram_type: DiagramType::Requirement,
            mermaid_type: MermaidType::Requirement,
        });
    }
    if s.starts_with("sequenceDiagram") {
        return Some(Detected {
            diagram_type: DiagramType::Sequence,
            mermaid_type: MermaidType::Sequence,
        });
    }
    if starts_with_word(s, "swimlane-beta") {
        return Some(Detected {
            diagram_type: DiagramType::Swimlane,
            mermaid_type: MermaidType::Swimlane,
        });
    }
    if s.starts_with("graph") || s.starts_with("flowchart") {
        return Some(Detected {
            diagram_type: DiagramType::Flowchart,
            mermaid_type: MermaidType::FlowchartV2,
        });
    }
    if s.starts_with("timeline") {
        return Some(Detected {
            diagram_type: DiagramType::Timeline,
            mermaid_type: MermaidType::Timeline,
        });
    }
    if s.starts_with("gitGraph") {
        return Some(Detected {
            diagram_type: DiagramType::GitGraph,
            mermaid_type: MermaidType::GitGraph,
        });
    }
    if s.starts_with("stateDiagram") {
        return Some(Detected {
            diagram_type: DiagramType::State,
            mermaid_type: MermaidType::StateDiagram,
        });
    }
    if s.starts_with("journey") {
        return Some(Detected {
            diagram_type: DiagramType::Journey,
            mermaid_type: MermaidType::Journey,
        });
    }
    if s.starts_with("quadrantChart") {
        return Some(Detected {
            diagram_type: DiagramType::QuadrantChart,
            mermaid_type: MermaidType::QuadrantChart,
        });
    }
    if s.starts_with("sankey") {
        return Some(Detected {
            diagram_type: DiagramType::Sankey,
            mermaid_type: MermaidType::Sankey,
        });
    }
    if s.starts_with("packet") {
        return Some(Detected {
            diagram_type: DiagramType::Packet,
            mermaid_type: MermaidType::Packet,
        });
    }
    if s.starts_with("xychart") {
        return Some(Detected {
            diagram_type: DiagramType::XyChart,
            mermaid_type: MermaidType::XyChart,
        });
    }
    if s.starts_with("block") {
        return Some(Detected {
            diagram_type: DiagramType::Block,
            mermaid_type: MermaidType::Block,
        });
    }
    if s.starts_with("eventmodeling") {
        return Some(Detected {
            diagram_type: DiagramType::EventModeling,
            mermaid_type: MermaidType::EventModeling,
        });
    }
    if s.starts_with("treeView-beta") {
        return Some(Detected {
            diagram_type: DiagramType::TreeView,
            mermaid_type: MermaidType::TreeView,
        });
    }
    if s.starts_with("radar-beta") {
        return Some(Detected {
            diagram_type: DiagramType::Radar,
            mermaid_type: MermaidType::Radar,
        });
    }
    if starts_with_word_ci(s, "ishikawa-beta") || starts_with_word_ci(s, "ishikawa") {
        return Some(Detected {
            diagram_type: DiagramType::Ishikawa,
            mermaid_type: MermaidType::Ishikawa,
        });
    }
    if s.starts_with("treemap") {
        return Some(Detected {
            diagram_type: DiagramType::Treemap,
            mermaid_type: MermaidType::Treemap,
        });
    }
    if starts_with_ascii_ci(s, "railroad-beta") {
        return Some(Detected {
            diagram_type: DiagramType::Railroad,
            mermaid_type: MermaidType::Railroad,
        });
    }
    if starts_with_ascii_ci(s, "railroad-ebnf-beta") {
        return Some(Detected {
            diagram_type: DiagramType::Railroad,
            mermaid_type: MermaidType::RailroadEbnf,
        });
    }
    if starts_with_ascii_ci(s, "railroad-abnf-beta") {
        return Some(Detected {
            diagram_type: DiagramType::Railroad,
            mermaid_type: MermaidType::RailroadAbnf,
        });
    }
    if starts_with_ascii_ci(s, "railroad-peg-beta") {
        return Some(Detected {
            diagram_type: DiagramType::Railroad,
            mermaid_type: MermaidType::RailroadPeg,
        });
    }
    if s.starts_with("venn-beta") {
        return Some(Detected {
            diagram_type: DiagramType::Venn,
            mermaid_type: MermaidType::Venn,
        });
    }
    if starts_with_ascii_ci(s, "wardley-beta") {
        return Some(Detected {
            diagram_type: DiagramType::Wardley,
            mermaid_type: MermaidType::Wardley,
        });
    }
    if let Some(rest) = s.strip_prefix("cynefin-beta")
        && (rest.is_empty() || rest.starts_with(':') || rest.chars().next().is_some_and(char::is_whitespace))
    {
        return Some(Detected {
            diagram_type: DiagramType::Cynefin,
            mermaid_type: MermaidType::Cynefin,
        });
    }
    if let Some(rest) = s.strip_prefix("usecase-beta")
        && (rest.is_empty() || rest.chars().next().is_some_and(char::is_whitespace))
    {
        return Some(Detected {
            diagram_type: DiagramType::Usecase,
            mermaid_type: MermaidType::Usecase,
        });
    }
    None
}

pub fn detect(cleaned: &str) -> Option<DiagramType> {
    detect_diagram(cleaned).map(|d| d.diagram_type)
}
