use super::types::{IshikawaModel, IshikawaNode};

pub struct IshikawaDb {
    title: Option<String>,
    stack: Vec<(usize, IshikawaNode)>,
    base_level: Option<usize>,
}

impl IshikawaDb {
    pub fn new(title: Option<String>) -> Self {
        Self {
            title,
            stack: Vec::new(),
            base_level: None,
        }
    }

    /// First line is the effect. Later lines nest by indentation relative to the first cause.
    pub fn add_node(&mut self, raw_level: usize, text: String) {
        let node = IshikawaNode { text, children: Vec::new() };
        if self.stack.is_empty() {
            self.stack.push((0, node));
            return;
        }
        let base = *self.base_level.get_or_insert(raw_level);
        let level = (raw_level as isize - base as isize + 1).max(1) as usize;
        while self.stack.len() > 1 && self.stack.last().unwrap().0 >= level {
            let (_, finished) = self.stack.pop().unwrap();
            self.stack.last_mut().unwrap().1.children.push(finished);
        }
        self.stack.push((level, node));
    }

    pub fn finish(mut self) -> IshikawaModel {
        while self.stack.len() > 1 {
            let (_, finished) = self.stack.pop().unwrap();
            self.stack.last_mut().unwrap().1.children.push(finished);
        }
        IshikawaModel {
            title: self.title,
            root: self.stack.pop().map(|(_, node)| node),
        }
    }
}
