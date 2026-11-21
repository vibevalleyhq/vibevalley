use indexmap::IndexMap;

use crate::config::DiagramConfig;
use crate::detect::DiagramType;
use crate::diagram::timeline::scan::{collapse_newline_ws, trim_leading_ws};
use crate::error::{ErrorCode, PeleError};
use crate::util::yaml::YamlValue;

use super::parser::{CommitTypeName, GitDirection, GitGraphAst, StatementAst};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CommitType {
    Normal = 0,
    Reverse = 1,
    Highlight = 2,
    Merge = 3,
    CherryPick = 4,
}

impl CommitType {
    pub const fn class_name(self) -> &'static str {
        match self {
            Self::Normal => "normal",
            Self::Reverse => "reverse",
            Self::Highlight => "highlight",
            Self::Merge => "merge",
            Self::CherryPick => "cherry-pick",
        }
    }

    pub const fn from_name(name: CommitTypeName) -> Self {
        match name {
            CommitTypeName::Normal => Self::Normal,
            CommitTypeName::Reverse => Self::Reverse,
            CommitTypeName::Highlight => Self::Highlight,
        }
    }

    pub const fn is_user_written_message(self) -> bool {
        matches!(self, Self::Normal | Self::Reverse | Self::Highlight)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GitCommit {
    pub id: String,
    pub message: String,
    pub seq: usize,
    pub commit_type: CommitType,
    pub tags: Vec<String>,
    pub parents: Vec<String>,
    pub branch: String,
    pub custom_type: Option<CommitType>,
    pub custom_id: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct GitModel {
    pub title: Option<String>,
    pub acc_title: Option<String>,
    pub acc_descr: Option<String>,
    pub direction: GitDirection,
    /// Keyed by commit id, in the order the ids first appeared.
    pub commits: IndexMap<String, GitCommit>,
    /// The id of each branch's latest commit, or `None` while the branch has none.
    pub branches: IndexMap<String, Option<String>>,
    /// Branch names in drawing order: by `order`, then by creation.
    pub lanes: Vec<String>,
    pub current_branch: String,
    pub head: Option<GitCommit>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommitDb {
    pub msg: String,
    pub id: Option<String>,
    pub commit_type: CommitType,
    pub tags: Option<Vec<String>>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct BranchDb {
    pub name: String,
    pub order: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MergeDb {
    pub branch: String,
    pub id: String,
    pub commit_type: Option<CommitType>,
    pub tags: Option<Vec<String>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CherryPickDb {
    pub id: Option<String>,
    pub target_id: String,
    pub parent: Option<String>,
    pub tags: Option<Vec<String>>,
}

pub trait GitDbParseProvider {
    fn set_direction(&mut self, dir: GitDirection);
    fn commit(&mut self, commit: CommitDb) -> Result<(), PeleError>;
    fn branch(&mut self, branch: BranchDb) -> Result<(), PeleError>;
    fn merge(&mut self, merge: MergeDb) -> Result<(), PeleError>;
    fn cherry_pick(&mut self, cherry_pick: CherryPickDb) -> Result<(), PeleError>;
    fn checkout(&mut self, branch: &str) -> Result<(), PeleError>;
}

fn fail(message: impl Into<String>) -> PeleError {
    PeleError::new(message, ErrorCode::Semantic).with_diagram_type(DiagramType::GitGraph)
}

pub fn populate(ast: &GitGraphAst, db: &mut dyn GitDbParseProvider) -> Result<(), PeleError> {
    if let Some(dir) = ast.dir {
        db.set_direction(dir);
    }
    for stmt in &ast.statements {
        parse_statement(stmt, db)?;
    }
    Ok(())
}

pub fn parse_statement(statement: &StatementAst, db: &mut dyn GitDbParseProvider) -> Result<(), PeleError> {
    match statement {
        StatementAst::Commit {
            id,
            message,
            tags,
            commit_type,
        } => db.commit(CommitDb {
            id: id.clone(),
            msg: message.clone().unwrap_or_default(),
            commit_type: commit_type.map_or(CommitType::Normal, CommitType::from_name),
            tags: Some(tags.clone()),
        }),
        StatementAst::Branch { name, order } => db.branch(BranchDb {
            name: name.clone(),
            order: Some(order.unwrap_or(0.0)),
        }),
        StatementAst::Merge { branch, id, tags, commit_type } => db.merge(MergeDb {
            branch: branch.clone(),
            id: id.clone().unwrap_or_default(),
            commit_type: commit_type.map(CommitType::from_name),
            tags: Some(tags.clone()),
        }),
        StatementAst::Checkout { branch } => db.checkout(branch),
        StatementAst::CherryPicking { id, tags, parent } => db.cherry_pick(CherryPickDb {
            id: id.clone(),
            target_id: String::new(),
            tags: if tags.is_empty() { None } else { Some(tags.clone()) },
            parent: parent.clone(),
        }),
    }
}

struct GitBuilder {
    commits: IndexMap<String, GitCommit>,
    branches: IndexMap<String, Option<String>>,
    orders: IndexMap<String, Option<f64>>,
    warnings: Vec<String>,
    head: Option<GitCommit>,
    current: String,
    direction: GitDirection,
    seq: usize,
}

impl GitBuilder {
    fn new(main_name: String, main_order: f64) -> Self {
        let mut branches = IndexMap::new();
        branches.insert(main_name.clone(), None);
        let mut orders = IndexMap::new();
        orders.insert(main_name.clone(), Some(main_order));
        Self {
            commits: IndexMap::new(),
            branches,
            orders,
            warnings: Vec::new(),
            head: None,
            current: main_name,
            direction: GitDirection::Lr,
            seq: 0,
        }
    }

    fn next_id(&self) -> String {
        let mut salt = (self.seq as u32).wrapping_add(1);
        loop {
            let h = salt.wrapping_mul(0x9e37_79b1);
            let hex = format!("{h:08x}");
            let id = format!("{}-{}", self.seq, &hex[..7]);
            if !self.commits.contains_key(&id) {
                return id;
            }
            salt = salt.wrapping_add(0x9e37_79b1);
        }
    }

    fn add(&mut self, commit: GitCommit) {
        self.head = Some(commit.clone());
        let id = commit.id.clone();
        self.commits.insert(id.clone(), commit);
        self.branches.insert(self.current.clone(), Some(id));
    }
}

impl GitDbParseProvider for GitBuilder {
    fn set_direction(&mut self, dir: GitDirection) {
        self.direction = dir;
    }

    fn commit(&mut self, c: CommitDb) -> Result<(), PeleError> {
        let id = match c.id {
            Some(ref s) if !s.is_empty() => s.clone(),
            _ => self.next_id(),
        };
        let seq = self.seq;
        self.seq += 1;
        let parents = match &self.head {
            None => Vec::new(),
            Some(h) => vec![h.id.clone()],
        };
        let commit = GitCommit {
            id,
            message: c.msg,
            seq,
            commit_type: c.commit_type,
            tags: c.tags.unwrap_or_default(),
            parents,
            branch: self.current.clone(),
            custom_type: None,
            custom_id: false,
        };
        if self.commits.contains_key(&commit.id) {
            self.warnings.push(format!("Commit ID {} already exists", commit.id));
        }
        self.add(commit);
        Ok(())
    }

    fn branch(&mut self, b: BranchDb) -> Result<(), PeleError> {
        if self.branches.contains_key(&b.name) {
            return Err(fail(format!(
                r#"Trying to create an existing branch. (Help: Either use a new name if you want create a new branch or try using "checkout {}")"#,
                b.name,
            )));
        }
        let head_id = self.head.as_ref().map(|h| h.id.clone());
        self.branches.insert(b.name.clone(), head_id);
        self.orders.insert(b.name.clone(), b.order);
        self.checkout(&b.name)
    }

    fn merge(&mut self, m: MergeDb) -> Result<(), PeleError> {
        let other = &m.branch;
        let current_head = self.branches.get(&self.current).and_then(Clone::clone);
        let other_head = self.branches.get(other).and_then(Clone::clone);
        let current_commit = current_head.as_deref().and_then(|id| self.commits.get(id));
        let other_commit = other_head.as_deref().and_then(|id| self.commits.get(id));
        if let (Some(cc), Some(_)) = (current_commit, other_commit)
            && cc.branch == *other
        {
            return Err(fail(format!("Cannot merge branch '{other}' into itself.")));
        }
        if self.current == *other {
            return Err(fail(r#"Incorrect usage of "merge". Cannot merge a branch to itself"#));
        }
        let Some(cc) = current_commit else {
            return Err(fail(format!(r#"Incorrect usage of "merge". Current branch ({})has no commits"#, self.current)));
        };
        if !self.branches.contains_key(other) {
            return Err(fail(format!(r#"Incorrect usage of "merge". Branch to be merged ({other}) does not exist"#)));
        }
        let Some(oc) = other_commit else {
            return Err(fail(format!(r#"Incorrect usage of "merge". Branch to be merged ({other}) has no commits"#)));
        };
        if cc.id == oc.id {
            return Err(fail(r#"Incorrect usage of "merge". Both branches have same head"#));
        }
        if !m.id.is_empty() && self.commits.contains_key(&m.id) {
            return Err(fail(format!(
                r#"Incorrect usage of "merge". Commit with id:{} already exists, use different custom id"#,
                m.id,
            )));
        }
        let custom_id = !m.id.is_empty();
        let id = if custom_id { m.id } else { self.next_id() };
        let seq = self.seq;
        self.seq += 1;
        let parents = match &self.head {
            None => Vec::new(),
            Some(h) => vec![h.id.clone(), other_head.unwrap_or_default()],
        };
        self.add(GitCommit {
            id,
            message: format!("merged branch {other} into {}", self.current),
            seq,
            parents,
            branch: self.current.clone(),
            commit_type: CommitType::Merge,
            custom_type: m.commit_type,
            custom_id,
            tags: m.tags.unwrap_or_default(),
        });
        Ok(())
    }

    fn cherry_pick(&mut self, cp: CherryPickDb) -> Result<(), PeleError> {
        let source = cp.id.as_deref().filter(|s| !s.is_empty()).and_then(|id| self.commits.get(id)).cloned();
        let Some(source) = source else {
            return Err(fail(r#"Incorrect usage of "cherryPick". Source commit id should exist and provided"#));
        };
        if let Some(ref p) = cp.parent
            && !p.is_empty()
            && !source.parents.contains(p)
        {
            return Err(fail(
                "Invalid operation: The specified parent commit is not an immediate parent of the cherry-picked commit.",
            ));
        }
        if source.commit_type == CommitType::Merge && cp.parent.as_deref().is_none_or(str::is_empty) {
            return Err(fail(
                "Incorrect usage of cherry-pick: If the source commit is a merge commit, an immediate parent commit must be specified.",
            ));
        }
        if !cp.target_id.is_empty() && self.commits.contains_key(&cp.target_id) {
            return Ok(());
        }
        if source.branch == self.current {
            return Err(fail(r#"Incorrect usage of "cherryPick". Source commit is already on current branch"#));
        }
        let current_head = self.branches.get(&self.current).and_then(Clone::clone);
        if current_head.as_deref().is_none_or(|id| !self.commits.contains_key(id)) {
            return Err(fail(format!(
                r#"Incorrect usage of "cherry-pick". Current branch ({})has no commits"#,
                self.current,
            )));
        }
        let id = self.next_id();
        let seq = self.seq;
        self.seq += 1;
        let parents = match &self.head {
            None => Vec::new(),
            Some(h) => vec![h.id.clone(), source.id.clone()],
        };
        let tags = match cp.tags {
            Some(list) => list.into_iter().filter(|s| !s.is_empty()).collect(),
            None => {
                let suffix = if source.commit_type == CommitType::Merge {
                    format!("|parent:{}", cp.parent.as_deref().unwrap_or(""))
                } else {
                    String::new()
                };
                vec![format!("cherry-pick:{}{suffix}", source.id)]
            }
        };
        self.add(GitCommit {
            id,
            message: format!("cherry-picked {} into {}", source.message, self.current),
            seq,
            parents,
            branch: self.current.clone(),
            commit_type: CommitType::CherryPick,
            custom_type: None,
            custom_id: false,
            tags,
        });
        Ok(())
    }

    fn checkout(&mut self, branch: &str) -> Result<(), PeleError> {
        if !self.branches.contains_key(branch) {
            return Err(fail(format!(
                r#"Trying to checkout branch which is not yet created. (Help try using "branch {branch}")"#,
            )));
        }
        self.current = branch.to_string();
        let id = self.branches.get(branch).and_then(Clone::clone);
        self.head = id.as_deref().and_then(|cid| self.commits.get(cid)).cloned();
        Ok(())
    }
}

pub fn build_git(ast: &GitGraphAst, config: &DiagramConfig, title: Option<&str>) -> Result<GitModel, PeleError> {
    let git_cfg = config.section("gitGraph");
    let main_name = git_cfg
        .and_then(|s| s.get("mainBranchName"))
        .and_then(YamlValue::as_str)
        .unwrap_or("main")
        .to_string();
    let main_order = git_cfg.and_then(|s| s.get("mainBranchOrder")).and_then(YamlValue::as_f64).unwrap_or(0.0);

    let mut builder = GitBuilder::new(main_name, main_order);
    populate(ast, &mut builder)?;

    let mut ordered: Vec<(String, f64)> = builder
        .orders
        .into_iter()
        .enumerate()
        .map(|(i, (name, ord))| {
            let key = ord.unwrap_or_else(|| format!("0.{i}").parse::<f64>().unwrap_or(0.0));
            (name, key)
        })
        .collect();
    ordered.sort_by(|a, b| a.1.total_cmp(&b.1));
    let lanes: Vec<String> = ordered.into_iter().map(|(name, _)| name).collect();

    Ok(GitModel {
        title: ast
            .title
            .as_deref()
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .or_else(|| title.map(str::to_string)),
        acc_title: ast.acc_title.as_deref().map(trim_leading_ws),
        acc_descr: ast.acc_descr.as_deref().map(collapse_newline_ws),
        direction: builder.direction,
        commits: builder.commits,
        branches: builder.branches,
        lanes,
        current_branch: builder.current,
        head: builder.head,
        warnings: builder.warnings,
    })
}
