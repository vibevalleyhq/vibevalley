use std::collections::HashMap;

use super::types::VertexKind;

pub const KIND_COUNT: usize = 7;

pub const fn kind_slot(kind: VertexKind) -> usize {
    match kind {
        VertexKind::Tool => 0,
        VertexKind::Task => 1,
        VertexKind::Decision => 2,
        VertexKind::Input => 3,
        VertexKind::Refdoc => 4,
        VertexKind::Connector => 5,
        VertexKind::Action => 6,
    }
}

pub fn container_slot_count(palette_length: usize) -> usize {
    palette_length.saturating_sub(KIND_COUNT).max(1)
}

pub fn container_slot(n: usize, palette_length: usize) -> usize {
    let slot = KIND_COUNT + (n % container_slot_count(palette_length));
    if palette_length > 0 { slot % palette_length } else { slot }
}

pub trait SlotNode {
    fn id(&self) -> &str;
    fn shape(&self) -> &str;
    fn is_group(&self) -> bool;
    fn set_color_index(&mut self, index: usize);
    fn set_kind(&mut self, kind: VertexKind);
}

pub fn assign_color_slots<N, F>(nodes: &mut [N], kind_of: F, container_order: &HashMap<String, usize>, palette_length: usize)
where
    N: SlotNode,
    F: Fn(&str) -> Option<VertexKind>,
{
    let mut fallback = container_order.len();
    for node in nodes {
        if node.is_group() || node.shape() == "collapsedGroup" {
            let ord = match container_order.get(node.id()) {
                Some(&idx) => idx,
                None => {
                    let idx = fallback;
                    fallback += 1;
                    idx
                }
            };
            node.set_color_index(container_slot(ord, palette_length));
            continue;
        }
        if let Some(kind) = kind_of(node.id()) {
            node.set_kind(kind);
        }
    }
}
