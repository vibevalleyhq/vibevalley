use crate::RenderOptions;
use crate::svg::builder::{esc, esc_text, num};
use crate::svg::palette::PaletteOverrides;
use crate::svg::theme::{RADIUS_VAR, ROOT_STYLE_VARS, SvgTheme};

#[derive(Debug, Clone, Default)]
pub struct Accessible<'a> {
    pub acc_title: Option<&'a str>,
    pub acc_descr: Option<&'a str>,
}

const WEIGHTS: [(&str, &str); 3] = [("tw", "title"), ("hw", "heading"), ("w", "bold")];

#[allow(clippy::too_many_arguments)]
pub fn svg_document(
    diagram_type: &str,
    width: f64,
    height: f64,
    font_size: f64,
    options: &RenderOptions<'_>,
    responsive: bool,
    theme: &SvgTheme,
    palette: &PaletteOverrides,
    acc: Accessible<'_>,
    content: &str,
) -> String {
    let prefix = esc(options.id_prefix.as_deref().unwrap_or("pele"));
    let mut head = String::new();
    let mut aria = String::new();
    if let Some(title) = acc.acc_title
        && !title.is_empty()
    {
        head.push_str(&format!(r#"<title id="{prefix}-title">{}</title>"#, esc_text(title)));
        aria.push_str(&format!(r#" aria-labelledby="{prefix}-title""#));
    }
    if let Some(descr) = acc.acc_descr
        && !descr.is_empty()
    {
        head.push_str(&format!(r#"<desc id="{prefix}-desc">{}</desc>"#, esc_text(descr)));
        aria.push_str(&format!(r#" aria-describedby="{prefix}-desc""#));
    }

    let w_str = num(width);
    let h_str = num(height);
    let fit = if responsive { "max-width:100%;height:auto;" } else { "" };

    if theme.is_resolved() {
        let style_attr = if fit.is_empty() { String::new() } else { format!(r#" style="{fit}""#) };
        return format!(
            r#"<svg xmlns="http://www.w3.org/2000/svg" class="pele pele-{diagram_type}" viewBox="0 0 {w_str} {h_str}" width="{w_str}" height="{h_str}"{style_attr} font-family="{}" font-size="{}" fill="{}" role="graphics-document document" aria-roledescription="{diagram_type}"{aria}>{head}{content}</svg>"#,
            esc(theme.font_family()),
            num(font_size),
            esc(theme.fg()),
        );
    }

    let mut weights = if content.contains("var(--_r)") {
        format!(";--_r:{RADIUS_VAR}")
    } else {
        String::new()
    };
    for (alias, name) in WEIGHTS {
        let needle = format!("var(--_{alias})");
        if content.contains(&needle) {
            weights.push_str(&format!(";--_{alias}:var(--pele-{name}-weight,bold)"));
        }
    }

    format!(
        r#"<svg xmlns="http://www.w3.org/2000/svg" class="pele pele-{diagram_type}" viewBox="0 0 {w_str} {h_str}" width="{w_str}" height="{h_str}" style="{fit}{ROOT_STYLE_VARS}{weights}{}{}" fill="var(--_fg)" role="graphics-document document" aria-roledescription="{diagram_type}"{aria}>{head}{content}</svg>"#,
        esc(&theme.root_font_style(font_size)),
        palette.style,
    )
}
