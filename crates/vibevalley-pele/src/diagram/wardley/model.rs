use crate::detect::DiagramType;
use crate::diagram::xychart::db::js_number_string;
use crate::error::{ErrorCode, PeleError};

use super::builder::{
    Flow, SourceStrategy, WardleyAnnotation, WardleyAxesConfig, WardleyBuildResult, WardleyBuilder, WardleyCoord, WardleyForce, WardleyLink, WardleyNode,
    WardleyNodeClass, WardleyNote, WardleyTrend,
};
use super::parser::{LabelAst, WardleyAst};

#[derive(Debug, Clone, PartialEq)]
pub struct WardleyModel {
    pub title: Option<String>,
    pub acc_title: Option<String>,
    pub acc_descr: Option<String>,
    pub data: WardleyBuildResult,
}

fn to_percent(value: f64, context: &str) -> Result<f64, PeleError> {
    let normalized = if value <= 1.0 { value * 100.0 } else { value };
    if !(0.0..=100.0).contains(&normalized) {
        return Err(PeleError::new(
            format!(
                "{context} must be between 0-1 (decimal) or 0-100 (percentage). Received: {}",
                js_number_string(value)
            ),
            ErrorCode::Semantic,
        )
        .with_diagram_type(DiagramType::Wardley));
    }
    Ok(normalized)
}

fn to_coordinates(visibility: f64, evolution: f64, context: &str) -> Result<WardleyCoord, PeleError> {
    Ok(WardleyCoord {
        x: to_percent(evolution, &format!("{context} evolution"))?,
        y: to_percent(visibility, &format!("{context} visibility"))?,
    })
}

fn flow_from_port(port: Option<&str>) -> Option<Flow> {
    match port {
        Some("+<>") => Some(Flow::Bidirectional),
        Some("+<") => Some(Flow::Backward),
        Some("+>") => Some(Flow::Forward),
        _ => None,
    }
}

fn flow_from_arrow(arrow: Option<&str>) -> (Option<Flow>, Option<String>) {
    let Some(arrow) = arrow else {
        return (None, None);
    };
    if !arrow.starts_with('+') {
        return (None, None);
    }
    let label = if arrow.as_bytes().get(1) == Some(&b'\'') {
        arrow[2..].find('\'').map(|rel| arrow[2..2 + rel].to_string())
    } else {
        None
    };
    let flow = if arrow.contains("<>") {
        Some(Flow::Bidirectional)
    } else if arrow.contains('<') {
        Some(Flow::Backward)
    } else if arrow.contains('>') {
        Some(Flow::Forward)
    } else {
        None
    };
    (flow, label)
}

fn offsets(label: Option<&LabelAst>) -> (Option<f64>, Option<f64>) {
    match label {
        Some(l) => (
            Some(if l.neg_x { -l.offset_x } else { l.offset_x }),
            Some(if l.neg_y { -l.offset_y } else { l.offset_y }),
        ),
        None => (None, None),
    }
}

fn trim_multiline_indent(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut lines = text.split('\n');
    if let Some(first) = lines.next() {
        out.push_str(first);
        for line in lines {
            out.push('\n');
            out.push_str(line.trim_start());
        }
    }
    out
}

