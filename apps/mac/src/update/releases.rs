use serde::Deserialize;

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct Build {
    /// `arm64` or `x64`.
    pub arch: String,
    /// The zip of the .app, beside `release.json`.
    pub file: String,
    pub size: u64,
    /// Hex.
    pub sha512: String,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct Release {
    pub version: String,
    /// One line a change.
    #[serde(default)]
    pub notes: Vec<String>,
    /// The release's page, to download it by hand.
    pub page: String,
    pub builds: Vec<Build>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ListedRelease {
    pub tag_name: String,
    pub draft: bool,
    pub assets: Vec<ListedAsset>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ListedAsset {
    pub name: String,
    pub browser_download_url: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Stage {
    Stable,
    Beta,
    Alpha,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Manual {
    Translocated,
    DiskImage,
    ReadOnly,
    NoBuild,
}

impl Manual {
    pub fn name(self) -> &'static str {
        match self {
            Manual::Translocated => "translocated",
            Manual::DiskImage => "diskImage",
            Manual::ReadOnly => "readOnly",
            Manual::NoBuild => "noBuild",
        }
    }
}

fn rank_of(v: &str) -> Option<[u64; 5]> {
    let digits = |s: &str| {
        (!s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()))
            .then(|| s.parse::<u64>().ok())
            .flatten()
    };
    let (numbers, pre) = match v.split_once('-') {
        Some((numbers, pre)) => (numbers, Some(pre)),
        None => (v, None),
    };
    let mut parts = numbers.split('.');
    let (x, y, z) = (digits(parts.next()?)?, digits(parts.next()?)?, digits(parts.next()?)?);
    if parts.next().is_some() {
        return None;
    }
    let (stage, n) = match pre {
        None => (2, 0),
        Some(pre) => {
            let (name, n) = pre.split_once('.')?;
            let stage = match name {
                "alpha" => 0,
                "beta" => 1,
                _ => return None,
            };
            (stage, digits(n)?)
        }
    };
    Some([x, y, z, stage, n])
}

pub fn is_version(v: &str) -> bool {
    rank_of(v).is_some()
}

pub fn newer(a: &str, b: &str) -> bool {
    match (rank_of(a), rank_of(b)) {
        (Some(x), Some(y)) => x > y,
        _ => false,
    }
}

pub fn stage_of(v: &str) -> Option<Stage> {
    Some(match rank_of(v)?[3] {
        0 => Stage::Alpha,
        1 => Stage::Beta,
        _ => Stage::Stable,
    })
}

pub fn manifest_for(list: &[ListedRelease], stage: Stage) -> Option<String> {
    let mut best: Option<(&str, &str)> = None;
    for r in list {
        let version = r.tag_name.strip_prefix('v').unwrap_or(&r.tag_name);
        let Some(asset) = r.assets.iter().find(|a| a.name == "release.json") else {
            continue;
        };
        if r.draft || stage_of(version) != Some(stage) {
            continue;
        }
        if best.is_none_or(|(b, _)| newer(version, b)) {
            best = Some((version, &asset.browser_download_url));
        }
    }
    best.map(|(_, url)| url.to_string())
}

pub fn build_for<'a>(release: &'a Release, arch: &str) -> Option<&'a Build> {
    release.builds.iter().find(|b| b.arch == arch)
}

pub fn bundle_of(exe: &str) -> Option<&str> {
    let at = exe.rfind(".app/Contents/MacOS/")?;
    Some(&exe[..at + ".app".len()])
}

pub fn place_problem(bundle: &str, writable: bool) -> Option<Manual> {
    if bundle.contains("/AppTranslocation/") {
        return Some(Manual::Translocated);
    }
    if bundle.starts_with("/Volumes/") {
        return Some(Manual::DiskImage);
    }
    (!writable).then_some(Manual::ReadOnly)
}

pub fn plist_version(xml: &str) -> Option<&str> {
    let key = if xml.contains("<key>VibeValleyVersion</key>") {
        "<key>VibeValleyVersion</key>"
    } else {
        "<key>CFBundleShortVersionString</key>"
    };
    let rest = &xml[xml.find(key)? + key.len()..];
    let rest = rest.trim_start().strip_prefix("<string>")?;
    Some(&rest[..rest.find('<')?])
}

/// an ad-hoc signature (`TeamIdentifier=not set`) or none.
pub fn team_of(codesign: &str) -> Option<&str> {
    let team = codesign.lines().find_map(|l| l.strip_prefix("TeamIdentifier="))?.trim();
    (!team.is_empty() && team != "not set").then_some(team)
}

pub fn same_signer(running: Option<&str>, next: Option<&str>) -> bool {
    running.is_none() || running == next
}

pub fn beside(feed: &str, file: &str) -> Option<String> {
    if file.is_empty() || !file.bytes().all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b)) || file.contains("..") {
        return None;
    }
    let end = feed.find(['?', '#']).unwrap_or(feed.len());
    let slash = feed[..end].rfind('/')?;
    Some(format!("{}{file}", &feed[..=slash]))
}

