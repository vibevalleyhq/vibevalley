//! `village.ldtk`: the Ground int grid (1 is walkable) and the Things layer's
//! entities, as VibeValley's `farm/world/level.ts` reads them.

use std::collections::HashMap;

use serde::Deserialize;
use serde_json::Value;

#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct Point {
    pub x: f32,
    pub y: f32,
}

pub const fn pt(x: f32, y: f32) -> Point {
    Point { x, y }
}

impl std::ops::Add for Point {
    type Output = Point;
    fn add(self, o: Point) -> Point {
        pt(self.x + o.x, self.y + o.y)
    }
}

/// Half-open: `x0 <= x < x1`.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct Box2 {
    pub x0: f32,
    pub y0: f32,
    pub x1: f32,
    pub y1: f32,
}

impl Box2 {
    pub fn contains(&self, p: Point) -> bool {
        p.x >= self.x0 && p.x < self.x1 && p.y >= self.y0 && p.y < self.y1
    }
}

#[derive(Debug, Clone)]
pub struct Thing {
    pub at: Point,
    pub bx: Box2,
    pub fields: HashMap<String, Value>,
}

impl Thing {
    pub fn num(&self, name: &str) -> f64 {
        self.fields.get(name).and_then(Value::as_f64).unwrap_or(0.0)
    }
    pub fn text(&self, name: &str) -> String {
        match self.fields.get(name) {
            Some(Value::String(s)) => s.clone(),
            Some(Value::Null) | None => String::new(),
            Some(v) => v.to_string(),
        }
    }
}

#[derive(Deserialize)]
struct RawFile {
    levels: Vec<RawLevel>,
}
#[derive(Deserialize)]
struct RawLevel {
    #[serde(rename = "pxWid")]
    px_wid: f32,
    #[serde(rename = "pxHei")]
    px_hei: f32,
    #[serde(rename = "layerInstances")]
    layers: Vec<RawLayer>,
}
#[derive(Deserialize)]
struct RawLayer {
    __identifier: String,
    #[serde(rename = "__cWid")]
    c_wid: i32,
    #[serde(rename = "__cHei")]
    c_hei: i32,
    #[serde(rename = "__gridSize")]
    grid: f32,
    #[serde(rename = "intGridCsv", default)]
    int_grid: Vec<i32>,
    #[serde(rename = "entityInstances", default)]
    entities: Vec<RawEntity>,
}
#[derive(Deserialize)]
struct RawEntity {
    __identifier: String,
    px: (f32, f32),
    width: f32,
    height: f32,
    __pivot: (f32, f32),
    #[serde(rename = "fieldInstances", default)]
    fields: Vec<RawField>,
}
#[derive(Deserialize)]
struct RawField {
    __identifier: String,
    #[serde(default)]
    __value: Value,
}

#[derive(Clone)]
pub struct Level {
    pub width: f32,
    pub height: f32,
    ground: Vec<i32>,
    c_wid: i32,
    c_hei: i32,
    grid: f32,
    things: HashMap<String, Vec<Thing>>,
}

impl Level {
    pub fn parse(text: &str) -> Result<Level, String> {
        let file: RawFile = serde_json::from_str(text).map_err(|e| format!("village.ldtk: {e}"))?;
        let level = file.levels.into_iter().next().ok_or("village.ldtk: no level")?;
        let mut ground = None;
        let mut things: HashMap<String, Vec<Thing>> = HashMap::new();
        for layer in level.layers {
            match layer.__identifier.as_str() {
                "Things" => {
                    for e in layer.entities {
                        let (x, y) = e.px;
                        let x0 = x - e.__pivot.0 * e.width;
                        let y0 = y - e.__pivot.1 * e.height;
                        let fields = e.fields.into_iter().map(|f| (f.__identifier, f.__value)).collect();
                        things.entry(e.__identifier).or_default().push(Thing {
                            at: pt(x, y),
                            bx: Box2 {
                                x0,
                                y0,
                                x1: x0 + e.width,
                                y1: y0 + e.height,
                            },
                            fields,
                        });
                    }
                }
                "Ground" => ground = Some(layer),
                _ => {}
            }
        }
        let g = ground.ok_or("village.ldtk: no layer Ground")?;
        Ok(Level {
            width: level.px_wid,
            height: level.px_hei,
            ground: g.int_grid,
            c_wid: g.c_wid,
            c_hei: g.c_hei,
            grid: g.grid,
            things,
        })
    }

    /// In file order.
    pub fn things_of(&self, kind: &str) -> &[Thing] {
        self.things.get(kind).map(Vec::as_slice).unwrap_or(&[])
    }

    pub fn the_thing(&self, kind: &str) -> Result<&Thing, String> {
        self.things_of(kind).first().ok_or_else(|| format!("village.ldtk: no {kind}"))
    }

    /// Past the right edge the road goes on, as the edge column does.
    pub fn ground1(&self, p: Point) -> bool {
        let cx = ((p.x / self.grid).floor() as i32).clamp(-1, self.c_wid - 1);
        let cy = (p.y / self.grid).floor() as i32;
        if cx < 0 || cy < 0 || cy >= self.c_hei {
            return false;
        }
        self.ground.get((cy * self.c_wid + cx) as usize) == Some(&1)
    }
}
