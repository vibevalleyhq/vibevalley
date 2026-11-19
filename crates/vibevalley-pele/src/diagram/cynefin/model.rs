use indexmap::IndexMap;

use super::parser::CynefinAst;
pub use super::parser::DomainName;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CynefinItem {
    pub label: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CynefinDomain {
    pub name: DomainName,
    pub items: Vec<CynefinItem>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CynefinTransition {
    pub from: DomainName,
    pub to: DomainName,
    pub label: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CynefinModel {
    pub title: Option<String>,
    pub acc_title: Option<String>,
    pub acc_descr: Option<String>,
    pub domains: IndexMap<DomainName, CynefinDomain>,
    pub transitions: Vec<CynefinTransition>,
}

pub fn build_cynefin(ast: CynefinAst, title: Option<&str>) -> CynefinModel {
    let mut domains = IndexMap::new();
    for block in ast.domains {
        domains.insert(
            block.domain,
            CynefinDomain {
                name: block.domain,
                items: block.items.into_iter().map(|label| CynefinItem { label }).collect(),
            },
        );
    }
    let transitions = ast
        .transitions
        .into_iter()
        .filter(|t| t.from != t.to)
        .map(|t| CynefinTransition {
            from: t.from,
            to: t.to,
            label: t.label.filter(|s| !s.is_empty()),
        })
        .collect();
    CynefinModel {
        title: ast.title.filter(|s| !s.is_empty()).or_else(|| title.map(str::to_string)),
        acc_title: crate::diagram::info::model::trim_acc_title(ast.acc_title),
        acc_descr: crate::diagram::info::model::trim_acc_descr(ast.acc_descr),
        domains,
        transitions,
    }
}
