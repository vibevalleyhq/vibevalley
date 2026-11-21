use crate::detect::DiagramType;
use crate::error::{PeleError, SourceMap, syntax_error};

use super::db::{BlockDb, edge_str_to_edge_data, edge_str_to_edge_start_data, edge_str_to_pattern, edge_str_to_thickness, type_str_to_type};
use super::lexer::tokenize;
use super::tokens::BlockToken;
use super::types::{Block, RawStatements, Statement};

struct NodeInfo {
    id: String,
    label: Option<String>,
    type_str: Option<String>,
    directions: Vec<String>,
}

struct Frame {
    list: Vec<Statement>,
    header: Option<Statement>,
}

const STATEMENT_START: &str = "'NODE_ID', 'COLUMNS', 'SPACE_BLOCK', 'BLOCK_DIAGRAM_KEY', 'id-block', 'classDef', 'class', 'style'";

/// The grammar inlines a document's last statement when it is a list.
fn close_document(mut list: Vec<Statement>) -> Vec<Statement> {
    if let Some(Statement::Chain(_)) = list.last()
        && let Some(Statement::Chain(chain)) = list.pop()
    {
        for b in chain {
            list.push(Statement::Single(Box::new(b)));
        }
    }
    list
}

fn parse_usize_saturating(s: &str) -> usize {
    s.parse::<usize>().unwrap_or(usize::MAX)
}

fn parse_columns_f64(s: &str) -> f64 {
    s.parse::<f64>().unwrap_or(f64::INFINITY)
}

