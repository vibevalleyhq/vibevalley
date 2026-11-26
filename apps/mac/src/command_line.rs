use std::path::{Path, PathBuf};

pub use vibevalley_protocol::HostCommandLineState as State;

pub struct CommandLine {
    binary: PathBuf,
    link: PathBuf,
    path: Vec<PathBuf>,
}

impl CommandLine {
    pub fn current() -> Result<Self, String> {
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        let parent = exe.parent().ok_or("the executable has no directory")?;
        let binary = parent.join("vibevalley");
        let home = std::env::var_os("HOME").ok_or("HOME is not set")?;
        let path = std::env::var_os("PATH").map(|p| std::env::split_paths(&p).collect()).unwrap_or_default();
        Ok(Self {
            binary,
            link: PathBuf::from(home).join(".local/bin/vibevalley"),
            path,
        })
    }

    fn owns_link(&self) -> bool {
        std::fs::read_link(&self.link).is_ok_and(|target| target == self.binary)
    }

    pub fn available(&self) -> bool {
        self.binary.is_file() || self.owns_link()
    }

    pub fn state(&self) -> State {
        let installed = self.owns_link();
        let taken = !installed && std::fs::symlink_metadata(&self.link).is_ok();
        State {
            command: "vibevalley".into(),
            link: self.link.to_string_lossy().into_owned(),
            installed,
            on_path: self.link.parent().is_some_and(|dir| self.path.iter().any(|entry| same_dir(entry, dir))),
            taken,
        }
    }

    pub fn install(&self) -> Result<State, String> {
        if !self.binary.is_file() {
            return Err(format!("the CLI is not installed beside the app: {}", self.binary.display()));
        }
        if self.owns_link() {
            return Ok(self.state());
        }
        let parent = self.link.parent().ok_or("the command has no directory")?;
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        std::os::unix::fs::symlink(&self.binary, &self.link).map_err(|e| format!("{}: {e}", self.link.display()))?;
        Ok(self.state())
    }

    pub fn remove(&self) -> Result<State, String> {
        if self.owns_link() {
            std::fs::remove_file(&self.link).map_err(|e| e.to_string())?;
        } else if self.state().taken {
            return Err("the command belongs to another installation".into());
        }
        Ok(self.state())
    }
}

fn same_dir(a: &Path, b: &Path) -> bool {
    a == b || matches!((a.canonicalize(), b.canonicalize()), (Ok(a), Ok(b)) if a == b)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn regression_install_and_remove_only_our_own_link() {
        let temp = tempfile::tempdir().unwrap();
        let binary = temp.path().join("app/vibevalley");
        std::fs::create_dir(binary.parent().unwrap()).unwrap();
        std::fs::write(&binary, b"cli").unwrap();
        let bin = temp.path().join("bin");
        let cli = CommandLine {
            binary,
            link: bin.join("vibevalley"),
            path: vec![bin],
        };
        assert!(!cli.state().installed);
        let state = cli.install().unwrap();
        assert!(state.installed && state.on_path && !state.taken);
        assert!(cli.install().unwrap().installed);
        assert!(!cli.remove().unwrap().installed);
        std::fs::write(&cli.link, b"someone else").unwrap();
        assert!(cli.state().taken);
        assert!(cli.install().is_err());
        assert!(cli.remove().is_err());
        assert_eq!(std::fs::read(&cli.link).unwrap(), b"someone else");
    }

    #[test]
    fn regression_dangling_foreign_links_are_never_overwritten() {
        let temp = tempfile::tempdir().unwrap();
        let binary = temp.path().join("app-cli");
        std::fs::write(&binary, b"cli").unwrap();
        let cli = CommandLine {
            binary,
            link: temp.path().join("vibevalley"),
            path: vec![],
        };
        std::os::unix::fs::symlink("missing", &cli.link).unwrap();
        assert!(cli.state().taken);
        assert!(cli.install().is_err());
        assert!(cli.remove().is_err());
    }
}
