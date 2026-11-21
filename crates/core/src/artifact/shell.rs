//! The workbench's view of an html version (`shell.ts`): the page with the
//! selection script and the runtime for how it is shown, in the workbench's
//! theme. The words after the page and shared inline helpers are VibeValley's
//! own, generated into `assets/shell.json` by `gen/artifact.ts`.

use std::collections::HashMap;
use std::sync::LazyLock;

use regex::Regex;
use vibevalley_protocol::ArtifactDisplay;

static BUNDLE: LazyLock<HashMap<String, String>> =
    LazyLock::new(|| serde_json::from_str(include_str!("../../assets/artifact/shell.json")).expect("the bundled shell"));

static HEAD_TAG: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)<head\b[^>]*>").expect("regex"));
static DOCTYPE_TAG: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)^<!doctype\b[^>]*>").expect("regex"));

/// `shellThemeOf`: dark when asked for, else light.
pub fn shell_theme_of(asked: Option<&str>) -> &'static str {
    if asked == Some("dark") { "dark" } else { "light" }
}

pub fn theme_variables(theme: &str) -> &'static str {
    let key = if shell_theme_of(Some(theme)) == "dark" { "theme_dark" } else { "theme_light" };
    BUNDLE.get(key).map_or("", String::as_str)
}

pub fn type_variables() -> &'static str {
    BUNDLE.get("type_variables").map_or("", String::as_str)
}

pub fn selection_script() -> &'static str {
    BUNDLE.get("selection_script").map_or("", String::as_str)
}

pub fn motion_recorder_helper() -> &'static str {
    BUNDLE.get("motion_recorder_helper").map_or("", String::as_str)
}

fn inject_motion_preload(page: &str) -> String {
    let preload = BUNDLE.get("motion_preload").map_or("", String::as_str);
    if let Some(m) = HEAD_TAG.find(page) {
        return format!("{}{preload}{}", &page[..m.end()], &page[m.end()..]);
    }
    if let Some(m) = DOCTYPE_TAG.find(page) {
        return format!("{}{preload}{}", &page[..m.end()], &page[m.end()..]);
    }
    format!("{preload}{page}")
}

/// `withShell`.
pub fn with_shell(page: &str, display: ArtifactDisplay, theme: &str) -> String {
    let base = if display == ArtifactDisplay::Motion {
        inject_motion_preload(page)
    } else {
        page.to_string()
    };
    let key = format!("{}|{}", display.as_str(), shell_theme_of(Some(theme)));
    format!("{base}{}", BUNDLE.get(&key).map_or("", String::as_str))
}

/// `shellPath`: the query carries the display and theme because a
/// version's answer is cached for good.
pub fn shell_path(id: &str, version: i64, display: ArtifactDisplay, theme: &str, at: Option<i64>, still: bool, print: bool) -> String {
    let mut p = format!("/api/v1/artifact/{id}/{version}?shell=1&display={}&theme={theme}", display.as_str());
    if let Some(at) = at {
        p.push_str(&format!("&at={at}"));
    }
    if still {
        p.push_str("&still=1");
    }
    if print {
        p.push_str("&print=1");
    }
    p
}
