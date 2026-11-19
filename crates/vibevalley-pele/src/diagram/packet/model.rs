use crate::config::DiagramConfig;
use crate::detect::DiagramType;
use crate::error::{ErrorCode, PeleError};
use crate::util::yaml::YamlValue;

use super::parser::PacketAst;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PacketBlock {
    pub start: u64,
    pub end: u64,
    /// As Mermaid counts it: one less than the width for pieces of a field split across rows.
    pub bits: u64,
    pub label: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PacketModel {
    pub title: Option<String>,
    pub acc_title: Option<String>,
    pub acc_descr: Option<String>,
    pub bits_per_row: u64,
    pub rows: Vec<Vec<PacketBlock>>,
}

const MAX_ROWS: usize = 10_000;

pub fn packet_option(config: &DiagramConfig, key: &str, fallback: f64, min: f64, max: f64) -> f64 {
    let val = config.section("packet").and_then(|sec| sec.get(key)).and_then(YamlValue::as_f64);
    match val {
        Some(v) if v.is_finite() && v >= min => v.min(max),
        _ => fallback,
    }
}

fn invalid(message: String) -> PeleError {
    PeleError::new(message, ErrorCode::Semantic).with_diagram_type(DiagramType::Packet)
}

fn format_num(v: f64) -> String {
    if !v.is_finite() {
        return "Infinity".to_string();
    }
    if v.fract() == 0.0 && v.abs() < 1e15 {
        format!("{}", v as i64)
    } else {
        format!("{v}")
    }
}

pub fn build_packet(ast: PacketAst, config: &DiagramConfig, title: Option<&str>) -> Result<PacketModel, PeleError> {
    let bits_per_row = packet_option(config, "bitsPerRow", 32.0, 1.0, 4096.0).floor() as u64;
    let bpr_f = bits_per_row as f64;
    let mut rows: Vec<Vec<PacketBlock>> = Vec::new();
    let mut last_bit: f64 = -1.0;
    let mut word: Vec<PacketBlock> = Vec::new();
    let mut row: u64 = 1;

    for block in ast.blocks {
        if let (Some(s), Some(e)) = (block.start, block.end)
            && e < s
        {
            return Err(invalid(format!(
                "Packet block {} - {} is invalid. End must be greater than start.",
                format_num(s),
                format_num(e),
            )));
        }
        let mut start = block.start.unwrap_or(last_bit + 1.0);
        if start != last_bit + 1.0 {
            let end_disp = block.end.unwrap_or(start);
            return Err(invalid(format!(
                "Packet block {} - {} is not contiguous. It should start from {}.",
                format_num(start),
                format_num(end_disp),
                format_num(last_bit + 1.0),
            )));
        }
        if block.bits == Some(0.0) {
            return Err(invalid(
                format!("Packet block {} is invalid. Cannot have a zero bit field.", format_num(start),),
            ));
        }
        let end = block.end.unwrap_or_else(|| start + block.bits.unwrap_or(1.0) - 1.0);
        let mut bits = block.bits.unwrap_or(end - start + 1.0);
        last_bit = end;

        while word.len() <= (bits_per_row as usize) + 1 && rows.len() < MAX_ROWS {
            let row_end = (row as f64) * bpr_f - 1.0;
            if end <= row_end {
                word.push(PacketBlock {
                    start: start as u64,
                    end: end as u64,
                    bits: bits as u64,
                    label: block.label.clone(),
                });
                if end == row_end {
                    rows.push(std::mem::take(&mut word));
                    row += 1;
                }
                break;
            }
            word.push(PacketBlock {
                start: start as u64,
                end: row_end as u64,
                bits: (row_end - start) as u64,
                label: block.label.clone(),
            });
            rows.push(std::mem::take(&mut word));
            row += 1;
            start = row_end + 1.0;
            bits = end - start;
        }
    }
    if !word.is_empty() {
        rows.push(word);
    }

    Ok(PacketModel {
        title: ast.title.filter(|s| !s.is_empty()).or_else(|| title.map(str::to_string)),
        acc_title: crate::diagram::info::model::trim_acc_title(ast.acc_title),
        acc_descr: crate::diagram::info::model::trim_acc_descr(ast.acc_descr),
        bits_per_row,
        rows,
    })
}
