//! The memory tree: VibeValley's `tree/grow.ts` (a seeded genome grown by
//! the rounds of work, memories hung on it as leaves, fruits and seeds) and
//! the tree part of `tree/Scene.tsx`, painted pixel by pixel on the CPU over
//! the hill backdrop. VibeValley's own tree page runs on mock memories
//! (`tree/mock.ts`); so does this one until the server serves memories.

use std::sync::Arc;

use image::{Rgba, RgbaImage};

use super::atlas::Atlas;
use super::draw::{DrawList, HudOp, Op, rgba};
use super::sky::DayClock;
use vibevalley_i18n::t;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Leaf,
    Fruit,
    Seed,
}

#[derive(Debug, Clone)]
pub struct Memory {
    pub id: String,
    pub kind: Kind,
    pub fading: bool,
}

pub struct Gene {
    parent: Option<usize>,
    depth: u32,
    angle: f32,
    length: f32,
    birth: f32,
}

const MAX_DEPTH: u32 = 6;
const UNFOLD: f32 = 0.14;

/// mulberry32, as `grow.ts`'s `random`.
struct Mulberry(u32);
impl Mulberry {
    fn next(&mut self) -> f32 {
        self.0 = self.0.wrapping_add(0x6d2b79f5);
        let mut t = self.0;
        t = (t ^ (t >> 15)).wrapping_mul(t | 1);
        t ^= t.wrapping_add((t ^ (t >> 7)).wrapping_mul(t | 61));
        ((t ^ (t >> 14)) as f64 / 4294967296.0) as f32
    }
}

fn genome(seed: u32) -> Vec<Gene> {
    let mut rnd = Mulberry(seed);
    let mut genes = vec![Gene {
        parent: None,
        depth: 0,
        angle: 0.0,
        length: 0.26,
        birth: 0.0,
    }];
    fn grow(at: usize, genes: &mut Vec<Gene>, rnd: &mut Mulberry) {
        let (depth, angle0, length0, birth0) = {
            let g = &genes[at];
            (g.depth, g.angle, g.length, g.birth)
        };
        if depth >= MAX_DEPTH {
            return;
        }
        let n = if depth == 0 { 3 } else { 2 + usize::from(depth < 3 && rnd.next() < 0.35) };
        let spread = 0.62 - depth as f32 * 0.06;
        for i in 0..n {
            let side = if n == 1 { 0.0 } else { i as f32 / (n - 1) as f32 - 0.5 };
            let angle = (angle0 + side * spread * 2.0 + (rnd.next() - 0.5) * 0.3) * 0.8;
            let length = length0 * (0.7 + rnd.next() * 0.12);
            let birth = birth0 + if depth == 0 { 0.12 } else { 0.09 + rnd.next() * 0.05 };
            genes.push(Gene {
                parent: Some(at),
                depth: depth + 1,
                angle,
                length,
                birth,
            });
            let last = genes.len() - 1;
            grow(last, genes, rnd);
        }
    }
    grow(0, &mut genes, &mut rnd);
    genes
}

/// A number 0..1 from an id, the same every time (FNV-1a over UTF-16 units).
pub fn hash01(id: &str) -> f32 {
    let mut h: u32 = 2166136261;
    for u in id.encode_utf16() {
        h = (h ^ u as u32).wrapping_mul(16777619);
    }
    (h % 100000) as f32 / 100000.0
}

/// How grown (0..1) after this many rounds of work.
pub fn growth_of(rounds: f32) -> f32 {
    (0.06 + 0.94 * (rounds.ln_1p() / 600f32.ln_1p())).min(1.0)
}

pub struct Segment {
    pub x0: f32,
    pub y0: f32,
    pub x1: f32,
    pub y1: f32,
    pub width: f32,
    pub depth: u32,
    pub tip: bool,
}

pub struct Placed {
    pub memory: Memory,
    pub x: f32,
    pub y: f32,
}

pub struct Clump {
    pub x: f32,
    pub y: f32,
    pub r: f32,
}

pub struct Grown {
    pub segments: Vec<Segment>,
    pub clumps: Vec<Clump>,
    pub leaves: Vec<Placed>,
    pub fruits: Vec<Placed>,
    pub seeds: Vec<Placed>,
}

#[derive(Clone, Copy)]
struct End {
    x: f32,
    y: f32,
    shown: bool,
    tip: bool,
}

