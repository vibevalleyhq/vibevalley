//! Parent and child issues: the dependency graph, when a blocked issue may
//! go, and what a child must pass before it merges into its parent.

use std::collections::{BTreeSet, HashMap, HashSet};

use serde::{Deserialize, Serialize};

use vibevalley_protocol::*;

/// A node of a dependency graph: it goes after the nodes in `after`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DagNode {
    pub id: String,
    pub after: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum DagProblem {
    Duplicate {
        id: String,
    },
    /// A node that waits for itself.
    SelfLoop {
        id: String,
    },
    /// `id` waits for `other`, which is not in the graph.
    Missing {
        id: String,
        other: String,
    },
    /// The nodes caught in (or behind) a circle, in the nodes' order.
    Circle {
        circle: Vec<String>,
    },
}

/// A draft's own id (a child draft names its siblings by it): ASCII only.
pub fn dag_id_valid(id: &str) -> bool {
    let mut chars = id.chars();
    let Some(first) = chars.next() else { return false };
    first.is_ascii_alphanumeric() && id.len() <= 32 && chars.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

/// In the nodes' order: duplicates, then each node's edges in order; a
/// circle only when the edges are otherwise sound.
pub fn dag_problems(nodes: &[DagNode]) -> Vec<DagProblem> {
    let mut problems = Vec::new();
    let mut ids = HashSet::new();
    for n in nodes {
        if !ids.insert(n.id.as_str()) {
            problems.push(DagProblem::Duplicate { id: n.id.clone() });
        }
    }
    for n in nodes {
        for x in &n.after {
            if *x == n.id {
                problems.push(DagProblem::SelfLoop { id: n.id.clone() });
            } else if !ids.contains(x.as_str()) {
                problems.push(DagProblem::Missing {
                    id: n.id.clone(),
                    other: x.clone(),
                });
            }
        }
    }
    if !problems.is_empty() {
        return problems;
    }
    let laid: HashSet<String> = dag_layers(nodes).into_iter().flatten().collect();
    let circle: Vec<String> = nodes.iter().filter(|n| !laid.contains(&n.id)).map(|n| n.id.clone()).collect();
    if !circle.is_empty() {
        problems.push(DagProblem::Circle { circle });
    }
    problems
}

/// Longest path from a node that waits for nothing. A node caught in a
/// circle is in no layer.
pub(crate) fn dag_layers(nodes: &[DagNode]) -> Vec<Vec<String>> {
    let known: HashSet<&str> = nodes.iter().map(|n| n.id.as_str()).collect();
    let mut depth: HashMap<&str, usize> = HashMap::new();
    let mut changed = true;
    let mut pass = 0;
    while changed && pass <= nodes.len() {
        changed = false;
        pass += 1;
        for n in nodes {
            if depth.contains_key(n.id.as_str()) {
                continue;
            }
            let mut d = 0;
            let mut ready = true;
            for x in &n.after {
                if !known.contains(x.as_str()) || *x == n.id {
                    continue;
                }
                match depth.get(x.as_str()) {
                    Some(nd) => d = d.max(nd + 1),
                    None => {
                        ready = false;
                        break;
                    }
                }
            }
            if ready {
                depth.insert(n.id.as_str(), d);
                changed = true;
            }
        }
    }
    let mut layers: Vec<Vec<String>> = Vec::new();
    for n in nodes {
        let Some(&d) = depth.get(n.id.as_str()) else { continue };
        if layers.len() <= d {
            layers.resize(d + 1, Vec::new());
        }
        layers[d].push(n.id.clone());
    }
    layers.into_iter().filter(|l| !l.is_empty()).collect()
}

/// The issues' dependency graph checked: an issue goes after what blocks it,
/// and a parent after its children.
pub fn dependency_problems(issues: &[(IssueId, Option<IssueId>, Vec<IssueId>)]) -> Vec<DagProblem> {
    let mut children: HashMap<&str, Vec<String>> = HashMap::new();
    for (id, parent, _) in issues {
        if let Some(parent) = parent {
            children.entry(parent.as_str()).or_default().push(id.clone());
        }
    }
    let nodes: Vec<DagNode> = issues
        .iter()
        .map(|(id, _, blocked_by)| {
            let mut after = blocked_by.clone();
            after.extend(children.get(id.as_str()).cloned().unwrap_or_default());
            DagNode { id: id.clone(), after }
        })
        .collect();
    dag_problems(&nodes)
}

/// The issues `issue` still waits for: only done or canceled ones release
/// it; one that is not on the board keeps it waiting.
pub fn blocked_issues(issue: &Issue, issues: &[Issue]) -> Vec<IssueId> {
    let settled: HashSet<&str> = issues.iter().filter(|t| t.status.is_closed()).map(|t| t.id.as_str()).collect();
    issue.blocked_by.iter().filter(|id| !settled.contains(id.as_str())).cloned().collect()
}

/// The done acceptance issues `issue` waits for, directly or through others.
pub fn acceptance_ancestors<'a>(issue: &Issue, all: &'a [Issue]) -> Vec<&'a Issue> {
    let by_id: HashMap<&str, &Issue> = all.iter().map(|t| (t.id.as_str(), t)).collect();
    let mut visited: HashSet<&str> = HashSet::new();
    let mut stack: Vec<&str> = issue.blocked_by.iter().map(String::as_str).collect();
    while let Some(id) = stack.pop() {
        if !visited.insert(id) {
            continue;
        }
        if let Some(t) = by_id.get(id) {
            stack.extend(t.blocked_by.iter().map(String::as_str));
        }
    }
    all.iter()
        .filter(|t| visited.contains(t.id.as_str()) && t.status == IssueStatus::Done && t.constraints.as_ref().is_some_and(|c| c.acceptance))
        .collect()
}

/// What a child's work must pass before it merges into its parent.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum CheckoutChecks {
    /// Its check must fail; the files it changed are then frozen.
    Acceptance { check: String },
    /// The frozen files must be untouched and every check must pass.
    Plain { frozen: Vec<String>, checks: Vec<String> },
}

/// Its own check, the acceptance ancestors' frozen files, and (when no
/// sibling waits for it: the end of the chain) their checks too.
pub fn child_checks(child: &Issue, all: &[Issue]) -> CheckoutChecks {
    let constraints = child.constraints.as_ref();
    if let Some(c) = constraints
        && c.acceptance
    {
        return CheckoutChecks::Acceptance {
            check: c.check.clone().unwrap_or_default(),
        };
    }
    let inherited = acceptance_ancestors(child, all);
    let frozen: Vec<String> = inherited
        .iter()
        .flat_map(|t| t.constraints.as_ref().map(|c| c.frozen.clone()).unwrap_or_default())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    let leaf = !all
        .iter()
        .any(|t| t.parent == child.parent && t.status != IssueStatus::Canceled && t.blocked_by.contains(&child.id));
    let mut checks: Vec<String> = Vec::new();
    let own = constraints.and_then(|c| c.check.clone());
    let theirs = if leaf {
        inherited.iter().filter_map(|t| t.constraints.as_ref()?.check.clone()).collect()
    } else {
        vec![]
    };
    for check in own.into_iter().chain(theirs) {
        if !check.is_empty() && !checks.contains(&check) {
            checks.push(check);
        }
    }
    CheckoutChecks::Plain { frozen, checks }
}