pub fn safe_archive(names: &str) -> bool {
    !names.is_empty()
        && names.lines().all(|name| {
            !name.starts_with('/')
                && !name.split('/').any(|part| part == "..")
                && (name == "VibeValley.app/" || name.starts_with("VibeValley.app/") || name.starts_with("__MACOSX/"))
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn regression_archive_paths_stay_inside_the_app() {
        assert!(safe_archive("VibeValley.app/\nVibeValley.app/Contents/MacOS/VibeValley\n"));
        assert!(!safe_archive("VibeValley.app/../../outside\n"));
        assert!(!safe_archive("/tmp/outside\n"));
        assert!(!safe_archive("../outside\n"));
        assert!(!safe_archive(""));
    }

    #[test]
    fn a_version_is_later_by_its_numbers_and_one_that_is_not_a_version_is_never_later() {
        assert!(newer("0.10.0", "0.9.9"));
        assert!(!newer("1.0.0", "1.0.0"));
        assert!(!newer("0.9.9", "0.10.0"));
        assert!(newer("0.2.0", "0.0.0"));
        assert!(!newer("1.0.0-rc.1", "0.1.0"));
        assert!(!is_version("0.4"));
        assert!(!is_version("0.4.0.1"));
        assert!(!is_version("v0.4.0"));
        assert!(!is_version("0.4.0-beta"));
    }

    #[test]
    fn a_prerelease_comes_before_its_release_alpha_then_beta_each_by_its_number() {
        let order = [
            "0.4.0-alpha.1",
            "0.4.0-alpha.2",
            "0.4.0-alpha.10",
            "0.4.0-beta.1",
            "0.4.0-beta.2",
            "0.4.0",
            "0.4.1-alpha.1",
            "0.4.1",
        ];
        for (i, v) in order.iter().enumerate() {
            for w in &order[i + 1..] {
                assert!(newer(w, v), "{w} > {v}");
                assert!(!newer(v, w), "{v} < {w}");
            }
        }
        assert_eq!(stage_of("0.4.0"), Some(Stage::Stable));
        assert_eq!(stage_of("0.4.0-beta.3"), Some(Stage::Beta));
        assert_eq!(stage_of("0.4.0-alpha.1"), Some(Stage::Alpha));
        assert_eq!(stage_of("0.4"), None);
    }

    fn listed(tag: &str, draft: bool) -> ListedRelease {
        ListedRelease {
            tag_name: tag.into(),
            draft,
            assets: vec![ListedAsset {
                name: "release.json".into(),
                browser_download_url: format!("https://example.test/{tag}/release.json"),
            }],
        }
    }

    #[test]
    fn an_app_updates_to_the_latest_release_of_its_own_stage_never_to_a_draft() {
        let mut list = vec![
            listed("v0.5.0-alpha.1", true),
            listed("v0.4.0-beta.2", false),
            listed("v0.4.0-alpha.3", false),
            listed("v0.3.1", false),
            listed("v0.5.0-alpha.0", false),
        ];
        assert_eq!(manifest_for(&list, Stage::Stable).as_deref(), Some("https://example.test/v0.3.1/release.json"));
        assert_eq!(
            manifest_for(&list, Stage::Beta).as_deref(),
            Some("https://example.test/v0.4.0-beta.2/release.json")
        );
        // Not the newer beta or release: an alpha app takes alphas.
        list.push(listed("v0.6.0", false));
        assert_eq!(
            manifest_for(&list, Stage::Alpha).as_deref(),
            Some("https://example.test/v0.5.0-alpha.0/release.json")
        );
        assert_eq!(manifest_for(&[listed("v0.4.0-beta.1", true)], Stage::Beta), None);
        let mut bare = listed("v0.7.0", false);
        bare.assets.clear();
        assert_eq!(manifest_for(&[bare], Stage::Stable), None);
    }

    #[test]
    fn the_app_is_found_from_its_executable_and_only_one_in_a_place_it_can_be_written_is_replaced() {
        assert_eq!(
            bundle_of("/Applications/VibeValley.app/Contents/MacOS/VibeValley"),
            Some("/Applications/VibeValley.app")
        );
        assert_eq!(bundle_of("/repo/target/release/vibevalley-mac"), None);
        assert_eq!(place_problem("/Applications/VibeValley.app", true), None);
        assert_eq!(place_problem("/Applications/VibeValley.app", false), Some(Manual::ReadOnly));
        assert_eq!(place_problem("/Volumes/VibeValley 0.2.0/VibeValley.app", false), Some(Manual::DiskImage));
        assert_eq!(
            place_problem("/private/var/folders/x/T/AppTranslocation/ABC/d/VibeValley.app", true),
            Some(Manual::Translocated)
        );
    }

    #[test]
    fn the_info_plists_short_version_is_read() {
        let xml =
            "<dict>\n\t<key>CFBundleName</key>\n\t<string>VibeValley</string>\n\t<key>CFBundleShortVersionString</key>\n\t<string>0.2.0</string>\n</dict>";
        assert_eq!(plist_version(xml), Some("0.2.0"));
        assert_eq!(plist_version("<dict/>"), None);
        assert_eq!(
            plist_version("<key>VibeValleyVersion</key><string>0.2.0-beta.1</string><key>CFBundleShortVersionString</key><string>0.2.0</string>"),
            Some("0.2.0-beta.1")
        );
    }

    #[test]
    fn a_release_is_read_from_its_manifest_and_gives_the_build_of_an_architecture() {
        let text = r#"{"version":"0.2.0","notes":["One"],"schema":"old field","page":"https://example.test/v0.2.0",
            "builds":[{"arch":"arm64","file":"VibeValley-0.2.0-arm64.zip","size":12,"sha512":"ab"}]}"#;
        let release: Release = serde_json::from_str(text).unwrap();
        assert_eq!(release.version, "0.2.0");
        assert_eq!(release.notes, ["One"]);
        assert_eq!(build_for(&release, "arm64").map(|b| b.size), Some(12));
        assert_eq!(build_for(&release, "x64"), None);
        assert!(serde_json::from_str::<Release>(r#"{"version":"0.2.0"}"#).is_err());
    }

    #[test]
    fn a_signed_app_takes_only_its_own_teams_update_and_a_local_one_any() {
        let signed = "Executable=/x\nIdentifier=dev.vibevalley.app\nTeamIdentifier=ABCDE12345\nSealed Resources version=2";
        assert_eq!(team_of(signed), Some("ABCDE12345"));
        assert_eq!(team_of("Signature=adhoc\nTeamIdentifier=not set\n"), None);
        assert_eq!(team_of("code object is not signed at all"), None);
        assert!(same_signer(Some("A"), Some("A")));
        assert!(!same_signer(Some("A"), Some("B")));
        assert!(!same_signer(Some("A"), None));
        assert!(same_signer(None, None));
        assert!(same_signer(None, Some("A")));
    }

    #[test]
    fn a_releases_file_is_beside_its_manifest_and_names_no_other_place() {
        assert_eq!(
            beside("https://example.test/v0.2.0/release.json", "VibeValley-0.2.0-arm64.zip").as_deref(),
            Some("https://example.test/v0.2.0/VibeValley-0.2.0-arm64.zip")
        );
        assert_eq!(
            beside("http://127.0.0.1:9/good/release.json?x=1/2", "a.zip").as_deref(),
            Some("http://127.0.0.1:9/good/a.zip")
        );
        assert_eq!(beside("https://example.test/release.json", "../evil.zip"), None);
        assert_eq!(beside("https://example.test/release.json", "https://evil.test/a.zip"), None);
        assert_eq!(beside("https://example.test/release.json", ""), None);
    }
}