/// The tree at `growth`, `height` pixels tall full grown, y up from its foot.
pub fn grow_tree(genes: &[Gene], items: &[Memory], growth: f32, height: f32, sway: f32) -> Grown {
    let root = End {
        x: 0.0,
        y: 0.0,
        shown: true,
        tip: true,
    };
    let mut ends: Vec<End> = Vec::new();
    let mut seg_of_end: Vec<Option<usize>> = Vec::new();
    let mut segments: Vec<Segment> = Vec::new();
    for g in genes {
        let from = g.parent.map(|p| ends[p]).unwrap_or(root);
        let grown = ((growth - g.birth) / UNFOLD).clamp(0.0, 1.0);
        let shown = from.shown && grown > 0.0;
        let angle = g.angle + sway * g.depth as f32 * 0.25;
        let len = g.length * height * grown;
        let (x, y) = (from.x + angle.sin() * len, from.y + angle.cos() * len);
        ends.push(End { x, y, shown, tip: true });
        seg_of_end.push(None);
        if let Some(p) = g.parent
            && shown
        {
            ends[p].tip = false;
            if let Some(s) = seg_of_end[p] {
                segments[s].tip = false;
            }
        }
        if !shown {
            continue;
        }
        segments.push(Segment {
            x0: from.x,
            y0: from.y,
            x1: x,
            y1: y,
            width: ((1.0 + 6.0 * growth) * 0.6f32.powi(g.depth as i32)).max(1.0),
            depth: g.depth,
            tip: true,
        });
        let last = seg_of_end.len() - 1;
        seg_of_end[last] = Some(segments.len() - 1);
    }
    let boughs: Vec<usize> = (0..ends.len()).filter(|&i| ends[i].shown && genes[i].depth >= 1).collect();
    let anchors: Vec<usize> = if boughs.is_empty() {
        (0..ends.len()).filter(|&i| ends[i].shown).collect()
    } else {
        boughs
    };
    let fruit_anchors: Vec<usize> = (0..ends.len()).filter(|&i| ends[i].shown && genes[i].depth >= 2 && growth > 0.3).collect();
    let mut hung: Vec<(usize, u32)> = Vec::new();
    let reach = 2.0 + 5.0 * growth;
    let place = |m: &Memory, list: &[usize], reach: f32, hung: &mut Vec<(usize, u32)>| -> Option<Placed> {
        let a = *list.get((hash01(&m.id) * list.len() as f32) as usize)?;
        if m.kind == Kind::Leaf {
            match hung.iter_mut().find(|(i, _)| *i == a) {
                Some(h) => h.1 += 1,
                None => hung.push((a, 1)),
            }
        }
        let r = reach * hash01(&format!("{}r", m.id)).sqrt();
        let t = hash01(&format!("{}t", m.id)) * std::f32::consts::TAU;
        Some(Placed {
            memory: m.clone(),
            x: ends[a].x + t.cos() * r,
            y: ends[a].y + t.sin() * r * 0.8,
        })
    };
    let (mut leaves, mut fruits, mut seeds) = (Vec::new(), Vec::new(), Vec::new());
    let mut seed_index = 0;
    for m in items {
        match m.kind {
            Kind::Leaf => leaves.extend(place(m, &anchors, reach, &mut hung)),
            Kind::Fruit => fruits.extend(place(m, &fruit_anchors, reach * 0.7, &mut hung)),
            Kind::Seed if growth > 0.5 => {
                let i = seed_index;
                seed_index += 1;
                let side = if i % 2 == 0 { 1.0 } else { -1.0 };
                seeds.push(Placed {
                    memory: m.clone(),
                    x: side * (10.0 + (i / 2) as f32 * 7.0 + growth * 6.0),
                    y: -3.0 - (i % 3) as f32,
                });
            }
            Kind::Seed => {}
        }
    }
    let clumps = hung
        .into_iter()
        .map(|(a, n)| Clump {
            x: ends[a].x,
            y: ends[a].y,
            r: (1.5 + (n as f32).sqrt() * 2.2) * (0.6 + 0.4 * growth),
        })
        .collect();
    Grown {
        segments,
        clumps,
        leaves,
        fruits,
        seeds,
    }
}

