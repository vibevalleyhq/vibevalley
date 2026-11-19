use super::parser::InfoAst;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InfoModel {
    pub title: Option<String>,
    pub acc_title: Option<String>,
    pub acc_descr: Option<String>,
}

pub fn trim_acc_title(raw: Option<String>) -> Option<String> {
    raw.filter(|s| !s.is_empty()).map(|s| s.trim_start().to_string())
}

pub fn trim_acc_descr(raw: Option<String>) -> Option<String> {
    raw.filter(|s| !s.is_empty()).map(|s| {
        let mut out = String::with_capacity(s.len());
        let mut after_nl = false;
        for ch in s.chars() {
            if after_nl && ch.is_whitespace() && ch != '\n' {
                continue;
            }
            after_nl = ch == '\n';
            out.push(ch);
        }
        out
    })
}

pub fn build_info(ast: InfoAst, title: Option<&str>) -> InfoModel {
    InfoModel {
        title: ast.title.filter(|s| !s.is_empty()).or_else(|| title.map(str::to_string)),
        acc_title: trim_acc_title(ast.acc_title),
        acc_descr: trim_acc_descr(ast.acc_descr),
    }
}
