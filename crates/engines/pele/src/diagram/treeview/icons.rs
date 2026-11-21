use indexmap::IndexMap;

use crate::config::DiagramConfig;
use crate::util::yaml::YamlValue;

use super::model::NodeType;

pub const BUILTIN_PACK: &str = "mermaid-treeview";

pub const FOLDER_GLYPH: &str = "M3 6.5A1.5 1.5 0 0 1 4.5 5h4.6l2.4 2.5h8A1.5 1.5 0 0 1 21 9v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18z";
pub const FILE_GLYPH: &str = "M6.5 3h7L19 8.5v11a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 5 19.5v-15A1.5 1.5 0 0 1 6.5 3zM13.5 3v5.5H19";

pub fn glyph_for(name: &str) -> Option<&'static str> {
    match name {
        "folder" => Some(FOLDER_GLYPH),
        "file" => Some(FILE_GLYPH),
        _ => None,
    }
}

#[derive(Debug, Clone, Default)]
pub struct IconConfig {
    pub show_icons: bool,
    pub default_icon_pack: String,
    pub filename_icons: IndexMap<String, String>,
    pub extension_icons: IndexMap<String, String>,
}

pub fn detect_icon<'a>(name: &str, config: &'a IconConfig) -> Option<&'a str> {
    if let Some(by_name) = config.filename_icons.get(name)
        && !by_name.is_empty()
    {
        return Some(by_name.as_str());
    }
    if let Some(dot) = name.rfind('.')
        && dot > 0
    {
        let ext = name[dot..].to_ascii_lowercase();
        if let Some(v) = config.extension_icons.get(&ext)
            && !v.is_empty()
        {
            return Some(v.as_str());
        }
        if let Some(v) = config.extension_icons.get(&ext[1..])
            && !v.is_empty()
        {
            return Some(v.as_str());
        }
    }
    None
}

fn qualify_icon(icon: &str, default_pack: &str) -> String {
    if icon.contains(':') {
        return icon.to_string();
    }
    if glyph_for(icon).is_some() || default_pack.is_empty() {
        format!("{BUILTIN_PACK}:{icon}")
    } else {
        format!("{default_pack}:{icon}")
    }
}

pub fn get_node_icon(icon: Option<&str>, name: &str, node_type: NodeType, config: &IconConfig) -> Option<String> {
    if icon == Some("none") {
        return None;
    }
    if let Some(explicit) = icon
        && !explicit.is_empty()
    {
        return Some(qualify_icon(explicit, &config.default_icon_pack));
    }
    if !config.show_icons {
        return None;
    }
    if node_type == NodeType::File
        && let Some(detected) = detect_icon(name, config)
    {
        if detected == "none" {
            return None;
        }
        return Some(qualify_icon(detected, &config.default_icon_pack));
    }
    let kind = match node_type {
        NodeType::Directory => "folder",
        NodeType::File => "file",
    };
    Some(format!("{BUILTIN_PACK}:{kind}"))
}

fn string_map(val: Option<&YamlValue>) -> IndexMap<String, String> {
    let mut out = IndexMap::new();
    if let Some(map) = val.and_then(YamlValue::as_map) {
        for (k, v) in map {
            if let Some(s) = v.as_str() {
                out.insert(k.clone(), s.to_string());
            }
        }
    }
    out
}

pub fn icon_config(config: &DiagramConfig) -> IconConfig {
    let Some(sec) = config.section("treeView") else {
        return IconConfig::default();
    };
    let show_icons = match sec.get("showIcons") {
        Some(YamlValue::Bool(b)) => *b,
        Some(YamlValue::Number(n)) => *n != 0.0 && !n.is_nan(),
        Some(YamlValue::String(s)) => !s.is_empty(),
        Some(YamlValue::Seq(_) | YamlValue::Map(_)) => true,
        Some(YamlValue::Null) | None => false,
    };
    let default_icon_pack = sec.get("defaultIconPack").and_then(YamlValue::as_str).unwrap_or("").to_string();
    IconConfig {
        show_icons,
        default_icon_pack,
        filename_icons: string_map(sec.get("filenameIcons")),
        extension_icons: string_map(sec.get("extensionIcons")),
    }
}
