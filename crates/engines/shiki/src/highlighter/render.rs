use super::options::{HtmlOptions, HtmlStructure, RootStyleOption, SvgOptions, ThemedToken, TokensResult};
use super::transform::stringify_token_style;

pub(super) fn render_tokens_to_html(result: &TokensResult, options: &HtmlOptions) -> String {
    let mut out = String::new();

    match options.structure {
        HtmlStructure::Classic => {
            out.push_str("<pre class=\"shiki");
            if !result.theme_name.is_empty() {
                out.push(' ');
                push_html_attr_escaped(&mut out, &result.theme_name);
            }
            out.push('"');

            match &options.root_style {
                RootStyleOption::Disabled => {}
                RootStyleOption::Custom(custom) => {
                    out.push_str(" style=\"");
                    push_html_attr_escaped(&mut out, custom);
                    out.push('"');
                }
                RootStyleOption::Auto => {
                    let style = result
                        .root_style
                        .clone()
                        .unwrap_or_else(|| format!("background-color:{};color:{}", result.bg, result.fg));
                    out.push_str(" style=\"");
                    push_html_attr_escaped(&mut out, &style);
                    out.push('"');
                }
            }

            if let Some(tabindex) = &options.tabindex {
                out.push_str(" tabindex=\"");
                push_html_attr_escaped(&mut out, tabindex);
                out.push('"');
            }
            out.push_str("><code>");

            for (idx, line) in result.tokens.iter().enumerate() {
                if idx > 0 {
                    out.push('\n');
                }
                out.push_str("<span class=\"line\">");
                for token in line {
                    render_span(&mut out, token);
                }
                out.push_str("</span>");
            }

            out.push_str("</code></pre>");
        }
        HtmlStructure::Inline => {
            for (idx, line) in result.tokens.iter().enumerate() {
                if idx > 0 {
                    out.push_str("<br>");
                }
                for token in line {
                    render_span(&mut out, token);
                }
            }
        }
    }

    out
}

fn render_span(out: &mut String, token: &ThemedToken) {
    let style = stringify_token_style(token);
    if style.is_empty() {
        out.push_str("<span>");
    } else {
        out.push_str("<span style=\"");
        push_html_attr_escaped(out, &style);
        out.push_str("\">");
    }
    push_html_text_escaped(out, &token.content);
    out.push_str("</span>");
}

pub(super) fn render_tokens_to_svg(result: &TokensResult, options: &SvgOptions) -> String {
    let max_cols = result
        .tokens
        .iter()
        .map(|line| line.iter().map(|t| t.content.chars().count()).sum::<usize>())
        .max()
        .unwrap_or(0);
    let line_count = result.tokens.len().max(1);
    let char_w = options.font_size * options.char_width_ratio;
    let width = (max_cols as f64 * char_w + options.padding_x * 2.0).ceil();
    let height = (line_count as f64 * options.line_height + options.padding_y * 2.0).ceil();

    let bg = if result.bg.is_empty() { "#1e1e1e" } else { result.bg.as_str() };
    let fg = if result.fg.is_empty() { "#d4d4d4" } else { result.fg.as_str() };

    let mut out = String::new();
    out.push_str(&format!(
        "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"{width}\" height=\"{height}\" viewBox=\"0 0 {width} {height}\">"
    ));
    out.push_str(&format!(
        "<rect width=\"100%\" height=\"100%\" rx=\"{}\" fill=\"{}\"/>",
        options.border_radius,
        escape_xml_attr(bg),
    ));
    out.push_str(&format!(
        "<text font-family=\"{}\" font-size=\"{}\" fill=\"{}\" xml:space=\"preserve\">",
        escape_xml_attr(&options.font_family),
        options.font_size,
        escape_xml_attr(fg),
    ));

    for (line_idx, line) in result.tokens.iter().enumerate() {
        let y = options.padding_y + options.font_size + line_idx as f64 * options.line_height;
        out.push_str(&format!("<tspan x=\"{}\" y=\"{y}\">", options.padding_x));
        for token in line {
            out.push_str("<tspan");
            if let Some(color) = &token.color
                && !color.is_empty()
            {
                out.push_str(" fill=\"");
                push_html_attr_escaped(&mut out, color);
                out.push('"');
            }
            if let Some(fs) = token.font_style {
                if fs.is_bold() {
                    out.push_str(" font-weight=\"bold\"");
                }
                if fs.is_italic() {
                    out.push_str(" font-style=\"italic\"");
                }
                if fs.is_underline() && fs.is_strikethrough() {
                    out.push_str(" text-decoration=\"underline line-through\"");
                } else if fs.is_underline() {
                    out.push_str(" text-decoration=\"underline\"");
                } else if fs.is_strikethrough() {
                    out.push_str(" text-decoration=\"line-through\"");
                }
            }
            out.push('>');
            push_html_text_escaped(&mut out, &token.content);
            out.push_str("</tspan>");
        }
        out.push_str("</tspan>");
    }

    out.push_str("</text></svg>");
    out
}

fn push_html_text_escaped(out: &mut String, s: &str) {
    for ch in s.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#x27;"),
            _ => out.push(ch),
        }
    }
}

fn push_html_attr_escaped(out: &mut String, s: &str) {
    for ch in s.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '"' => out.push_str("&quot;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            _ => out.push(ch),
        }
    }
}

fn escape_xml_attr(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    push_html_attr_escaped(&mut out, s);
    out
}
