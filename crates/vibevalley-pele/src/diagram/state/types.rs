#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StateNote {
    pub position: Option<String>,
    pub text: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StateType {
    Default,
    Fork,
    Join,
    Choice,
    Divider,
}

impl StateType {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Default => "default",
            Self::Fork => "fork",
            Self::Join => "join",
            Self::Choice => "choice",
            Self::Divider => "divider",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StateDescription {
    Single(String),
    Multi(Vec<String>),
}

impl StateDescription {
    pub fn is_truthy(&self) -> bool {
        match self {
            Self::Single(s) => !s.is_empty(),
            Self::Multi(_) => true,
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
pub struct StateStmt {
    pub id: String,
    pub state_type: Option<StateType>,
    pub description: Option<StateDescription>,
    pub descriptions: Vec<String>,
    pub doc: Option<Vec<Stmt>>,
    pub note: Option<StateNote>,
    pub start: Option<bool>,
    pub classes: Vec<String>,
    pub styles: Vec<String>,
    pub text_styles: Vec<String>,
}

impl StateStmt {
    pub fn new(id: impl Into<String>, state_type: Option<StateType>) -> Self {
        Self {
            id: id.into(),
            state_type,
            description: None,
            descriptions: Vec::new(),
            doc: None,
            note: None,
            start: None,
            classes: Vec::new(),
            styles: Vec::new(),
            text_styles: Vec::new(),
        }
    }

    pub fn clone_shallow(&self) -> Self {
        Self {
            id: self.id.clone(),
            state_type: self.state_type,
            description: self.description.clone(),
            descriptions: self.descriptions.clone(),
            doc: None,
            note: self.note.clone(),
            start: self.start,
            classes: self.classes.clone(),
            styles: self.styles.clone(),
            text_styles: self.text_styles.clone(),
        }
    }
}

/// Iterative deep clone of a statement list so deeply nested composites never overflow the stack.
pub fn clone_doc(doc: &[Stmt]) -> Vec<Stmt> {
    struct Frame<'a> {
        src: &'a [Stmt],
        idx: usize,
        out: Vec<Stmt>,
        pending: Option<StateStmt>,
    }

    let mut stack = vec![Frame {
        src: doc,
        idx: 0,
        out: Vec::with_capacity(doc.len()),
        pending: None,
    }];

    loop {
        let next_child = {
            let top = stack.last_mut().expect("clone stack non-empty");
            if top.idx < top.src.len() {
                let stmt = &top.src[top.idx];
                top.idx += 1;
                match stmt {
                    Stmt::State(s) => {
                        if let Some(child_doc) = &s.doc {
                            Some((child_doc.as_slice(), s.clone_shallow()))
                        } else {
                            top.out.push(Stmt::State(Box::new(s.clone_shallow())));
                            None
                        }
                    }
                    Stmt::Raw(s) => {
                        top.out.push(Stmt::Raw(s.clone()));
                        None
                    }
                    Stmt::Relation(r) => {
                        top.out.push(Stmt::Relation(r.clone()));
                        None
                    }
                    Stmt::ClassDef(c) => {
                        top.out.push(Stmt::ClassDef(c.clone()));
                        None
                    }
                    Stmt::Style(s) => {
                        top.out.push(Stmt::Style(s.clone()));
                        None
                    }
                    Stmt::ApplyClass(a) => {
                        top.out.push(Stmt::ApplyClass(a.clone()));
                        None
                    }
                    Stmt::Direction(d) => {
                        top.out.push(Stmt::Direction(d.clone()));
                        None
                    }
                    Stmt::Click(c) => {
                        top.out.push(Stmt::Click(c.clone()));
                        None
                    }
                }
            } else {
                let done = stack.pop().expect("clone stack non-empty");
                match done.pending {
                    Some(mut shell) => {
                        shell.doc = Some(done.out);
                        stack.last_mut().expect("parent frame exists").out.push(Stmt::State(Box::new(shell)));
                        None
                    }
                    None => return done.out,
                }
            }
        };
        if let Some((child_doc, shell)) = next_child {
            stack.push(Frame {
                src: child_doc,
                idx: 0,
                out: Vec::with_capacity(child_doc.len()),
                pending: Some(shell),
            });
        }
    }
}

impl Clone for StateStmt {
    fn clone(&self) -> Self {
        let mut copy = self.clone_shallow();
        if let Some(doc) = &self.doc {
            copy.doc = Some(clone_doc(doc));
        }
        copy
    }
}

impl Drop for StateStmt {
    fn drop(&mut self) {
        let Some(first) = self.doc.take() else {
            return;
        };
        let mut stack = vec![first];
        while let Some(stmts) = stack.pop() {
            for mut stmt in stmts {
                match &mut stmt {
                    Stmt::State(s) => {
                        if let Some(child) = s.doc.take() {
                            stack.push(child);
                        }
                    }
                    Stmt::Relation(r) => {
                        if let Some(child) = r.state1.doc.take() {
                            stack.push(child);
                        }
                        if let Some(child) = r.state2.doc.take() {
                            stack.push(child);
                        }
                    }
                    Stmt::Click(c) => {
                        if let ClickTarget::State(s) = &mut c.id
                            && let Some(child) = s.doc.take()
                        {
                            stack.push(child);
                        }
                    }
                    Stmt::Raw(_) | Stmt::ClassDef(_) | Stmt::Style(_) | Stmt::ApplyClass(_) | Stmt::Direction(_) => {}
                }
            }
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RelationStmt {
    pub state1: StateStmt,
    pub state2: StateStmt,
    pub description: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClassDefStmt {
    pub id: String,
    pub classes: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StyleStmt {
    pub id: String,
    pub style_class: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ApplyClassStmt {
    pub id: String,
    pub style_class: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DirectionStmt {
    pub value: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ClickTarget {
    State(Box<StateStmt>),
    Id(String),
}

impl ClickTarget {
    pub fn id(&self) -> &str {
        match self {
            Self::State(s) => &s.id,
            Self::Id(s) => s,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClickStmt {
    pub id: ClickTarget,
    pub url: String,
    pub tooltip: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Stmt {
    Raw(String),
    State(Box<StateStmt>),
    Relation(Box<RelationStmt>),
    ClassDef(ClassDefStmt),
    Style(StyleStmt),
    ApplyClass(ApplyClassStmt),
    Direction(DirectionStmt),
    Click(ClickStmt),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StateRelation {
    pub id1: String,
    pub id2: String,
    pub relation_title: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StateClassDef {
    pub id: String,
    pub styles: Vec<String>,
    pub text_styles: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StateLink {
    pub url: String,
    pub tooltip: String,
}
