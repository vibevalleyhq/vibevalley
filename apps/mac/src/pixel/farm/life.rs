use super::super::{
    atlas::Atlas,
    draw::{DrawList, Op, glow_image, rgba},
    level::{Box2, Point, pt},
};
use super::world::VillageWorld;
use image::RgbaImage;
use std::{collections::HashMap, sync::Arc};
use vibevalley_pixel::PointLight;

struct Random(u64);
impl Random {
    fn unit(&mut self) -> f32 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        (self.0 >> 40) as f32 / 16777216.
    }
    fn range(&mut self, lo: f32, hi: f32) -> f32 {
        lo + self.unit() * (hi - lo)
    }
    fn point(&mut self, b: Box2) -> Point {
        pt(self.range(b.x0, b.x1), self.range(b.y0, b.y1))
    }
}
fn region(x0: f32, y0: f32, x1: f32, y1: f32) -> Box2 {
    Box2 { x0, y0, x1, y1 }
}
#[derive(Clone, Copy, PartialEq)]
enum Layer {
    World,
    Glow,
    Mark,
}
#[derive(Clone, Copy)]
enum Picture {
    Dot(u32, f32),
    Puff(u32, f32),
    Glyph(&'static [&'static str], u32),
    Sprite(&'static str),
    Ring { color: u32, end: f32, squash: f32 },
}
const HEART: &[&str] = &[".#.#.", "#####", ".###.", "..#.."];
const ZED: &[&str] = &["####", "..#.", ".#..", "####"];
const STAR: &[&str] = &[".#.", "###", ".#."];
struct DotMotion {
    velocity: Box2,
    fall: f32,
    life: (f32, f32),
    size: f32,
}