pub fn populate(ast: &WardleyAst, db: &mut WardleyBuilder) -> Result<(), PeleError> {
    if let Some(size) = &ast.size {
        db.set_size(size.width, size.height);
    }

    if let Some(evolution) = &ast.evolution {
        let stages = evolution
            .stages
            .iter()
            .map(|stage| match &stage.second_name {
                Some(second) => format!("{} / {}", stage.name.trim(), second.trim()),
                None => stage.name.trim().to_string(),
            })
            .collect();
        let boundaries = evolution.stages.iter().filter_map(|stage| stage.boundary).collect();
        db.set_axes(WardleyAxesConfig {
            x_label: None,
            y_label: None,
            stages: Some(stages),
            stage_boundaries: Some(boundaries),
        });
    }

    for anchor in &ast.anchors {
        let at = to_coordinates(anchor.visibility, anchor.evolution, &format!("Anchor \"{}\"", anchor.name))?;
        db.add_node(WardleyNode {
            id: anchor.name.clone(),
            label: anchor.name.clone(),
            x: Some(at.x),
            y: Some(at.y),
            class_name: Some(WardleyNodeClass::Anchor),
            label_offset_x: None,
            label_offset_y: None,
            in_pipeline: false,
            is_pipeline_parent: false,
            inertia: None,
            source_strategy: None,
        });
    }

    for component in &ast.components {
        let at = to_coordinates(component.visibility, component.evolution, &format!("Component \"{}\"", component.name))?;
        let (label_offset_x, label_offset_y) = offsets(component.label.as_ref());
        db.add_node(WardleyNode {
            id: component.name.clone(),
            label: component.name.clone(),
            x: Some(at.x),
            y: Some(at.y),
            class_name: Some(WardleyNodeClass::Component),
            label_offset_x,
            label_offset_y,
            in_pipeline: false,
            is_pipeline_parent: false,
            inertia: Some(component.inertia),
            source_strategy: component.decorator.as_deref().and_then(SourceStrategy::from_str_opt),
        });
    }

    for note in &ast.notes {
        let at = to_coordinates(note.visibility, note.evolution, &format!("Note \"{}\"", note.text))?;
        db.add_note(WardleyNote {
            text: note.text.clone(),
            x: at.x,
            y: at.y,
        });
    }

    for pipeline in &ast.pipelines {
        let Some(parent_y) = db.get_node(&pipeline.parent).and_then(|n| n.y) else {
            return Err(PeleError::new(
                format!("Pipeline \"{}\" must reference an existing component with coordinates.", pipeline.parent),
                ErrorCode::Semantic,
            )
            .with_diagram_type(DiagramType::Wardley));
        };
        db.start_pipeline(&pipeline.parent);
        for component in &pipeline.components {
            let id = format!("{}_{}", pipeline.parent, component.name);
            let (label_offset_x, label_offset_y) = offsets(component.label.as_ref());
            let x = to_percent(component.evolution, &format!("Pipeline component \"{}\" evolution", component.name))?;
            db.add_node(WardleyNode {
                id: id.clone(),
                label: component.name.clone(),
                x: Some(x),
                y: Some(parent_y),
                class_name: Some(WardleyNodeClass::PipelineComponent),
                label_offset_x,
                label_offset_y,
                in_pipeline: false,
                is_pipeline_parent: false,
                inertia: None,
                source_strategy: None,
            });
            db.add_pipeline_component(&pipeline.parent, &id);
        }
    }

    for link in &ast.links {
        let dashed = link.arrow.as_deref().is_some_and(|a| a.contains("-.->") || a.contains(".-."));
        let (arrow_flow, arrow_label) = flow_from_arrow(link.arrow.as_deref());
        let flow = flow_from_port(link.from_port.as_deref())
            .or_else(|| flow_from_port(link.to_port.as_deref()))
            .or(arrow_flow);
        let source = db.resolve_node_id(&link.from);
        let target = db.resolve_node_id(&link.to);
        db.add_link(WardleyLink {
            source,
            target,
            dashed,
            label: arrow_label.or_else(|| link.link_label.clone()),
            flow,
        });
    }

    for evolve in &ast.evolves {
        if let Some(y) = db.get_node(&evolve.component).and_then(|n| n.y) {
            let target_x = to_percent(evolve.target, &format!("Evolve target for \"{}\"", evolve.component))?;
            db.add_trend(WardleyTrend {
                node_id: evolve.component.clone(),
                target_x,
                target_y: y,
            });
        }
    }

    if let Some(first) = ast.annotations.first() {
        let at = to_coordinates(first.x, first.y, "Annotations box")?;
        db.set_annotations_box(at.x, at.y);
    }

    for annotation in &ast.annotation {
        let at = to_coordinates(annotation.x, annotation.y, &format!("Annotation {}", js_number_string(annotation.number)))?;
        db.add_annotation(WardleyAnnotation {
            number: annotation.number,
            coordinates: vec![at],
            text: Some(annotation.text.clone()),
        });
    }

    for accelerator in &ast.accelerators {
        let at = to_coordinates(accelerator.x, accelerator.y, &format!("Accelerator \"{}\"", accelerator.name))?;
        db.add_accelerator(WardleyForce {
            name: accelerator.name.clone(),
            x: at.x,
            y: at.y,
        });
    }

    for deaccelerator in &ast.deaccelerators {
        let at = to_coordinates(deaccelerator.x, deaccelerator.y, &format!("Deaccelerator \"{}\"", deaccelerator.name))?;
        db.add_deaccelerator(WardleyForce {
            name: deaccelerator.name.clone(),
            x: at.x,
            y: at.y,
        });
    }

    Ok(())
}

pub fn build_wardley(ast: WardleyAst, title: Option<&str>) -> Result<WardleyModel, PeleError> {
    let mut db = WardleyBuilder::new();
    populate(&ast, &mut db)?;
    let data = db.build()?;
    let resolved_title = match ast.title {
        Some(t) if !t.is_empty() => Some(t),
        _ => title.map(str::to_string),
    };
    let acc_title = ast.acc_title.filter(|s| !s.is_empty()).map(|s| s.trim_start().to_string());
    let acc_descr = ast.acc_descr.filter(|s| !s.is_empty()).map(|s| trim_multiline_indent(&s));
    Ok(WardleyModel {
        title: resolved_title,
        acc_title,
        acc_descr,
        data,
    })
}