/// VibeValley's mock memories: 186 leaves, fruits and seeds, the five least used fading.
pub fn mock_memories() -> Vec<Memory> {
    let mut rnd = Mulberry(20261022);
    let mut items: Vec<(Memory, f32)> = (0..186)
        .map(|i| {
            (
                Memory {
                    id: format!("leaf-{i}"),
                    kind: Kind::Leaf,
                    fading: false,
                },
                rnd.next(),
            )
        })
        .collect();
    items.sort_by(|a, b| a.1.total_cmp(&b.1));
    for (m, _) in items.iter_mut().take(5) {
        m.fading = true;
    }
    let mut out: Vec<Memory> = items.into_iter().map(|(m, _)| m).collect();
    out.extend((0..24).map(|i| Memory {
        id: format!("fruit-{i}"),
        kind: Kind::Fruit,
        fading: false,
    }));
    out.extend((0..6).map(|i| Memory {
        id: format!("seed-{i}"),
        kind: Kind::Seed,
        fading: false,
    }));
    out
}

type Rgb = [u8; 3];
const BARK: (Rgb, Rgb, Rgb) = ([52, 32, 22], [104, 66, 40], [170, 108, 60]);
const LEAF_LINE: Rgb = [30, 44, 24];
const LEAF_SHADE: Rgb = [56, 80, 36];
const LEAF_FILL: Rgb = [92, 120, 46];
const LEAF_LIGHT: Rgb = [158, 162, 62];
const LEAF_SUN: Rgb = [222, 186, 84];
const YELLOW: Rgb = [222, 170, 58];
const YELLOW_LIGHT: Rgb = [246, 210, 110];
const FRUIT_ROWS: [&str; 5] = [" ooo ", "offfo", "ohffo", "offfo", " ooo "];
const SACK_ROWS: [&str; 6] = ["  g  ", " sgs ", "sssss", "sSsss", "sssSs", " sss "];

struct Canvas(RgbaImage);

impl Canvas {
    fn px(&mut self, x: f32, y: f32, c: Rgb, a: u8) {
        let (x, y) = (x.round() as i64, y.round() as i64);
        if x >= 0 && y >= 0 && x < self.0.width() as i64 && y < self.0.height() as i64 {
            let p = self.0.get_pixel_mut(x as u32, y as u32);
            if a == 255 || p.0[3] == 0 {
                *p = Rgba([c[0], c[1], c[2], a]);
            } else {
                let k = a as f32 / 255.0;
                for (d, s) in p.0.iter_mut().zip(c) {
                    *d = (s as f32 * k + *d as f32 * (1.0 - k)) as u8;
                }
                p.0[3] = p.0[3].max(a);
            }
        }
    }
    fn row(&mut self, x: f32, y: f32, w: i64, c: Rgb) {
        for dx in 0..w {
            self.px(x + dx as f32, y, c, 255);
        }
    }
    /// A filled disc, one row at a time so the edge stays hard.
    fn disc(&mut self, x: f32, y: f32, r: f32, c: Rgb) {
        let (cx, cy) = (x.round(), y.round());
        let rr = r.max(0.0);
        let n = rr.floor() as i64;
        for dy in -n..=n {
            let half = ((rr * rr - (dy * dy) as f32).sqrt() + 0.35).floor();
            self.row(cx - half, cy + dy as f32, (half * 2.0 + 1.0) as i64, c);
        }
    }
    fn pattern(&mut self, rows: &[&str], x: f32, y: f32, ink: impl Fn(char) -> Option<Rgb>) {
        for (dy, row) in rows.iter().enumerate() {
            for (dx, ch) in row.chars().enumerate() {
                if let Some(c) = ink(ch) {
                    self.px(x.round() + dx as f32, y.round() + dy as f32, c, 255);
                }
            }
        }
    }
}

