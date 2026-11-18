#[derive(Clone, Copy)]
enum Act {
    Wake,
    Wag,
    Bark,
    Jump,
    Belly,
    Stir,
    Stretch,
    Scratch,
    Settle,
    Yawn,
    Rest,
    Look,
}

#[derive(Clone, Copy, Debug)]
pub struct Look {
    pub sprite: &'static str,
    pub lift: f32,
    pub grow: f32,
}

const fn frame(sprite: &'static str) -> Look {
    Look { sprite, lift: 0., grow: 0. }
}
fn wagon(time: f32) -> Look {
    frame(if ((time / 0.12) as u32).is_multiple_of(2) { "dog-wag-1" } else { "dog-wag-2" })
}
fn scratching(time: f32) -> Look {
    Look {
        grow: -((time / 0.08) as i32 % 2) as f32,
        ..frame("dog-scratch")
    }
}
fn poses(t: f32, seq: &[(&'static str, f32, i8, i8)]) -> Option<Look> {
    let mut elapsed = t;
    for &(name, seconds, lift, grow) in seq {
        if elapsed < seconds {
            return Some(Look {
                sprite: name,
                lift: lift.into(),
                grow: grow.into(),
            });
        }
        elapsed -= seconds;
    }
    None
}
impl Act {
    fn sample(self, t: f32) -> Option<Look> {
        match self {
            Self::Wake if t < 0.5 => poses(t, &[("dog-lie", 0.35, 0, 0), ("dog-awake", 0.15, 0, 0)]),
            Self::Wake => (t < 1.7).then(|| wagon(t - 0.5)),
            Self::Wag if t < 1.44 => Some(wagon(t)),
            Self::Wag => (t < 1.64).then(|| frame("dog-awake")),
            Self::Bark => poses(
                t,
                &[
                    ("dog-awake", 0.05, 0, -1),
                    ("dog-bark", 0.2, 0, 0),
                    ("dog-awake", 0.12, 0, 0),
                    ("dog-bark", 0.25, 0, 0),
                    ("dog-awake", 0.3, 0, 0),
                ],
            ),
            Self::Jump => poses(
                t,
                &[
                    ("dog-awake", 0.08, 0, -1),
                    ("dog-jump", 0.06, 2, 0),
                    ("dog-jump", 0.06, 4, 0),
                    ("dog-jump", 0.06, 5, 0),
                    ("dog-jump", 0.06, 5, 0),
                    ("dog-jump", 0.06, 4, 0),
                    ("dog-jump", 0.06, 2, 0),
                    ("dog-awake", 0.08, 0, -1),
                    ("dog-awake", 0.3, 0, 0),
                ],
            ),
            Self::Belly => poses(
                t,
                &[
                    ("dog-lie", 0.2, 0, 0),
                    ("dog-belly", 0.5, 0, 0),
                    ("dog-belly", 0.12, 0, 1),
                    ("dog-belly", 0.5, 0, 0),
                    ("dog-belly", 0.12, 0, 1),
                    ("dog-belly", 0.7, 0, 0),
                    ("dog-lie", 0.3, 0, 0),
                ],
            ),
            Self::Stir => poses(t, &[("dog-lie", 1.2, 0, 0), ("dog-yawn", 0.9, 0, 0), ("dog-lie", 0.9, 0, 0)]),
            Self::Stretch if t < 2.1 => poses(t, &[("dog-lie", 0.4, 0, 0), ("dog-stretch", 1.3, 0, 0), ("dog-awake", 0.4, 0, 0)]),
            Self::Stretch if t < 2.98 => Some(scratching(t - 2.1)),
            Self::Stretch => poses(t - 2.98, &[("dog-awake", 0.4, 0, 0), ("dog-lie", 0.6, 0, 0)]),
            Self::Scratch if t < 1.04 => Some(scratching(t)),
            Self::Scratch => (t < 1.24).then(|| frame("dog-awake")),
            Self::Settle => poses(t, &[("dog-yawn", 0.8, 0, 0), ("dog-lie", 1., 0, 0)]),
            Self::Yawn => poses(t, &[("dog-yawn", 0.9, 0, 0), ("dog-awake", 0.3, 0, 0)]),
            Self::Rest => (t < 4.).then(|| frame("dog-lie")),
            Self::Look => (t < 2.4).then(|| frame("dog-stand")),
        }
    }
}
#[derive(Default)]
pub struct Dog {
    act: Option<(Act, f32)>,
    awake: Option<f32>,
    pats: Vec<f32>,
    turn: usize,
    awake_due: Option<f32>,
    stir_due: Option<f32>,
}

impl Dog {
    pub fn pet(&mut self, t: f32) -> &'static str {
        self.pats.retain(|p| t - p <= 2.5);
        self.pats.push(t);
        let trick = if self.awake.is_none() {
            Act::Wake
        } else if self.pats.len() >= 3 {
            Act::Belly
        } else {
            let trick = [Act::Wag, Act::Bark, Act::Jump, Act::Belly][self.turn % 4];
            self.turn += 1;
            trick
        };
        if matches!(trick, Act::Belly) {
            self.pats.clear();
        }
        self.awake = Some(t + 7.);
        self.act = Some((trick, t));
        match trick {
            Act::Bark => "woof",
            Act::Jump => "yip",
            _ => "pant",
        }
    }

    pub fn advance(&mut self, t: f32, listening: bool, r: f32) {
        if self.act.is_some_and(|(act, at)| act.sample(t - at).is_some()) {
            return;
        }
        self.act = None;
        let awake = listening || self.awake.is_some_and(|until| t < until);
        if !awake && self.awake.take().is_some() {
            self.act = Some((Act::Settle, t));
            return;
        }
        if awake {
            self.awake.get_or_insert(f32::NEG_INFINITY);
        }
        let (next, interval) = if awake { (&mut self.awake_due, 6.) } else { (&mut self.stir_due, 40.) };
        let next = next.get_or_insert(t + r * interval);
        if t >= *next {
            *next = t + interval * (0.7 + 0.6 * r);
            let act = if awake {
                match (r * 10.) as u8 {
                    0..=3 => Act::Wag,
                    4..=5 => Act::Scratch,
                    6 => Act::Yawn,
                    7..=8 => Act::Rest,
                    _ => Act::Look,
                }
            } else if r < 0.6 {
                Act::Stir
            } else {
                Act::Stretch
            };
            self.act = Some((act, t));
        }
    }

    pub fn look(&self, t: f32, pointed: bool) -> Look {
        if let Some(pose) = self.act.and_then(|(act, at)| act.sample(t - at)) {
            return pose;
        }
        match (self.awake.is_some(), pointed) {
            (true, true) => wagon(t),
            (true, false) => frame("dog-awake"),
            (false, true) => frame("dog-lie"),
            (false, false) => Look {
                grow: (t / 1.6).floor() % 2.,
                ..frame("dog-sleep")
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn third_quick_pat_rolls_over_and_a_call_keeps_the_dog_awake() {
        let mut dog = Dog::default();
        dog.pet(1.);
        dog.pet(1.4);
        dog.pet(1.8);
        assert_eq!(dog.look(2.2, false).sprite, "dog-belly");
        dog.advance(11., true, 0.5);
        assert_eq!(dog.look(11., false).sprite, "dog-awake");
        dog.advance(11.2, false, 0.5);
        assert_eq!(dog.look(11.2, false).sprite, "dog-yawn");
    }
}
