#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IshikawaNode {
    pub text: String,
    pub children: Vec<IshikawaNode>,
}

impl Drop for IshikawaNode {
    fn drop(&mut self) {
        let mut stack = std::mem::take(&mut self.children);
        while let Some(mut node) = stack.pop() {
            stack.append(&mut node.children);
        }
    }
}

/// The root is the effect; its children are categories of causes, theirs the causes, and so on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IshikawaModel {
    pub title: Option<String>,
    pub root: Option<IshikawaNode>,
}