/// Paints `t` with its foot at (`bx`, `by`), y down.
fn paint_tree(c: &mut Canvas, t: &Grown, growth: f32, bx: f32, by: f32) {
    let spread = t.clumps.iter().map(|k| k.x.abs() + k.r).fold(6.0f32, f32::max);
    for dy in -4i32..=4 {
        let half = (spread * 0.8 * (1.0 - (dy as f32 / 5.0).powi(2)).sqrt()).floor() as i32;
        for dx in -half..=half {
            if (dx + dy).rem_euclid(2) == 0 {
                c.px(bx + dx as f32 + 4.0, by + dy as f32 + 1.0, [30, 52, 24], 90);
            }
        }
    }
    if growth > 0.15 {
        let trunk = t.segments.first().map(|s| s.width).unwrap_or(1.0);
        for (side, reach, drop) in [(-1.0, 1.0, 2.0), (1.0, 0.9, 3.0), (-1.0, 0.55, 4.0), (1.0, 0.6, 1.0)] {
            let len = (6.0 + growth * 26.0) * reach;
            for (pass, color) in [(1.0, BARK.0), (0.0, BARK.1)] {
                let mut i = 0.0;
                while i <= len {
                    let d = i / len;
                    let r = ((trunk / 2.0) * (1.0 - d).powf(1.4) * 1.1).max(0.6) + pass;
                    c.disc(bx + side * (trunk * 0.3 + i), by - 1.0 + d * drop, r, color);
                    i += 1.0;
                }
            }
        }
    }
    for l in t.leaves.iter().filter(|l| l.memory.fading) {
        for j in 0..2 {
            let x = bx + (hash01(&format!("{}f{j}", l.memory.id)) - 0.5) * spread * 1.4;
            let y = by + 1.0 + hash01(&format!("{}g{j}", l.memory.id)) * 5.0;
            c.row(x, y, 2, YELLOW);
        }
    }
    for (pass, color) in [BARK.0, BARK.1, BARK.2].into_iter().enumerate() {
        for s in &t.segments {
            if pass == 2 && s.width < 2.5 {
                continue;
            }
            let steps = (s.x1 - s.x0).hypot(s.y1 - s.y0).ceil().max(1.0) as i32;
            let r = s.width / 2.0 + if pass == 0 { 1.0 } else { 0.0 } - if pass == 2 { (s.width * 0.3).max(0.6) } else { 0.0 };
            for i in 0..=steps {
                let k = i as f32 / steps as f32;
                let x = bx + s.x0 + (s.x1 - s.x0) * k - if pass == 2 { s.width * 0.18 } else { 0.0 };
                c.disc(x, by - (s.y0 + (s.y1 - s.y0) * k), r, color);
            }
        }
    }
    for s in &t.segments {
        if !s.tip || (s.depth == 0 && t.segments.len() > 1) {
            continue;
        }
        c.disc(bx + s.x1, by - s.y1, 2.2, LEAF_LINE);
        c.disc(bx + s.x1, by - s.y1, 1.2, LEAF_LIGHT);
    }
    let r = 1.5 + growth * 1.5;
    for k in &t.clumps {
        c.disc(bx + k.x, by - k.y, k.r + 1.0, LEAF_LINE);
    }
    for l in &t.leaves {
        c.disc(bx + l.x, by - l.y, r + 1.0, LEAF_LINE);
    }
    for k in &t.clumps {
        c.disc(bx + k.x, by - k.y, k.r, LEAF_SHADE);
    }
    for k in &t.clumps {
        c.disc(bx + k.x - k.r * 0.25, by - k.y - k.r * 0.3, k.r * 0.7, LEAF_FILL);
    }
    for k in &t.clumps {
        let n = (k.r * k.r * 0.35).round() as i32;
        for i in 0..n {
            let a = hash01(&format!("{},{},{i}a", k.x, k.y)) * std::f32::consts::TAU;
            let d = hash01(&format!("{},{},{i}d", k.x, k.y)).sqrt() * k.r * 0.9;
            let lit = a.cos() < -0.2 && a.sin() < 0.3;
            c.px(bx + k.x + a.cos() * d, by - k.y + a.sin() * d, if lit { LEAF_LIGHT } else { LEAF_SHADE }, 255);
        }
        for i in 0..6 {
            let a = std::f32::consts::PI * (0.85 + i as f32 * 0.07);
            c.px(bx + k.x + a.cos() * k.r, by - k.y - a.sin() * k.r * 0.9, LEAF_SUN, 255);
        }
    }
    for l in &t.leaves {
        c.disc(bx + l.x, by - l.y, r, if l.memory.fading { YELLOW } else { LEAF_FILL });
    }
    for l in &t.leaves {
        if hash01(&format!("{}h", l.memory.id)) < 0.45 {
            continue;
        }
        c.disc(bx + l.x - 1.0, by - l.y - 1.0, r - 1.2, if l.memory.fading { YELLOW_LIGHT } else { LEAF_LIGHT });
    }
    for f in &t.fruits {
        c.pattern(&FRUIT_ROWS, bx + f.x - 2.0, by - f.y - 2.0, |ch| match ch {
            'o' => Some([112, 52, 20]),
            'f' => Some([240, 156, 52]),
            'h' => Some([255, 226, 140]),
            _ => None,
        });
    }
    for s in &t.seeds {
        c.pattern(&SACK_ROWS, bx + s.x - 2.0, by - s.y - 6.0, |ch| match ch {
            's' => Some([196, 156, 98]),
            'S' => Some([150, 112, 66]),
            'g' => Some([244, 196, 70]),
            _ => None,
        });
    }
}

