use std::sync::{Arc, Mutex, OnceLock};

use nsh_core::canvas::Drawing;

use crate::cache::{CacheStats, LruCache, hash_str};

const SVG_DRAWING_CACHE_CAPACITY: usize = 64;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum StickerCategory {
    Launch,
    Business,
    Engineering,
    Status,
    People,
    Transport,
}

impl StickerCategory {
    pub const ALL: [Self; 6] = [Self::Launch, Self::Business, Self::Engineering, Self::Status, Self::People, Self::Transport];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Launch => "launch",
            Self::Business => "business",
            Self::Engineering => "engineering",
            Self::Status => "status",
            Self::People => "people",
            Self::Transport => "transport",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StickerSpec {
    pub id: &'static str,
    pub category: StickerCategory,
    pub svg: &'static str,
}

/// Pure-vector stickers (no `<text>` elements) so `nsh_core::svg::drawing` and `resvg` render identically.
pub const STICKERS: &[StickerSpec] = &[
    StickerSpec {
        id: "berry-lock",
        category: StickerCategory::Launch,
        svg: r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><path d="M24 22c-6-6-10-4-12 2 6 3 10 2 14-1zm12 0c6-6 10-4 12 2-6 3-10 2-14-1z" fill="#74a046" stroke="#2a2520" stroke-width="2" stroke-linejoin="round"/><circle cx="24" cy="30" r="8" fill="#8b63a8" stroke="#2a2520" stroke-width="2"/><circle cx="34" cy="27" r="8" fill="#9a72b8" stroke="#2a2520" stroke-width="2"/><circle cx="30" cy="36" r="8" fill="#7c5699" stroke="#2a2520" stroke-width="2"/><path d="M40 38v-4a6 6 0 0 1 12 0v4" fill="none" stroke="#2a2520" stroke-width="2.2" stroke-linecap="round"/><rect x="37" y="38" width="18" height="15" rx="4" fill="#a8c3e8" stroke="#2a2520" stroke-width="2"/><circle cx="46" cy="45" r="2.2" fill="#2a2520"/></svg>"##,
    },
    StickerSpec {
        id: "price-tag",
        category: StickerCategory::Business,
        svg: r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><path d="M18 14c-6 0-8 7-3 11" fill="none" stroke="#8b5a2b" stroke-width="2" stroke-linecap="round"/><path d="M18 14h24l12 16-22 22-14-14z" fill="#f3b07a" stroke="#2a2520" stroke-width="2" stroke-linejoin="round"/><circle cx="25" cy="22" r="3" fill="#fcfcfb" stroke="#2a2520" stroke-width="1.8"/><path d="M35 26v16M39 29.5c-2.5-1.5-7.5-1-7.5 2 0 3.2 8 2.6 8 6.2 0 2.8-5.5 3.2-8.2 1.4" fill="none" stroke="#2a2520" stroke-width="2.2" stroke-linecap="round"/></svg>"##,
    },
    StickerSpec {
        id: "chart-board",
        category: StickerCategory::Business,
        svg: r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect x="12" y="10" width="40" height="44" rx="5" fill="#d9c6a3" stroke="#2a2520" stroke-width="2"/><rect x="17" y="15" width="30" height="34" rx="2" fill="#fcfcfb" stroke="#2a2520" stroke-width="1.6"/><rect x="24" y="7" width="16" height="6" rx="3" fill="#e5a93c" stroke="#2a2520" stroke-width="1.8"/><rect x="21" y="36" width="5" height="9" fill="#74a046" stroke="#2a2520" stroke-width="1.4"/><rect x="29" y="30" width="5" height="15" fill="#e5a93c" stroke="#2a2520" stroke-width="1.4"/><rect x="37" y="22" width="5" height="23" fill="#dd6f57" stroke="#2a2520" stroke-width="1.4"/><path d="M21 31l10-7 10-8" fill="none" stroke="#2a2520" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>"##,
    },
    StickerSpec {
        id: "crate",
        category: StickerCategory::Business,
        svg: r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><circle cx="24" cy="24" r="6" fill="#8b63a8" stroke="#2a2520" stroke-width="1.8"/><circle cx="33" cy="22" r="6.5" fill="#9a72b8" stroke="#2a2520" stroke-width="1.8"/><circle cx="42" cy="25" r="6" fill="#7c5699" stroke="#2a2520" stroke-width="1.8"/><circle cx="29" cy="29" r="6" fill="#8b63a8" stroke="#2a2520" stroke-width="1.8"/><circle cx="38" cy="29" r="6" fill="#9a72b8" stroke="#2a2520" stroke-width="1.8"/><rect x="13" y="30" width="38" height="22" rx="3" fill="#d9a86c" stroke="#2a2520" stroke-width="2"/><path d="M13 38h38M13 45h38M25 30v22M39 30v22" stroke="#2a2520" stroke-width="1.6"/></svg>"##,
    },
    StickerSpec {
        id: "storefront",
        category: StickerCategory::Business,
        svg: r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect x="12" y="26" width="40" height="28" rx="3" fill="#f7e8c4" stroke="#2a2520" stroke-width="2"/><path d="M10 14h44l3 12H7z" fill="#dd6f57" stroke="#2a2520" stroke-width="2" stroke-linejoin="round"/><path d="M21 14v12M32 14v12M43 14v12" stroke="#fcfcfb" stroke-width="2.6"/><rect x="26" y="36" width="12" height="18" rx="2" fill="#e5a93c" stroke="#2a2520" stroke-width="1.8"/><rect x="16" y="33" width="7" height="9" rx="1.5" fill="#9fc5e8" stroke="#2a2520" stroke-width="1.6"/><rect x="41" y="33" width="7" height="9" rx="1.5" fill="#9fc5e8" stroke="#2a2520" stroke-width="1.6"/></svg>"##,
    },
    StickerSpec {
        id: "bowl",
        category: StickerCategory::Launch,
        svg: r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><path d="M44 12L35 28" stroke="#8b5a2b" stroke-width="3.5" stroke-linecap="round"/><path d="M12 28h40c0 14-8 24-20 24S12 42 12 28z" fill="#9d96e0" stroke="#2a2520" stroke-width="2" stroke-linejoin="round"/><ellipse cx="32" cy="28" rx="20" ry="6" fill="#cfcbf5" stroke="#2a2520" stroke-width="2"/><ellipse cx="32" cy="29" rx="15" ry="4" fill="#6f5396"/></svg>"##,
    },
    StickerSpec {
        id: "truck",
        category: StickerCategory::Transport,
        svg: r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 64"><rect x="8" y="16" width="50" height="32" rx="4" fill="#89b8e6" stroke="#2a2520" stroke-width="2.2"/><path d="M58 24h16l10 11v13H58z" fill="#f3b07a" stroke="#2a2520" stroke-width="2.2" stroke-linejoin="round"/><path d="M62 28h10l6 7H62z" fill="#dcebf8" stroke="#2a2520" stroke-width="1.6" stroke-linejoin="round"/><path d="M14 26h36M14 34h28" stroke="#fcfcfb" stroke-width="2.2" stroke-linecap="round"/><circle cx="24" cy="49" r="7" fill="#5e5852" stroke="#2a2520" stroke-width="2"/><circle cx="24" cy="49" r="2.8" fill="#f6f5f3"/><circle cx="72" cy="49" r="7" fill="#5e5852" stroke="#2a2520" stroke-width="2"/><circle cx="72" cy="49" r="2.8" fill="#f6f5f3"/></svg>"##,
    },
    StickerSpec {
        id: "mascot",
        category: StickerCategory::People,
        svg: r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><path d="M24 14l4-6 4 5 5-5 3 6" fill="#74a046" stroke="#2a2520" stroke-width="2" stroke-linejoin="round"/><circle cx="32" cy="32" r="16" fill="#e8b8cc" stroke="#2a2520" stroke-width="2.2"/><circle cx="32" cy="32" r="11" fill="#f8e8ef" stroke="#2a2520" stroke-width="1.5"/><circle cx="27" cy="30" r="2.4" fill="#2a2520"/><circle cx="37" cy="30" r="2.4" fill="#2a2520"/><path d="M26 36c2.5 3.5 9.5 3.5 12 0" fill="none" stroke="#2a2520" stroke-width="2" stroke-linecap="round"/><path d="M16 32l-7-4M48 32l7-4M25 47l-3 9M39 47l3 9" stroke="#74a046" stroke-width="3" stroke-linecap="round"/></svg>"##,
    },
    StickerSpec {
        id: "warning",
        category: StickerCategory::Status,
        svg: r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><path d="M32 10L8 52h48z" fill="#ffe380" stroke="#2a2520" stroke-width="2.2" stroke-linejoin="round"/><path d="M32 25v14" stroke="#2a2520" stroke-width="3" stroke-linecap="round"/><circle cx="32" cy="45" r="2.4" fill="#2a2520"/></svg>"##,
    },
    StickerSpec {
        id: "lightbulb",
        category: StickerCategory::Launch,
        svg: r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><path d="M22 36c-4-4-6-9-6-14a16 16 0 0 1 32 0c0 5-2 10-6 14l-2 6H24z" fill="#ffe380" stroke="#2a2520" stroke-width="2.2" stroke-linejoin="round"/><rect x="25" y="42" width="14" height="6" rx="2" fill="#d4d0ca" stroke="#2a2520" stroke-width="2"/><rect x="27" y="48" width="10" height="5" rx="2" fill="#aca59e" stroke="#2a2520" stroke-width="1.8"/></svg>"##,
    },
    StickerSpec {
        id: "rocket",
        category: StickerCategory::Launch,
        svg: r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><path d="M32 8c10 8 14 20 12 32H20C18 28 22 16 32 8z" fill="#fcfcfb" stroke="#2a2520" stroke-width="2.2" stroke-linejoin="round"/><path d="M20 30l-8 8 8 4M44 30l8 8-8 4" fill="#dd6f57" stroke="#2a2520" stroke-width="2" stroke-linejoin="round"/><circle cx="32" cy="24" r="5" fill="#89b8e6" stroke="#2a2520" stroke-width="2"/><path d="M26 42l6 13 6-13" fill="#e5a93c" stroke="#2a2520" stroke-width="1.8" stroke-linejoin="round"/></svg>"##,
    },
    StickerSpec {
        id: "flag",
        category: StickerCategory::Launch,
        svg: r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><path d="M18 10v44" stroke="#2a2520" stroke-width="2.6" stroke-linecap="round"/><path d="M18 13h28l-6 9 6 9H18z" fill="#dd6f57" stroke="#2a2520" stroke-width="2" stroke-linejoin="round"/></svg>"##,
    },
    StickerSpec {
        id: "calendar",
        category: StickerCategory::Launch,
        svg: r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect x="10" y="14" width="44" height="40" rx="6" fill="#fcfcfb" stroke="#2a2520" stroke-width="2.2"/><path d="M10 24h44" stroke="#2a2520" stroke-width="2"/><path d="M21 9v8M43 9v8" stroke="#2a2520" stroke-width="2.6" stroke-linecap="round"/><circle cx="24" cy="36" r="3" fill="#dd6f57"/><circle cx="34" cy="36" r="3" fill="#74a046"/><circle cx="44" cy="36" r="3" fill="#e5a93c"/></svg>"##,
    },
    StickerSpec {
        id: "clock",
        category: StickerCategory::Status,
        svg: r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><circle cx="32" cy="32" r="21" fill="#fcfcfb" stroke="#2a2520" stroke-width="2.2"/><circle cx="32" cy="32" r="17" fill="#fff4d8"/><path d="M32 19v13l9 6" fill="none" stroke="#2a2520" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>"##,
    },
    StickerSpec {
        id: "check",
        category: StickerCategory::Status,
        svg: r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><circle cx="32" cy="32" r="21" fill="#b4cb7c" stroke="#2a2520" stroke-width="2.2"/><path d="M22 33l7 7 14-16" fill="none" stroke="#2a2520" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>"##,
    },
    StickerSpec {
        id: "sparkles",
        category: StickerCategory::Status,
        svg: r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><path d="M28 10l4 14 14 4-14 4-4 14-4-14-14-4 14-4z" fill="#ffe380" stroke="#2a2520" stroke-width="2" stroke-linejoin="round"/><path d="M48 38l2.5 7 7 2.5-7 2.5-2.5 7-2.5-7-7-2.5 7-2.5z" fill="#f3b07a" stroke="#2a2520" stroke-width="1.8" stroke-linejoin="round"/></svg>"##,
    },
    StickerSpec {
        id: "database",
        category: StickerCategory::Engineering,
        svg: r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><path d="M16 18v28c0 5 7.2 8 16 8s16-3 16-8V18z" fill="#b5d3ed" stroke="#2a2520" stroke-width="2"/><ellipse cx="32" cy="18" rx="16" ry="6.5" fill="#e1effa" stroke="#2a2520" stroke-width="2"/><path d="M16 32c0 4 7.2 6.5 16 6.5s16-2.5 16-6.5" fill="none" stroke="#2a2520" stroke-width="1.8"/></svg>"##,
    },
    StickerSpec {
        id: "cloud",
        category: StickerCategory::Engineering,
        svg: r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><path d="M19 46h28a10 10 0 0 0 1-19.9A13 13 0 0 0 22.8 22a11 11 0 0 0-3.8 24z" fill="#dcebf8" stroke="#2a2520" stroke-width="2.2" stroke-linejoin="round"/></svg>"##,
    },
    StickerSpec {
        id: "target",
        category: StickerCategory::Launch,
        svg: r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><circle cx="32" cy="32" r="21" fill="#fcfcfb" stroke="#2a2520" stroke-width="2.2"/><circle cx="32" cy="32" r="14" fill="#dd6f57" stroke="#2a2520" stroke-width="1.8"/><circle cx="32" cy="32" r="7" fill="#fcfcfb" stroke="#2a2520" stroke-width="1.8"/><circle cx="32" cy="32" r="2.8" fill="#2a2520"/></svg>"##,
    },
    StickerSpec {
        id: "bug",
        category: StickerCategory::Engineering,
        svg: r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><circle cx="32" cy="20" r="8" fill="#5e5852" stroke="#2a2520" stroke-width="2"/><ellipse cx="32" cy="37" rx="13" ry="15" fill="#dd6f57" stroke="#2a2520" stroke-width="2"/><path d="M32 22v30M19 30l-8-4M19 38H10M21 46l-7 5M45 30l8-4M45 38h9M43 46l7 5" fill="none" stroke="#2a2520" stroke-width="2" stroke-linecap="round"/></svg>"##,
    },
    StickerSpec {
        id: "shield",
        category: StickerCategory::Engineering,
        svg: r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><path d="M32 10l18 6v14c0 12-7.6 20.6-18 24-10.4-3.4-18-12-18-24V16z" fill="#b4cb7c" stroke="#2a2520" stroke-width="2.2" stroke-linejoin="round"/><path d="M24 33l6 6 11-12" fill="none" stroke="#2a2520" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>"##,
    },
    StickerSpec {
        id: "gear",
        category: StickerCategory::Engineering,
        svg: r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><circle cx="32" cy="32" r="15" fill="#d9c6a3" stroke="#2a2520" stroke-width="2.2"/><circle cx="32" cy="32" r="6" fill="#fcfcfb" stroke="#2a2520" stroke-width="2"/><path d="M32 10v7M32 47v7M10 32h7M47 32h7M16.4 16.4l5 5M42.6 42.6l5 5M47.6 16.4l-5 5M21.4 42.6l-5 5" stroke="#2a2520" stroke-width="3" stroke-linecap="round"/></svg>"##,
    },
    StickerSpec {
        id: "terminal",
        category: StickerCategory::Engineering,
        svg: r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect x="10" y="14" width="44" height="36" rx="6" fill="#2a2520" stroke="#1c1917" stroke-width="2"/><path d="M19 25l8 7-8 7M31 39h13" fill="none" stroke="#8dbb5c" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>"##,
    },
    StickerSpec {
        id: "megaphone",
        category: StickerCategory::People,
        svg: r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><path d="M14 27h11l19-11v30L25 35H14a4 4 0 0 1-4-4 4 4 0 0 1 4-4z" fill="#f3b07a" stroke="#2a2520" stroke-width="2.2" stroke-linejoin="round"/><path d="M21 35l4 13h6l-4-13" fill="#d9c6a3" stroke="#2a2520" stroke-width="2" stroke-linejoin="round"/><path d="M50 24c4 4 4 10 0 14" fill="none" stroke="#dd6f57" stroke-width="2.4" stroke-linecap="round"/></svg>"##,
    },
    StickerSpec {
        id: "trophy",
        category: StickerCategory::People,
        svg: r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><path d="M20 14h24v13c0 8-5.4 13-12 13s-12-5-12-13z" fill="#ffe380" stroke="#2a2520" stroke-width="2.2" stroke-linejoin="round"/><path d="M20 18h-7c0 7 3 11 7 12M44 18h7c0 7-3 11-7 12" fill="none" stroke="#2a2520" stroke-width="2.2" stroke-linecap="round"/><path d="M32 40v9M23 49h18v5H23z" fill="#d9a86c" stroke="#2a2520" stroke-width="2" stroke-linejoin="round"/></svg>"##,
    },
];

pub fn sticker_svg(id: &str) -> Option<&'static str> {
    let norm = id.trim();
    STICKERS.iter().find(|s| s.id == norm).map(|s| s.svg)
}

