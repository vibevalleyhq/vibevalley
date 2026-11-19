//! The workbench's view of an html version (`shell.ts`): the page with the
//! selection script and the runtime for how it is shown, in the workbench's
//! theme. The words after the page are VibeValley's own, generated into
//! `assets/shell.json` by `gen/artifact.ts`.

use std::collections::HashMap;
use std::sync::LazyLock;

use vibevalley_protocol::ArtifactDisplay;

static AFTER: LazyLock<HashMap<String, String>> = LazyLock::new(|| serde_json::from_str(include_str!("../assets/shell.json")).expect("the bundled shell"));

/// `shellThemeOf`: dark when asked for, else light.
pub fn shell_theme_of(asked: Option<&str>) -> &'static str {
    if asked == Some("dark") { "dark" } else { "light" }
}

/// `withShell`.
pub fn with_shell(page: &str, display: ArtifactDisplay, theme: &str) -> String {
    let key = format!("{}|{}", display.as_str(), shell_theme_of(Some(theme)));
    format!("{page}{}", AFTER.get(&key).map_or("", String::as_str))
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