const W: f32 = 384.0;
const H: f32 = 256.0;
const KNOLL: (f32, f32) = (0.36, 0.71);

pub struct TreeScene {
    pub atlas: Arc<Atlas>,
    genes: Vec<Gene>,
    pub memories: Vec<Memory>,
    pub texts: std::collections::HashMap<String, String>,
    pub selected: Option<(String, String)>,
    pub rounds: f32,
    pub view_size: (f32, f32),
    pub clock: DayClock,
    t: f32,
    layer: Option<(u32, Arc<RgbaImage>)>,
}

impl TreeScene {
    pub fn new(atlas: Arc<Atlas>) -> TreeScene {
        TreeScene {
            atlas,
            genes: genome(20261022),
            memories: mock_memories(),
            texts: std::collections::HashMap::new(),
            selected: None,
            rounds: 140.0,
            view_size: (768.0, 512.0),
            clock: DayClock {
                tod: 0.7,
                ..DayClock::default()
            },
            t: 0.0,
            layer: None,
        }
    }

    pub fn set_memories(&mut self, rows: Vec<(String, Kind, String)>) {
        self.selected = None;
        self.memories.clear();
        self.texts.clear();
        for (id, kind, text) in rows {
            self.memories.push(Memory {
                id: id.clone(),
                kind,
                fading: false,
            });
            self.texts.insert(id, text);
        }
        self.rounds = (self.memories.len() as f32 * 4.5).clamp(40.0, 600.0);
        self.layer = None;
    }

    pub fn tap(&mut self, p: super::level::Point) {
        let bx = (KNOLL.0 * W).round();
        let by = (KNOLL.1 * H).round();
        let grown = grow_tree(&self.genes, &self.memories, self.growth(), 118.0, 0.0);
        let mut best: Option<(f32, &Placed)> = None;
        for item in grown.fruits.iter().chain(grown.seeds.iter()).chain(grown.leaves.iter()) {
            let ix = bx + item.x;
            let iy = by - item.y;
            let dist = ((p.x - ix).powi(2) + (p.y - iy).powi(2)).sqrt();
            if dist <= 18.0 && best.as_ref().is_none_or(|(d, _)| dist < *d) {
                best = Some((dist, item));
            }
        }
        if let Some((_, placed)) = best {
            let kind_label = match placed.memory.kind {
                Kind::Leaf => "web.farm.native.leaf",
                Kind::Fruit => "web.farm.native.fruit",
                Kind::Seed => "web.farm.native.seed",
            };
            let text = self.texts.get(&placed.memory.id).cloned().unwrap_or_else(|| placed.memory.id.clone());
            self.selected = Some((t(kind_label, &[]), text));
        } else {
            self.selected = None;
        }
    }

    pub fn tick(&mut self, dt: f32) {
        self.t += dt.min(0.1);
        self.clock.advance(dt.min(0.1));
    }

    pub fn growth(&self) -> f32 {
        growth_of(self.rounds)
    }

