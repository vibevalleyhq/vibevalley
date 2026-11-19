use serde::{Deserialize, Serialize};

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Motion {
    pub seq: u64,
    pub ticks: u32,
    pub firefly_seed: u32,
    pub tod: f32,
    #[serde(skip_deserializing)]
    advanced: u32,
}

impl Motion {
    pub fn read() -> Option<Self> {
        if !cfg!(feature = "shot") {
            return None;
        }
        let input = std::env::var("VIBEVALLEY_FARM_CAPTURE_MOTION").ok()?;
        Some(serde_json::from_str(&input).expect("invalid VIBEVALLEY_FARM_CAPTURE_MOTION"))
    }

    pub fn next(&mut self, seq: u64) -> Option<f64> {
        if seq != self.seq || self.advanced == self.ticks {
            return None;
        }
        self.advanced += 1;
        Some(1.0 / 60.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn regression_capture_steps_only_its_requested_frame() {
        let mut motion: Motion = serde_json::from_value(serde_json::json!({"seq":17,"ticks":2,"fireflySeed":0,"tod":0.95})).unwrap();
        assert_eq!(motion.next(1), None);
        assert_eq!(motion.next(17), Some(1. / 60.));
        assert_eq!(motion.next(18), None);
        assert_eq!(motion.next(17), Some(1. / 60.));
        assert_eq!(motion.next(17), None);
        assert_eq!(motion.advanced, 2);
    }
}