pub fn resolve_sticker_svg<'a>(sticker: Option<&'a str>, custom_svg: Option<&'a str>) -> Option<&'a str> {
    if let Some(svg) = custom_svg
        && svg.trim_start().starts_with("<svg")
    {
        return Some(svg);
    }
    sticker.and_then(sticker_svg)
}

#[derive(Clone, PartialEq, Eq, Hash)]
struct SvgDrawingKey {
    hash: u64,
    svg: String,
}

fn svg_drawing_cache() -> &'static Mutex<LruCache<SvgDrawingKey, Option<Arc<Drawing>>>> {
    static CACHE: OnceLock<Mutex<LruCache<SvgDrawingKey, Option<Arc<Drawing>>>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(LruCache::new(SVG_DRAWING_CACHE_CAPACITY)))
}

pub fn cached_svg_drawing(svg: &str) -> Option<Arc<Drawing>> {
    let key = SvgDrawingKey {
        hash: hash_str(svg),
        svg: svg.to_owned(),
    };
    if let Some(cached) = svg_drawing_cache().lock().unwrap_or_else(|p| p.into_inner()).get(&key) {
        return cached;
    }
    let parsed = nsh_core::svg::drawing(svg).ok().map(Arc::new);
    svg_drawing_cache().lock().unwrap_or_else(|p| p.into_inner()).insert(key, parsed.clone());
    parsed
}

pub fn sticker_drawing(id: &str) -> Option<Arc<Drawing>> {
    sticker_svg(id).and_then(cached_svg_drawing)
}

pub fn sticker_cache_stats() -> CacheStats {
    svg_drawing_cache().lock().unwrap_or_else(|p| p.into_inner()).stats()
}

pub fn clear_sticker_cache() {
    svg_drawing_cache().lock().unwrap_or_else(|p| p.into_inner()).clear();
}