    pub fn draw(&mut self) -> DrawList {
        let mut list = DrawList::new(W, H, rgba(0xe8b096, 1.0));
        let night = super::sky::sky_at(self.clock.tod).night;
        // The backdrops are one pixel per scene pixel, not the atlas's density: drawn as pictures.
        for (name, alpha) in [("tree-hill", 1.0), ("tree-hill-night", night)] {
            if alpha > 0.02
                && let Some(image) = self.atlas.image(name)
            {
                list.ops.push(Op::Image {
                    key: name.into(),
                    image,
                    x: 0.0,
                    y: 0.0,
                    w: W,
                    h: H,
                    alpha,
                });
            }
        }
        // The crown sways in the wind; it is repainted eight times a second.
        let step = (self.t * 8.0) as u32;
        if self.layer.as_ref().map(|l| l.0) != Some(step) {
            let sway = (self.t * 0.9).sin() * 0.025;
            let grown = grow_tree(&self.genes, &self.memories, self.growth(), 118.0, sway);
            let mut canvas = Canvas(RgbaImage::new(W as u32, H as u32));
            paint_tree(&mut canvas, &grown, self.growth(), (KNOLL.0 * W).round(), (KNOLL.1 * H).round());
            self.layer = Some((step, Arc::new(canvas.0)));
        }
        if let Some((step, img)) = &self.layer {
            list.ops.push(Op::Image {
                key: format!("tree:{step}"),
                image: img.clone(),
                x: 0.0,
                y: 0.0,
                w: W,
                h: H,
                alpha: 1.0,
            });
        }
        if night > 0.3 {
            for i in 0..14 {
                let x = ((self.t / (6.0 + i as f32 * 2.5) * 10.0 + i as f32 * 170.0) % (W + 40.0)) - 20.0;
                let y = 60.0 + (hash01(&format!("ff{i}")) * 120.0) + (self.t * 1.3 + i as f32).sin() * 4.0;
                let on = ((self.t * 2.0 + i as f32).sin() + 1.0) / 2.0;
                list.ops.push(Op::Glow {
                    x,
                    y,
                    r: 3.0,
                    color: [1.0, 0.95, 0.55, 0.8 * on * night],
                });
            }
        }
        let leaves = self.memories.iter().filter(|m| m.kind == Kind::Leaf).count();
        let fruits = self.memories.iter().filter(|m| m.kind == Kind::Fruit).count();
        let seeds = self.memories.iter().filter(|m| m.kind == Kind::Seed).count();
        let ink = rgba(0x3b2a1a, 1.0);
        list.hud_view = true;
        let width = (self.view_size.0 - 24.0).clamp(1.0, 420.0);
        let counts = t(
            "web.farm.native.treeCounts",
            &[
                ("leaves", (leaves as i64).into()),
                ("fruits", (fruits as i64).into()),
                ("seeds", (seeds as i64).into()),
            ],
        );
        let rounds = t(
            "web.farm.native.treeGrowth",
            &[
                ("rounds", (self.rounds as f64).into()),
                ("growth", (self.growth() as f64 * 100.0).round().into()),
            ],
        );
        list.hud.push(HudOp::Rect {
            x: 12.0,
            y: 12.0,
            w: width,
            h: 72.0,
            color: rgba(0xfdf6e3, 0.96),
            border: Some(ink),
        });
        for (i, line) in [t("web.farm.native.tree", &[]), counts, rounds].into_iter().enumerate() {
            list.hud.push(HudOp::TextIn {
                x: 22.0,
                y: 20.0 + i as f32 * 20.0,
                w: (width - 20.0).max(1.0),
                text: line,
                size: 12.0,
                color: ink,
            });
        }
        if let Some((kind_label, text)) = &self.selected {
            list.hud.push(HudOp::Rect {
                x: 12.0,
                y: 92.0,
                w: width,
                h: 48.0,
                color: rgba(0xfdf6e3, 0.96),
                border: Some(ink),
            });
            for (i, line) in [kind_label, text].iter().enumerate() {
                list.hud.push(HudOp::TextIn {
                    x: 22.0,
                    y: 100.0 + i as f32 * 20.0,
                    w: (width - 20.0).max(1.0),
                    text: line.to_string(),
                    size: 12.0,
                    color: ink,
                });
            }
        }
        list
    }

    pub fn debug_state(&self) -> serde_json::Value {
        let grown = grow_tree(&self.genes, &self.memories, self.growth(), 118.0, 0.0);
        serde_json::json!({
            "genes": self.genes.len(), "growth": self.growth(), "segments": grown.segments.len(),
            "clumps": grown.clumps.len(), "leaves": grown.leaves.len(), "fruits": grown.fruits.len(), "seeds": grown.seeds.len(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn grows_with_the_rounds() {
        let genes = genome(20261022);
        assert!(genes.len() > 60);
        let items = mock_memories();
        let young = grow_tree(&genes, &items, growth_of(0.0), 118.0, 0.0);
        let old = grow_tree(&genes, &items, growth_of(600.0), 118.0, 0.0);
        assert_eq!(young.segments.len(), 1, "a sprout has only its trunk");
        assert_eq!(old.segments.len(), genes.len());
        assert!(old.seeds.len() == 6 && young.seeds.is_empty());
        assert_eq!(growth_of(600.0), 1.0);
        // hash01 is FNV-1a as VibeValley's.
        assert!((0.0..1.0).contains(&hash01("leaf-1")));
    }
}
