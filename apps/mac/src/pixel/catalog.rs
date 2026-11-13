//! The catalog (`/catalog`): every sprite on its shelf, as VibeValley's
//! `features/catalog/shelves.ts` sorts them, on a chosen ground (grid,
//! grass, night). The cursor and sound shelves are not carried over yet.

use std::sync::Arc;

use super::atlas::Atlas;
use super::draw::{DrawList, Op, rgba};
use super::level::{Box2, Point};

const SPECIES: [&str; 7] = ["bear", "rabbit", "fox", "cat", "owl", "hedgehog", "raccoon"];

/// (id, label); the last takes what no shelf before it does.
pub const SHELVES: [(&str, &str); 14] = [
    ("helpers", "帮工"),
    ("orchestrator", "助手"),
    ("dog", "宠物"),
    ("plots", "地块"),
    ("yard", "院子"),
    ("map", "地图"),
    ("machines", "农机"),
    ("icons", "图标"),
    ("acts", "动作"),
    ("medals", "奖章"),
    ("logos", "Logo"),
    ("langs", "语言"),
    ("ui", "界面"),
    ("other", "其他"),
];

fn starts(n: &str, prefixes: &[&str]) -> bool {
    prefixes.iter().any(|p| n.starts_with(p))
}

pub fn shelf_of(n: &str) -> &'static str {
    if SPECIES.iter().any(|s| n.starts_with(&format!("{s}-"))) {
        "helpers"
    } else if n.starts_with("manager-") {
        "orchestrator"
    } else if n.starts_with("dog-") {
        "dog"
    } else if n.starts_with("plot-") {
        "plots"
    } else if n == "map" || n == "mailbox" || starts(n, &["prop-", "fg-", "critter-"]) {
        "yard"
    } else if starts(n, &["island-", "map-"]) {
        "map"
    } else if n.starts_with("machine-") {
        "machines"
    } else if n.starts_with("icon-") {
        "icons"
    } else if n.starts_with("act-") {
        "acts"
    } else if starts(n, &["medal-", "emblem-", "stamp-", "coins-", "banner-"]) {
        "medals"
    } else if starts(n, &["logo-", "connector-", "app-"]) {
        "logos"
    } else if n.starts_with("lang-") {
        "langs"
    } else if starts(n, &["button-", "energy-", "day-"]) {
        "ui"
    } else {
        "other"
    }
}

const GROUNDS: [(&str, u32); 3] = [("格子", 0xf4ecd8), ("草地", 0x7fa650), ("夜里", 0x1c2233)];
const WIDTH: f32 = 384.0;
const CELL: f32 = 44.0;

pub struct CatalogScene {
    pub atlas: Arc<Atlas>,
    pub shelf: usize,
    pub ground: usize,
    pub selected: Option<String>,
    hits: Vec<(Box2, Hit)>,
}

#[derive(Clone)]
enum Hit {
    Shelf(usize),
    Ground(usize),
    Sprite(String),
}

impl CatalogScene {
    pub fn new(atlas: Arc<Atlas>) -> CatalogScene {
        CatalogScene {
            atlas,
            shelf: 0,
            ground: 0,
            selected: None,
            hits: Vec::new(),
        }
    }

    pub fn names(&self, shelf: &str) -> Vec<String> {
        let mut v: Vec<String> = self.atlas.names().filter(|n| shelf_of(n) == shelf).map(String::from).collect();
        v.sort();
        v
    }

