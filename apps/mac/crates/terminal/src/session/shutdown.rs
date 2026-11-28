//! Two-stage graceful shutdown state machine (`SIGINT` -> `SIGHUP` -> `SIGKILL`).

use std::time::{Duration, Instant};

use crate::pty::{self, Pty};

const SIGINT_GRACE: Duration = Duration::from_millis(1500);
const SIGHUP_GRACE: Duration = Duration::from_millis(1000);
const FG_POLL_INTERVAL: Duration = Duration::from_millis(20);
pub(crate) const REAP_GRACE: Duration = Duration::from_millis(200);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub(crate) enum ShutdownStage {
    #[default]
    None,
    /// Stage 1: `SIGINT` sent to foreground process group; waiting for it to exit or return to shell.
    Sigint { fg_pgid: i32, deadline: Instant },
    /// Stage 2: `SIGHUP` sent to shell/group for history flush; waiting before `SIGKILL`.
    Sighup { deadline: Instant },
}

impl ShutdownStage {
    pub(crate) fn start(&mut self, pty: &Pty, child_exited: bool, now: Instant) {
        if child_exited || *self != Self::None {
            return;
        }
        let Some(pid) = pty.pid else {
            return;
        };
        if let Some(pgid) = pty.foreground_pgid()
            && pgid != pid
        {
            pty::signal(-pgid, libc::SIGINT);
            *self = Self::Sigint {
                fg_pgid: pgid,
                deadline: now + SIGINT_GRACE,
            };
        } else {
            hangup(pty);
            *self = Self::Sighup { deadline: now + SIGHUP_GRACE };
        }
    }

    pub(crate) fn advance(&mut self, pty: &Pty, child_exited: bool, now: Instant) {
        if child_exited {
            *self = Self::None;
            return;
        }
        match *self {
            Self::None => {}
            Self::Sigint { fg_pgid, deadline } => {
                if pty.foreground_pgid() != Some(fg_pgid) || now >= deadline {
                    hangup(pty);
                    *self = Self::Sighup { deadline: now + SIGHUP_GRACE };
                }
            }
            Self::Sighup { deadline } => {
                if now >= deadline {
                    force_kill(pty, child_exited);
                    *self = Self::None;
                }
            }
        }
    }

    pub(crate) fn step_deadline(&self, now: Instant) -> Option<Instant> {
        match *self {
            Self::None => None,
            Self::Sigint { deadline, .. } => Some((now + FG_POLL_INTERVAL).min(deadline)),
            Self::Sighup { deadline } => Some(deadline),
        }
    }
}

pub(crate) fn hangup(pty: &Pty) {
    let Some(pid) = pty.pid else {
        return;
    };
    if let Some(pgid) = pty.foreground_pgid()
        && pgid != pid
    {
        pty::signal(-pgid, libc::SIGHUP);
    }
    pty::signal(pid, libc::SIGHUP);
}

pub(crate) fn force_kill(pty: &Pty, child_exited: bool) {
    if !child_exited && let Some(pid) = pty.pid {
        // The child is a session leader, so its pid names its group too.
        pty::signal(-pid, libc::SIGKILL);
        pty::signal(pid, libc::SIGKILL);
    }
}