struct Bit {
    at: Point,
    velocity: Point,
    fall: f32,
    sway: f32,
    drift: f32,
    grow: f32,
    alpha: f32,
    age: f32,
    life: f32,
    layer: Layer,
    pic: Picture,
}
impl Bit {
    fn new(layer: Layer, pic: Picture, at: Point, life: f32) -> Self {
        Self {
            at,
            life,
            layer,
            pic,
            velocity: pt(0., 0.),
            fall: 0.,
            sway: 0.,
            drift: 0.,
            grow: 0.,
            alpha: 1.,
            age: 0.,
        }
    }
}
struct Butterfly {
    home: Point,
    at: Point,
    heading: f32,
    phase: f32,
    rest: f32,
}
struct Firefly {
    home: Point,
    phase: f32,
    speed: f32,
    blink: f32,
}
struct Bird {
    x: f32,
    y: f32,
    speed: f32,
    phase: f32,
}
pub struct Activity<'a> {
    pub walkers: &'a [Point],
    pub library: bool,
    pub workshop: bool,
    pub mast: bool,
    pub bench: bool,
    pub ripe: &'a [Box2],
    pub sleeping: bool,
}
pub struct Life {
    random: Random,
    due_times: HashMap<(&'static str, usize), f32>,
    bits: Vec<Bit>,
    butterflies: Vec<Butterfly>,
    flies: Vec<Firefly>,
    birds: Vec<Bird>,
    chimney: Vec<Box2>,
    pond: Vec<Box2>,
    mast: Option<Point>,
    anvil: Option<Point>,
    map: Option<Arc<RgbaImage>>,
    density: f32,
    flash: f32,
    wings: [(Arc<RgbaImage>, Arc<RgbaImage>); 3],
}
fn tint(image: Option<Arc<RgbaImage>>, c: u32) -> Arc<RgbaImage> {
    let mut image = image.as_deref().cloned().unwrap_or_else(|| RgbaImage::new(1, 1));
    let tint = rgba(c, 1.);
    for p in image.pixels_mut() {
        for i in 0..3 {
            p[i] = (p[i] as f32 * tint[i]).round() as u8;
        }
    }
    Arc::new(image)
}
#[derive(Clone, Copy, PartialEq)]
enum Ground {
    Pond,
    Soil,
    Leaves,
    Stone,
}
impl Life {
    pub fn new(w: &VillageWorld, atlas: &Atlas) -> Self {
        let mut rng = Random(0x65a6d105fe1cb69d);
        let meadows = [region(12., 110., 90., 215.), region(300., 140., 380., 200.), region(90., 92., 300., 110.)];
        let butterflies = (0..5)
            .map(|i| {
                let home = rng.point(meadows[i % 3]);
                Butterfly {
                    home,
                    at: home,
                    heading: rng.unit() * std::f32::consts::TAU,
                    phase: rng.unit() * 6.,
                    rest: 0.,
                }
            })
            .collect();
        let flies = (0..12)
            .map(|_| Firefly {
                home: rng.point(region(40., 100., 330., 236.)),
                phase: rng.unit() * 10.,
                speed: rng.range(0.25, 0.6),
                blink: rng.range(1.8, 3.4),
            })
            .collect();
        let zones = |k: &str| w.level.things_of("Fx").iter().filter(|e| e.text("kind") == k).map(|e| e.bx).collect::<Vec<_>>();
        let top = |k: &str| zones(k).first().map(|b| pt((b.x0 + b.x1) / 2., b.y0));
        let wings =
            [0xf6f1e4, 0xf5d76e, 0xf2a6b8].map(|color| (tint(atlas.image("critter-butterfly-1"), color), tint(atlas.image("critter-butterfly-2"), color)));
        Self {
            random: rng,
            due_times: HashMap::new(),
            bits: Vec::new(),
            birds: Vec::new(),
            butterflies,
            flies,
            chimney: zones("chimney"),
            pond: zones("pond"),
            mast: top("mast"),
            anvil: top("anvil"),
            map: atlas.image("map"),
            density: atlas.density,
            flash: 0.,
            wings,
        }
    }
    fn ground(&self, at: Point) -> Option<Ground> {
        let map = self.map.as_ref()?;
        if at.x < 0. || at.y < 0. {
            return None;
        }
        let p = map.get_pixel_checked((at.x * self.density) as u32, (at.y * self.density) as u32)?;
        let [r, g, b] = [p[0], p[1], p[2]].map(f32::from);
        let max = r.max(g).max(b);
        let d = max - r.min(g).min(b);
        if max == 0. || d / max < 0.18 {
            return Some(Ground::Stone);
        }
        let hue = (60.
            * if max == r {
                (g - b) / d
            } else if max == g {
                2. + (b - r) / d
            } else {
                4. + (r - g) / d
            })
        .rem_euclid(360.);
        Some(if (165. ..250.).contains(&hue) && self.pond.iter().any(|b| b.contains(at)) {
            Ground::Pond
        } else if (45. ..165.).contains(&hue) {
            Ground::Leaves
        } else if (20. ..45.).contains(&hue) && d / max > 0.45 && max > 153. {
            Ground::Soil
        } else {
            Ground::Stone
        })
    }
    fn placed(&mut self, b: Box2, ground: Ground) -> Option<Point> {
        (0..8).find_map(|_| {
            let p = self.random.point(b);
            (self.ground(p) == Some(ground)).then_some(p)
        })
    }
    fn due(&mut self, key: &'static str, n: usize, t: f32, interval: f32) -> bool {
        let next = self.due_times.entry((key, n)).or_insert_with(|| t + self.random.unit() * interval);
        if t < *next {
            return false;
        }
        *next = t + interval * self.random.range(0.7, 1.3);
        true
    }
    fn dot_burst(&mut self, layer: Layer, at: Point, count: usize, colors: &[u32], motion: DotMotion) {
        let DotMotion { velocity, fall, life, size } = motion;
        for i in 0..count {
            let mut b = Bit::new(layer, Picture::Dot(colors[i % colors.len()], size), at, self.random.range(life.0, life.1));
            b.velocity = self.random.point(velocity);
            b.fall = fall;
            self.bits.push(b);
        }
    }
    pub fn poke(&mut self, at: Point) -> Option<&'static str> {
        let ground = self.ground(at)?;
        self.bits.push(Bit::new(
            Layer::Mark,
            Picture::Ring {
                color: 0xfff6d8,
                end: 5.,
                squash: 0.5,
            },
            at,
            0.35,
        ));
        let sound = match ground {
            Ground::Pond => {
                self.dot_burst(
                    Layer::World,
                    at,
                    8,
                    &[0xcfeff2],
                    DotMotion {
                        velocity: region(-25., -55., 25., -25.),
                        fall: 170.,
                        life: (0.4, 0.6),
                        size: 1.,
                    },
                );
                for (end, life) in [(7., 0.9), (4., 0.6)] {
                    self.bits.push(Bit::new(
                        Layer::World,
                        Picture::Ring {
                            color: 0xbfe3e6,
                            end,
                            squash: 0.45,
                        },
                        at,
                        life,
                    ));
                }
                "splash"
            }
            Ground::Leaves => {
                self.dot_burst(
                    Layer::World,
                    at,
                    7,
                    &[0x9dbb4e, 0x7d9a3a, 0xc8d36a],
                    DotMotion {
                        velocity: region(-22., -42., 22., -16.),
                        fall: 110.,
                        life: (0.5, 0.75),
                        size: 1.,
                    },
                );
                self.dot_burst(
                    Layer::World,
                    at,
                    2,
                    &[0x8aa43a, 0xc9a23a],
                    DotMotion {
                        velocity: region(-6., -10., 6., -4.),
                        fall: 14.,
                        life: (1.2, 1.8),
                        size: 2.,
                    },
                );
                "rustle"
            }
            Ground::Soil => {
                self.dot_burst(
                    Layer::World,
                    at,
                    10,
                    &[0xf6e3bd, 0xe9cfa0, 0xfff2d6],
                    DotMotion {
                        velocity: region(-28., -24., 28., -6.),
                        fall: 40.,
                        life: (0.35, 0.6),
                        size: 1.,
                    },
                );
                "thud"
            }
            Ground::Stone => {
                self.dot_burst(
                    Layer::Glow,
                    at,
                    4,
                    &[0xfff6d8],
                    DotMotion {
                        velocity: region(-20., -28., 20., -8.),
                        fall: 60.,
                        life: (0.3, 0.3),
                        size: 1.,
                    },
                );
                "tap"
            }
        };
        Some(sound)
    }
    pub fn heart(&mut self, at: Point) {
        let mut b = Bit::new(Layer::Mark, Picture::Glyph(HEART, 0xff7a9a), at, 1.1);
        b.velocity.y = -12.;
        b.sway = 2.;
        self.bits.push(b);
    }
    pub fn bed(&mut self, at: Point, tool: super::scene::FarmTool) {
        use super::scene::FarmTool;
        match tool {
            FarmTool::Water => {
                for i in 0..14 {
                    let p = pt(at.x + self.random.range(-12., 12.), at.y - self.random.range(14., 26.));
                    self.dot_burst(
                        Layer::World,
                        p,
                        1,
                        &[if i % 3 == 0 { 0xc8e6f7 } else { 0x6fb3e0 }],
                        DotMotion {
                            velocity: region(0., 10., 0., 30.),
                            fall: 160.,
                            life: (0.35, 0.6),
                            size: 1.,
                        },
                    );
                }
            }
            FarmTool::Bug => self.dot_burst(
                Layer::World,
                at,
                12,
                &[0xf4f1e6],
                DotMotion {
                    velocity: region(-24., -26., 24., -6.),
                    fall: 0.,
                    life: (0.5, 0.9),
                    size: 2.,
                },
            ),
            FarmTool::Shovel => self.dot_burst(
                Layer::World,
                at,
                12,
                &[0x5d4429, 0x8a6a45],
                DotMotion {
                    velocity: region(-30., -50., 30., -20.),
                    fall: 140.,
                    life: (0.4, 0.7),
                    size: 2.,
                },
            ),
            FarmTool::Harvest => {
                let mut b = Bit::new(Layer::World, Picture::Sprite("icon-harvest"), at, 1.1);
                b.velocity.y = -38.;
                b.fall = 30.;
                self.bits.push(b);
                self.dot_burst(
                    Layer::World,
                    at,
                    10,
                    &[0xf2c14e],
                    DotMotion {
                        velocity: region(-30., -60., 30., -30.),
                        fall: 150.,
                        life: (0.5, 0.8),
                        size: 1.,
                    },
                );
            }
            _ => {}
        }
    }
    pub fn coin(&mut self, at: Point) {
        let mut b = Bit::new(Layer::World, Picture::Sprite("icon-coin"), at, 1.15);
        b.velocity.y = -35.;
        b.fall = 32.;
        self.bits.push(b);
    }
    pub fn step(&mut self, w: &VillageWorld, t: f32, dt: f32, night: f32, f: Activity) {
        let day = (1. - night * 1.6).max(0.);
        let wind = 0.55 + 0.45 * (t * 0.21).sin() * (t * 0.067 + 1.).sin();
        for i in 0..self.chimney.len() {
            let b = self.chimney[i];
            let at = pt((b.x0 + b.x1) / 2., b.y0);
            let busy = f.workshop && w.spot_boxes.iter().any(|(k, b)| *k == "runtimes" && b.contains(at));
            if self.due("smoke", i, t, if busy { 0.22 } else { 0.45 }) {
                let mut p = Bit::new(
                    Layer::World,
                    Picture::Puff(0xebe6dc, 4.),
                    pt(at.x + self.random.range(-1., 1.), at.y),
                    self.random.range(2.6, 3.4),
                );
                p.velocity.y = self.random.range(-7., -5.);
                p.drift = 6.;
                p.sway = 1.;
                p.grow = 0.7;
                p.alpha = if night > 0.5 { 0.45 } else { 0.72 };
                self.bits.push(p);
            }
        }
        if self.due("leaves", 0, t, 2.6 / (0.4 + wind))
            && let Some(at) = self
                .placed(region(0., 26., w.level.width, 70.), Ground::Leaves)
                .or_else(|| self.placed(region(0., 100., 70., 220.), Ground::Leaves))
        {
            let sprite = if self.random.unit() < 0.5 { "critter-leaf-1" } else { "critter-leaf-2" };
            let mut b = Bit::new(Layer::World, Picture::Sprite(sprite), at, self.random.range(3.5, 5.5));
            b.velocity.y = self.random.range(6., 10.);
            b.drift = 10.;
            b.sway = 6.;
            self.bits.push(b);
        }
        for i in 0..self.pond.len() {
            let p = self.pond[i];
            if self.due("ripple", i, t, 1.2)
                && let Some(at) = self.placed(p, Ground::Pond)
            {
                self.bits.push(Bit::new(
                    Layer::World,
                    Picture::Ring {
                        color: 0xbfe3e6,
                        end: self.random.range(4., 7.),
                        squash: 0.45,
                    },
                    at,
                    1.3,
                ));
            }
            if day > 0.3
                && self.due("glint", i, t, 0.12)
                && let Some(at) = self.placed(p, Ground::Pond)
            {
                self.bits.push(Bit::new(Layer::Glow, Picture::Dot(0xfffbe8, 1.), at, 0.3));
            }
            if self.due("fish", i, t, 18.)
                && let Some(at) = self.placed(p, Ground::Pond)
            {
                let mut b = Bit::new(Layer::World, Picture::Sprite("critter-fish-1"), at, 0.6);
                b.velocity = pt(self.random.range(14., 22.) * if self.random.unit() < 0.5 { -1. } else { 1. }, -30.);
                b.fall = 100.;
                self.bits.push(b);
                self.bits.push(Bit::new(
                    Layer::World,
                    Picture::Ring {
                        color: 0xbfe3e6,
                        end: 5.,
                        squash: 0.45,
                    },
                    at,
                    0.8,
                ));
            }
        }
        if f.sleeping && self.due("dog", 0, t, 1.8) {
            self.zzz(w.dog + pt(5., -13.));
        }
        if f.bench
            && self.due("bench", 0, t, 1.6)
            && let Some((bench, _)) = w.places.get("bench")
        {
            self.zzz(*bench + pt(2., -26.));
        }
        if f.library
            && self.due("pages", 0, t, 0.45)
            && let Some((p, _)) = w.places.get("library")
        {
            let mut b = Bit::new(Layer::World, Picture::Dot(0xf3efe3, 2.), *p + pt(self.random.range(-8., 8.), -18.), 1.6);
            b.velocity.y = self.random.range(-8., -4.);
            b.sway = 4.;
            b.drift = 0.4;
            self.bits.push(b);
        }
        if f.workshop
            && self.due("anvil", 0, t, 0.3)
            && let Some(at) = self.anvil
        {
            self.dot_burst(
                Layer::Glow,
                at,
                4,
                &[0xffd27a, 0xffb347, 0xfff1c2],
                DotMotion {
                    velocity: region(-32., -48., 32., -20.),
                    fall: 130.,
                    life: (0.3, 0.6),
                    size: 1.,
                },
            );
            self.flash = 0.16;
        }
        self.flash = (self.flash - dt).max(0.);
        if f.mast
            && self.due("waves", 0, t, 0.6)
            && let Some(at) = self.mast
        {
            self.bits.push(Bit::new(
                Layer::Glow,
                Picture::Ring {
                    color: 0x8fe3ff,
                    end: 14.,
                    squash: 1.,
                },
                at,
                0.9,
            ));
        }
        if self.due("dust", 0, t, 0.16) {
            for &at in f.walkers {
                let m = self.ground(at);
                if m == Some(Ground::Soil) || m == Some(Ground::Leaves) && self.random.unit() < 0.35 {
                    let mut b = Bit::new(
                        Layer::World,
                        Picture::Dot(if m == Some(Ground::Soil) { 0xf6e3bd } else { 0x9dbb4e }, 1.),
                        at,
                        self.random.range(0.35, 0.55),
                    );
                    b.velocity = pt(self.random.range(-6., 6.), self.random.range(-6., -2.));
                    b.fall = 10.;
                    self.bits.push(b);
                }
            }
        }
        for (i, r) in f.ripe.iter().enumerate() {
            if self.due("ripe", i, t, 0.35) {
                let mut b = Bit::new(
                    Layer::Glow,
                    Picture::Glyph(STAR, 0xffe9a0),
                    pt(self.random.range(r.x0 + 2., r.x1 - 4.), self.random.range(r.y0 - 6., r.y0 + 6.)),
                    0.6,
                );
                b.velocity.y = -4.;
                self.bits.push(b);
            }
        }
        if day > 0.05 {
            for b in &mut self.butterflies {
                if t >= b.rest {
                    b.heading += (self.random.unit() - 0.5) * dt * 6.;
                    if (b.home.x - b.at.x).hypot(b.home.y - b.at.y) > 24. {
                        b.heading = (b.home.y - b.at.y).atan2(b.home.x - b.at.x);
                    }
                    b.at.x += b.heading.cos() * 14. * dt;
                    b.at.y += (b.heading.sin() * 14. * 0.65 + (t * 9. + b.phase).sin() * 4.) * dt;
                    if self.random.unit() < dt * 0.15 {
                        b.rest = t + self.random.range(1.5, 3.5);
                    }
                }
            }
        }
        if day > 0.5 && self.due("birds", 0, t, 28.) {
            let speed = self.random.range(60., 85.) * if self.random.unit() < 0.5 { -1. } else { 1. };
            let y = self.random.range(18., 120.);
            for i in 0..(2. + self.random.unit() * 3.) as usize {
                let row = (i as f32 / 2.).ceil();
                self.birds.push(Bird {
                    x: if speed < 0. { w.level.width + 10. + row * 9. } else { -10. - row * 9. },
                    y: y + if i % 2 == 1 { row * 5. } else { -row * 5. },
                    speed,
                    phase: self.random.unit() * 6.,
                });
            }
        }
        self.birds.retain_mut(|b| {
            b.x += b.speed * dt;
            b.x >= -40. && b.x <= w.level.width + 40.
        });
        self.bits.retain_mut(|b| {
            b.age += dt;
            b.velocity.y += b.fall * dt;
            b.at.x += (b.velocity.x + wind * b.drift) * dt;
            b.at.y += b.velocity.y * dt;
            b.age < b.life
        });
    }
    fn zzz(&mut self, p: Point) {
        let mut b = Bit::new(Layer::Mark, Picture::Glyph(ZED, 0xf4efe0), p, 2.2);
        b.velocity = pt(3., -5.);
        b.sway = 1.5;
        b.alpha = 0.85;
        self.bits.push(b);
    }
    pub fn draw_ground(&self, list: &mut DrawList, atlas: &Atlas, t: f32, night: f32) {
        let day = (1. - night * 1.6).max(0.);
        if day > 0.05 {
            for (i, b) in self.butterflies.iter().enumerate() {
                let open = if t < b.rest {
                    ((t + b.phase) * 1.5) as i32 % 3 == 0
                } else {
                    ((t + b.phase) * 10.) as i32 % 2 == 0
                };
                let wings = &self.wings[i % 3];
                let im = if open { &wings.0 } else { &wings.1 };
                let wh = (im.width() as f32 / self.density, im.height() as f32 / self.density);
                list.ops.push(Op::Image {
                    key: format!("butterfly:{}:{open}", i % 3),
                    image: im.clone(),
                    x: b.at.x.round() - wh.0 * 0.5,
                    y: (b.at.y - if t < b.rest { 0. } else { 4. }).round() - wh.1 * 0.5,
                    w: wh.0,
                    h: wh.1,
                    alpha: (day * 1.5).min(1.),
                });
            }
        }
        for b in &self.birds {
            let at = pt(b.x.round(), (b.y + (t * 2. + b.phase).sin()).round());
            list.rect(at.x + 7., at.y + 69., 7., 2., rgba(0x1f160c, 0.3 * day));
            centered(
                list,
                atlas,
                if ((t + b.phase) * 7.) as i32 % 2 == 0 {
                    "critter-bird-1"
                } else {
                    "critter-bird-2"
                },
                at,
                b.speed < 0.,
                1.,
            );
        }
        self.paint_bits(list, atlas, Layer::World);
    }
    pub fn draw_lights(&self, list: &mut DrawList, atlas: &Atlas, t: f32, night: f32, lamps: &mut Vec<PointLight>) {
        fn light(at: Point, z: f32, radius: f32, color: u32, intensity: f32) -> PointLight {
            let [r, g, b, _] = rgba(color, intensity);
            PointLight {
                x: at.x,
                y: at.y,
                z,
                radius,
                color: [r, g, b],
                intensity,
            }
        }
        if night > 0.4 {
            for f in &self.flies {
                let phase = t * f.speed;
                let at = pt(
                    f.home.x + (phase + f.phase).sin() * 14. + (phase * 2.3 + f.phase * 1.7).sin() * 5.,
                    f.home.y + (phase * 0.8 + f.phase).cos() * 8.,
                );
                let timing = ((t + f.phase) % f.blink) / f.blink;
                let k = if timing < 0.08 || (0.62..0.7).contains(&timing) {
                    0.5
                } else if timing < 0.62 {
                    1.
                } else {
                    0.
                };
                let a = k * ((night - 0.4) / 0.6);
                if a > 0. {
                    list.ops.push(Op::Glow {
                        x: at.x.round(),
                        y: at.y.round(),
                        r: 6.,
                        color: rgba(0xc6ff70, 0.5 * a),
                    });
                    list.rect(at.x.round(), at.y.round(), 1., 1., rgba(0xeaff9e, a));
                    lamps.push(light(at, 4., 14., 0xc6ff70, 0.85 * a));
                }
            }
        }
        if self.flash > 0.
            && let Some(at) = self.anvil
        {
            lamps.push(light(at, 8., 28., 0xffb347, 1.1));
        }
        if night > 0.3
            && t % 1.6 < 0.9
            && let Some(at) = self.mast
        {
            list.rect(at.x, at.y - 1., 1., 1., rgba(0xff5a4a, night));
            lamps.push(light(at, 6., 14., 0xff5a4a, 0.7 * night));
        }
        self.paint_bits(list, atlas, Layer::Glow);
        self.paint_bits(list, atlas, Layer::Mark);
    }
    fn paint_bits(&self, list: &mut DrawList, atlas: &Atlas, layer: Layer) {
        for b in self.bits.iter().filter(|b| b.layer == layer) {
            let k = b.age / b.life;
            let a = b.alpha * ((1. - k) * 4.).ceil() / 4.;
            let x = (b.at.x + (b.age * 3.).sin() * b.sway).round();
            let y = b.at.y.round();
            let scale = 1. + b.grow * b.age;
            match b.pic {
                Picture::Dot(c, n) => list.rect(x, y, n * scale, n * scale, rgba(c, a)),
                Picture::Puff(c, r) => {
                    let size = r * 2.;
                    list.ops.push(Op::Image {
                        key: format!("farm-puff:{c}"),
                        image: Arc::new(glow_image(size as u32, rgba(c, 1.))),
                        x: x - r * scale,
                        y: y - r * scale,
                        w: size * scale,
                        h: size * scale,
                        alpha: a,
                    });
                }
                Picture::Glyph(rows, c) => {
                    for (dy, row) in rows.iter().enumerate() {
                        for (dx, ch) in row.bytes().enumerate() {
                            if ch == b'#' {
                                list.rect(x + dx as f32, y + dy as f32, 1., 1., rgba(c, a));
                            }
                        }
                    }
                }
                Picture::Sprite(name) => centered(list, atlas, name, pt(x, y), b.velocity.x < 0., a),
                Picture::Ring { color, end, squash } => {
                    let r = (1. + (end - 1.) * k).round();
                    let h = (r * squash).round().max(1.);
                    for dx in -(r as i32)..=r as i32 {
                        let dy = ((1. - (dx as f32 / r).powi(2)).max(0.).sqrt() * h).round();
                        for yy in [y + dy, y - dy] {
                            list.rect(x + dx as f32, yy, 1., 1., rgba(color, a));
                        }
                    }
                }
            }
        }
    }
}
fn centered(list: &mut DrawList, atlas: &Atlas, name: &str, at: Point, flip: bool, alpha: f32) {
    if let Some(info) = atlas.get(name) {
        list.ops.push(Op::Sprite {
            name: name.into(),
            x: at.x - info.w / 2.,
            y: at.y - info.h / 2.,
            flip,
            alpha,
        });
    }
}