    pub fn draw(&mut self) -> DrawList {
        let (_, ground) = GROUNDS[self.ground];
        let names = self.names(SHELVES[self.shelf].0);
        let cols = (WIDTH / CELL) as usize;
        let rows = names.len().div_ceil(cols).max(1);
        let top = 54.0;
        let height = (top + rows as f32 * CELL + 8.0).max(256.0);
        let mut list = DrawList::new(WIDTH, height, rgba(ground, 1.0));
        list.fit = true;
        self.hits.clear();
        let ink = if self.ground == 2 { rgba(0xf7e8c4, 1.0) } else { rgba(0x3b2a1a, 1.0) };
        // Shelf tabs and ground swatches along the top, as art-pixel boxes with labels.
        for (i, (_, label)) in SHELVES.iter().enumerate() {
            let x = 4.0 + (i % 7) as f32 * 40.0;
            let y = 4.0 + (i / 7) as f32 * 16.0;
            let on = i == self.shelf;
            list.rect(x, y, 38.0, 14.0, if on { rgba(0xe6b85c, 1.0) } else { rgba(0x000000, 0.12) });
            list.hud_art.push((x + 19.0, y + 1.0, label.to_string()));
            self.hits.push((
                Box2 {
                    x0: x,
                    y0: y,
                    x1: x + 38.0,
                    y1: y + 14.0,
                },
                Hit::Shelf(i),
            ));
        }
        for (i, (_, color)) in GROUNDS.iter().enumerate() {
            let x = WIDTH - 4.0 - (3 - i) as f32 * 18.0;
            list.rect(
                x - 1.0,
                3.0,
                16.0,
                16.0,
                if i == self.ground { rgba(0xe6b85c, 1.0) } else { rgba(0x000000, 0.3) },
            );
            list.rect(x, 4.0, 14.0, 14.0, rgba(*color, 1.0));
            self.hits.push((
                Box2 {
                    x0: x,
                    y0: 4.0,
                    x1: x + 14.0,
                    y1: 18.0,
                },
                Hit::Ground(i),
            ));
        }
        for (i, name) in names.iter().enumerate() {
            let Some(info) = self.atlas.get(name) else { continue };
            let (cx, cy) = (4.0 + (i % cols) as f32 * CELL, top + (i / cols) as f32 * CELL);
            if self.ground == 0 {
                list.rect(cx + 1.0, cy + 1.0, CELL - 2.0, CELL - 2.0, rgba(0xffffff, 0.35));
            }
            if self.selected.as_deref() == Some(name) {
                list.rect(cx, cy, CELL, CELL, rgba(0xe6b85c, 0.6));
            }
            // Big pictures shrink into the cell by whole halvings of their size; small ones stand as they are.
            let k = (CELL - 4.0) / info.w.max(info.h);
            let (w, h) = if k < 1.0 { (info.w * k, info.h * k) } else { (info.w, info.h) };
            let (x, y) = (cx + (CELL - w) / 2.0, cy + (CELL - h) / 2.0);
            if k < 1.0 {
                if let Some(image) = self.atlas.image(name) {
                    list.ops.push(Op::Image {
                        key: format!("catalog:{name}"),
                        image,
                        x,
                        y,
                        w,
                        h,
                        alpha: 1.0,
                    });
                }
            } else {
                list.ops.push(Op::Sprite {
                    name: name.clone(),
                    x,
                    y,
                    flip: false,
                    alpha: 1.0,
                });
            }
            self.hits.push((
                Box2 {
                    x0: cx,
                    y0: cy,
                    x1: cx + CELL,
                    y1: cy + CELL,
                },
                Hit::Sprite(name.clone()),
            ));
        }
        let shown = self
            .selected
            .clone()
            .unwrap_or_else(|| format!("{} · {} 张", SHELVES[self.shelf].1, names.len()));
        list.hud_art.push((WIDTH / 2.0, 38.0, shown));
        let _ = ink;
        list
    }

    /// A click: a shelf, a ground or a picture.
    pub fn tap(&mut self, p: Point) {
        match self.hits.iter().rev().find(|(b, _)| b.contains(p)).map(|(_, h)| h.clone()) {
            Some(Hit::Shelf(i)) => {
                self.shelf = i;
                self.selected = None;
            }
            Some(Hit::Ground(i)) => self.ground = i,
            Some(Hit::Sprite(name)) => {
                let info = self.atlas.get(&name);
                self.selected = Some(match info {
                    Some(s) => format!("{name} · {}×{} · 脚 {},{}", s.w, s.h, s.ax, s.ay),
                    None => name,
                });
            }
            None => {}
        }
    }

    pub fn debug_state(&self) -> serde_json::Value {
        let counts: serde_json::Map<String, serde_json::Value> = SHELVES.iter().map(|(id, _)| (id.to_string(), self.names(id).len().into())).collect();
        serde_json::json!({ "shelf": SHELVES[self.shelf].0, "ground": GROUNDS[self.ground].0, "selected": self.selected, "counts": counts })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shelves_sort_as_vibevalley() {
        assert_eq!(shelf_of("bear-farmer-down"), "helpers");
        assert_eq!(shelf_of("manager-talk"), "orchestrator");
        assert_eq!(shelf_of("map"), "yard");
        assert_eq!(shelf_of("map-cloud"), "map");
        assert_eq!(shelf_of("ragdoll-wag-1"), "other");
    }
}
