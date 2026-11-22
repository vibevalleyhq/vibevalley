use std::collections::{BTreeSet, HashMap};

use crate::engine::whiteboard::model::{BoardDoc, ElementId, Point2, Rect2};

const CELL_SIZE: f64 = 256.0;

#[derive(Debug, Clone, Default)]
pub struct SpatialIndex {
    cells: HashMap<(i32, i32), Vec<usize>>,
    rects: Vec<Rect2>,
}

impl SpatialIndex {
    pub fn build(doc: &BoardDoc) -> Self {
        let lookup = doc.rect_lookup();
        let mut cells: HashMap<(i32, i32), Vec<usize>> = HashMap::new();
        let mut rects = Vec::with_capacity(doc.elements.len());
        for (idx, el) in doc.elements.iter().enumerate() {
            let r = el.visual_bbox(&lookup);
            rects.push(r);
            let (gx0, gy0, gx1, gy1) = cell_range(r);
            for gx in gx0..=gx1 {
                for gy in gy0..=gy1 {
                    cells.entry((gx, gy)).or_default().push(idx);
                }
            }
        }
        Self { cells, rects }
    }

    pub fn rect_of(&self, idx: usize) -> Option<Rect2> {
        self.rects.get(idx).copied()
    }

    pub fn query_rect(&self, world_rect: Rect2) -> Vec<usize> {
        let (gx0, gy0, gx1, gy1) = cell_range(world_rect);
        let mut unique = BTreeSet::new();
        for gx in gx0..=gx1 {
            for gy in gy0..=gy1 {
                if let Some(list) = self.cells.get(&(gx, gy)) {
                    for &idx in list {
                        if self.rects.get(idx).is_some_and(|r| r.intersects(world_rect)) {
                            unique.insert(idx);
                        }
                    }
                }
            }
        }
        unique.into_iter().collect()
    }

    pub fn query_point(&self, pt: Point2, radius: f64) -> Vec<usize> {
        self.query_rect(Rect2::new(pt.x - radius, pt.y - radius, radius * 2.0, radius * 2.0))
    }

    pub fn visible_element_ids(&self, doc: &BoardDoc, world_rect: Rect2, margin: f64) -> Vec<ElementId> {
        self.query_rect(world_rect.expand(margin))
            .into_iter()
            .filter_map(|idx| doc.elements.get(idx).map(|e| e.id.clone()))
            .collect()
    }
}

fn cell_range(rect: Rect2) -> (i32, i32, i32, i32) {
    let gx0 = (rect.x / CELL_SIZE).floor() as i32;
    let gy0 = (rect.y / CELL_SIZE).floor() as i32;
    let gx1 = (rect.right() / CELL_SIZE).floor() as i32;
    let gy1 = (rect.bottom() / CELL_SIZE).floor() as i32;
    (gx0, gy0, gx1, gy1)
}
