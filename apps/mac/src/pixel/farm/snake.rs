#[derive(Debug, Clone)]
pub struct SnakeGame {
    pub body: Vec<(i32, i32)>,
    pub dir: (i32, i32),
    pub bug: (i32, i32),
    pub score: u32,
    pub over: bool,
    step_at: f32,
    next_dir: (i32, i32),
}

impl Default for SnakeGame {
    fn default() -> Self {
        Self::new()
    }
}

impl SnakeGame {
    pub fn new() -> Self {
        SnakeGame {
            body: vec![(6, 5), (5, 5), (4, 5)],
            dir: (1, 0),
            bug: (11, 5),
            score: 0,
            over: false,
            step_at: 0.0,
            next_dir: (1, 0),
        }
    }

    pub fn steer(&mut self, dx: i32, dy: i32) {
        if dx.abs() + dy.abs() == 1 && (self.dir.0 + dx != 0 || self.dir.1 + dy != 0) {
            self.next_dir = (dx, dy);
        }
    }

    pub fn tick(&mut self, t: f32, rng: u64) {
        if self.over || t < self.step_at {
            return;
        }
        self.step_at = t + 0.18;
        self.dir = self.next_dir;
        let head = self.body[0];
        let nx = (head.0 + self.dir.0).rem_euclid(16);
        let ny = (head.1 + self.dir.1).rem_euclid(10);
        let eating = (nx, ny) == self.bug;
        let occupied = if eating { &self.body[..] } else { &self.body[..self.body.len() - 1] };
        if occupied.contains(&(nx, ny)) {
            self.over = true;
            return;
        }
        self.body.insert(0, (nx, ny));
        if (nx, ny) == self.bug {
            self.score += 10;
            let empty: Vec<_> = (0..10).flat_map(|y| (0..16).map(move |x| (x, y))).filter(|p| !self.body.contains(p)).collect();
            if empty.is_empty() {
                self.over = true;
            } else {
                self.bug = empty[(rng.wrapping_add(self.score as u64) % empty.len() as u64) as usize];
            }
        } else {
            self.body.pop();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn regression_two_turns_before_a_tick_cannot_reverse_into_the_body() {
        let mut game = SnakeGame::new();
        game.steer(0, -1);
        game.steer(-1, 0);
        game.tick(1.0, 0);
        assert_eq!(game.body[0], (6, 4));
        assert!(!game.over);
    }

    #[test]
    fn regression_a_vacating_tail_is_not_a_collision() {
        let mut game = SnakeGame::new();
        game.body = vec![(1, 1), (2, 1), (2, 2), (1, 2)];
        game.dir = (-1, 0);
        game.steer(0, 1);
        game.tick(1.0, 0);
        assert_eq!(game.body[0], (1, 2));
        assert!(!game.over);
    }

    #[test]
    fn food_moves_to_a_free_cell_after_eating() {
        let mut game = SnakeGame::new();
        game.bug = (7, 5);
        game.tick(1.0, 12);
        assert_eq!(game.score, 10);
        assert_eq!(game.body.len(), 4);
        assert!(!game.body.contains(&game.bug));
    }
}