pub fn parse_block(src: &str, db: &mut BlockDb, origin: Option<&SourceMap<'_>>) -> Result<(), PeleError> {
    let tokens = tokenize(src);
    let types = &tokens.types;
    let texts = &tokens.texts;
    let starts = &tokens.starts;
    let mut i = 0usize;

    let fail = |idx: usize, expected: &str| -> PeleError {
        let t = types[idx];
        if t == BlockToken::Error {
            return syntax_error(DiagramType::Block, src, starts[idx], "", true, origin);
        }
        syntax_error(
            DiagramType::Block,
            src,
            starts[idx],
            &format!("Expecting {expected}, got '{}'", t.name()),
            false,
            origin,
        )
    };

    macro_rules! expect {
        ($kind:expr) => {{
            if types[i] != $kind {
                return Err(fail(i, &format!("'{}'", $kind.name())));
            }
            let s = texts[i].clone();
            i += 1;
            s
        }};
    }

    let parse_node = |i: &mut usize| -> Result<NodeInfo, PeleError> {
        if types[*i] != BlockToken::NodeId {
            return Err(fail(*i, &format!("'{}'", BlockToken::NodeId.name())));
        }
        let id = texts[*i].clone();
        *i += 1;
        if types[*i] == BlockToken::NodeDStart {
            let open = texts[*i].clone();
            *i += 1;
            if types[*i] != BlockToken::Str {
                return Err(fail(*i, &format!("'{}'", BlockToken::Str.name())));
            }
            let label = texts[*i].clone();
            *i += 1;
            if types[*i] != BlockToken::NodeDEnd {
                return Err(fail(*i, &format!("'{}'", BlockToken::NodeDEnd.name())));
            }
            let close = texts[*i].clone();
            *i += 1;
            return Ok(NodeInfo {
                id,
                label: Some(label),
                type_str: Some(format!("{open}{close}")),
                directions: Vec::new(),
            });
        }
        if types[*i] == BlockToken::BlockArrowStart {
            let open = texts[*i].clone();
            *i += 1;
            if types[*i] != BlockToken::Str {
                return Err(fail(*i, &format!("'{}'", BlockToken::Str.name())));
            }
            let label = texts[*i].clone();
            *i += 1;
            if types[*i] != BlockToken::Dir {
                return Err(fail(*i, &format!("'{}'", BlockToken::Dir.name())));
            }
            let mut directions = vec![texts[*i].clone()];
            *i += 1;
            while types[*i] == BlockToken::Dir {
                directions.push(texts[*i].clone());
                *i += 1;
            }
            if types[*i] != BlockToken::BlockArrowEnd {
                return Err(fail(*i, &format!("'{}'", BlockToken::BlockArrowEnd.name())));
            }
            let close = texts[*i].clone();
            *i += 1;
            return Ok(NodeInfo {
                id,
                label: Some(label),
                type_str: Some(format!("{open}{close}")),
                directions,
            });
        }
        Ok(NodeInfo {
            id,
            label: None,
            type_str: None,
            directions: Vec::new(),
        })
    };

    let parse_node_statement = |i: &mut usize| -> Result<Statement, PeleError> {
        let first = parse_node(i)?;
        let size = if types[*i] == BlockToken::Size {
            let s = parse_usize_saturating(&texts[*i]);
            *i += 1;
            s
        } else {
            1
        };
        let mut from = Block {
            id: first.id,
            has_id: true,
            label: first.label,
            block_type: Some(type_str_to_type(first.type_str.as_deref()).to_string()),
            directions: first.directions,
            width_in_columns: Some(size),
            ..Block::default()
        };
        let mut chain: Option<Vec<Block>> = None;
        while types[*i] == BlockToken::Link || types[*i] == BlockToken::StartLink {
            let mut label = String::new();
            let was_start = types[*i] == BlockToken::StartLink;
            *i += 1;
            if was_start {
                if types[*i] != BlockToken::LinkLabel {
                    return Err(fail(*i, &format!("'{}'", BlockToken::LinkLabel.name())));
                }
                *i += 1;
                if types[*i] != BlockToken::Str {
                    return Err(fail(*i, &format!("'{}'", BlockToken::Str.name())));
                }
                label = texts[*i].clone();
                *i += 1;
                if types[*i] != BlockToken::Link {
                    return Err(fail(*i, &format!("'{}'", BlockToken::Link.name())));
                }
                *i += 1;
            }
            let link = &texts[*i - 1];
            let to = parse_node(i)?;
            let arrow_type_end = edge_str_to_edge_data(link);
            let arrow_type_start = edge_str_to_edge_start_data(link);
            let thickness = edge_str_to_thickness(link);
            let pattern = edge_str_to_pattern(link);

            let list = chain.get_or_insert_with(|| {
                vec![Block {
                    id: from.id.clone(),
                    has_id: true,
                    label: from.label.clone(),
                    block_type: from.block_type.clone(),
                    directions: from.directions.clone(),
                    ..Block::default()
                }]
            });
            let prev_id = list.last().unwrap().id.clone();
            let edge_block = Block {
                id: format!("{prev_id}-{}", to.id),
                has_id: true,
                start: Some(prev_id),
                end: Some(to.id.clone()),
                label: Some(label),
                block_type: Some("edge".to_string()),
                thickness: Some(thickness.to_string()),
                pattern: Some(pattern.to_string()),
                directions: to.directions.clone(),
                arrow_type_end: Some(arrow_type_end.to_string()),
                arrow_type_start: Some(arrow_type_start.to_string()),
                ..Block::default()
            };
            from = Block {
                id: to.id,
                has_id: true,
                label: to.label,
                block_type: Some(type_str_to_type(to.type_str.as_deref()).to_string()),
                directions: to.directions,
                ..Block::default()
            };
            list.push(edge_block);
            list.push(from.clone());
        }
        Ok(match chain {
            Some(c) => Statement::Chain(c),
            None => Statement::Single(Box::new(from)),
        })
    };

    let _ = expect!(BlockToken::Key);
    let mut open: Vec<Frame> = Vec::new();
    let mut list: Vec<Statement> = Vec::new();

    loop {
        match types[i] {
            BlockToken::NodeId => {
                list.push(parse_node_statement(&mut i)?);
            }
            BlockToken::Columns => {
                let cols = parse_columns_f64(&texts[i]);
                i += 1;
                list.push(Statement::Single(Box::new(Block {
                    block_type: Some("column-setting".to_string()),
                    columns: Some(cols),
                    ..Block::default()
                })));
            }
            BlockToken::SpaceBlock => {
                let width = parse_usize_saturating(&texts[i]);
                i += 1;
                list.push(Statement::Single(Box::new(Block {
                    id: db.generate_id(),
                    has_id: true,
                    block_type: Some("space".to_string()),
                    label: Some(String::new()),
                    width: Some(width),
                    ..Block::default()
                })));
            }
            BlockToken::Key => {
                i += 1;
                open.push(Frame { list, header: None });
                list = Vec::new();
            }
            BlockToken::IdBlock => {
                i += 1;
                if types[i] != BlockToken::NodeId {
                    return Err(fail(i, "'NODE_ID'"));
                }
                let header = parse_node_statement(&mut i)?;
                open.push(Frame { list, header: Some(header) });
                list = Vec::new();
            }
            BlockToken::EndKw => {
                let Some(frame) = open.pop() else {
                    return Err(fail(i, STATEMENT_START));
                };
                if list.is_empty() {
                    return Err(fail(i, STATEMENT_START));
                }
                i += 1;
                let id = db.generate_id();
                let children = close_document(list);
                list = frame.list;
                let composite = match frame.header {
                    None => Block {
                        id,
                        has_id: true,
                        block_type: Some("composite".to_string()),
                        label: Some(String::new()),
                        raw_children: RawStatements(children),
                        ..Block::default()
                    },
                    Some(Statement::Single(mut hdr)) => {
                        hdr.block_type = Some("composite".to_string());
                        hdr.raw_children = RawStatements(children);
                        *hdr
                    }
                    Some(Statement::Chain(_)) => Block {
                        id: String::new(),
                        has_id: false,
                        block_type: Some("composite".to_string()),
                        raw_children: RawStatements(children),
                        ..Block::default()
                    },
                };
                list.push(Statement::Single(Box::new(composite)));
            }
            BlockToken::ClassDef => {
                i += 1;
                let id = expect!(BlockToken::ClassDefId).trim().to_string();
                let css = expect!(BlockToken::ClassDefStyleOpts).trim().to_string();
                list.push(Statement::Single(Box::new(Block {
                    id,
                    has_id: true,
                    block_type: Some("classDef".to_string()),
                    css: Some(css),
                    ..Block::default()
                })));
            }
            BlockToken::Class => {
                i += 1;
                let id = expect!(BlockToken::ClassEntityIds).trim().to_string();
                let style_class = expect!(BlockToken::StyleClass).trim().to_string();
                list.push(Statement::Single(Box::new(Block {
                    id,
                    has_id: true,
                    block_type: Some("applyClass".to_string()),
                    style_class: Some(style_class),
                    ..Block::default()
                })));
            }
            BlockToken::Style => {
                i += 1;
                let id = expect!(BlockToken::StyleEntityIds).trim().to_string();
                let styles_str = expect!(BlockToken::StyleDefinitionData).trim().to_string();
                list.push(Statement::Single(Box::new(Block {
                    id,
                    has_id: true,
                    block_type: Some("applyStyles".to_string()),
                    styles_str: Some(styles_str),
                    ..Block::default()
                })));
            }
            BlockToken::Eof => {
                if !open.is_empty() {
                    return Err(fail(i, &format!("{STATEMENT_START}, 'end'")));
                }
                if list.is_empty() {
                    return Err(fail(i, STATEMENT_START));
                }
                db.set_hierarchy(close_document(list))?;
                return Ok(());
            }
            BlockToken::End
            | BlockToken::Error
            | BlockToken::MdStr
            | BlockToken::Str
            | BlockToken::Default
            | BlockToken::LinkStyle
            | BlockToken::Interpolate
            | BlockToken::DefaultClassDefId
            | BlockToken::ClassDefId
            | BlockToken::ClassDefStyleOpts
            | BlockToken::ClassEntityIds
            | BlockToken::StyleClass
            | BlockToken::StyleEntityIds
            | BlockToken::StyleDefinitionData
            | BlockToken::AccTitle
            | BlockToken::AccTitleValue
            | BlockToken::AccDescr
            | BlockToken::AccDescrValue
            | BlockToken::AccDescrMultilineValue
            | BlockToken::NodeDStart
            | BlockToken::NodeDEnd
            | BlockToken::BlockArrowStart
            | BlockToken::BlockArrowEnd
            | BlockToken::Dir
            | BlockToken::Link
            | BlockToken::StartLink
            | BlockToken::LinkLabel
            | BlockToken::Size => {
                let expected = if list.is_empty() {
                    STATEMENT_START.to_string()
                } else if !open.is_empty() {
                    format!("{STATEMENT_START}, 'end'")
                } else {
                    format!("{STATEMENT_START}, 'EOF'")
                };
                return Err(fail(i, &expected));
            }
        }
    }
}
