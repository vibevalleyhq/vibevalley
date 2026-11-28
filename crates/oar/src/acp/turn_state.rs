//! Bit-packed atomic CAS state machine for ACP turn lifecycle.
//!
//! Converges `replaying`, `abort_wanted`, `detached_continuation`, and
//! `in_flight_prompts` into a single `AtomicU64` so prompt completion,
//! Antigravity detached-continuation `usage_update`, and `abort`/`Cancel`
//! cannot race into double `TurnFinished` emissions or stuck detached turns.

use std::fmt;

use crate::loom_sync::{AtomicU64, Ordering};

const REPLAYING_BIT: u64 = 1 << 63;
const ABORT_WANTED_BIT: u64 = 1 << 62;
const DETACHED_BIT: u64 = 1 << 61;
const FLAGS_MASK: u64 = REPLAYING_BIT | ABORT_WANTED_BIT | DETACHED_BIT;
const IN_FLIGHT_MASK: u64 = !FLAGS_MASK;

/// Result of registering a newly dispatched `session/prompt`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct PromptStart {
    /// True when `in_flight` transitioned `0 -> 1` (first prompt of a turn).
    pub(crate) is_first: bool,
}

/// Decision returned when a `session/prompt` reply arrives with `Ok`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PromptOkOutcome {
    /// Another steered prompt is still in flight; keep the turn open.
    StillInFlight,
    /// Last prompt completed with open background work and no abort requested;
    /// wait for `usage_update` or `Command::Cancel`.
    Detached,
    /// Last prompt finished the turn; emit `TurnFinished` now.
    Finish { abort_wanted: bool },
}

/// Decision returned when a `session/prompt` reply arrives with `Err`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PromptErrOutcome {
    /// Another steered prompt is still in flight; keep the turn open.
    StillInFlight,
    /// Last prompt failed; emit `TurnFinished` (`Aborted` if `abort_wanted`, else `Error`).
    Finish { abort_wanted: bool },
}

/// Decision returned when a root `usage_update` arrives on Antigravity.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum UsageOutcome {
    NoOp,
    /// Detached continuation finished; emit `TurnFinished` now.
    FinishDetached {
        abort_wanted: bool,
    },
}

/// Decision returned when `Command::Cancel` is processed by the connection loop.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CancelOutcome {
    /// Either a prompt is still in flight (and will emit `TurnFinished` itself)
    /// or no detached turn was waiting.
    Pending,
    /// Detached continuation was active with zero in-flight prompts;
    /// emit `TurnFinished(StopReason::Aborted)` now.
    FinishAborted,
}

/// RAII guard clearing `REPLAYING_BIT` on drop, even if `session/load` is cancelled.
pub(crate) struct ReplayGuard<'a> {
    machine: &'a AcpTurnMachine,
}

impl Drop for ReplayGuard<'_> {
    fn drop(&mut self) {
        self.machine.set_replaying(false);
    }
}

/// Single-word atomic state machine for ACP prompt/abort/replay/detached state.
pub(crate) struct AcpTurnMachine {
    state: AtomicU64,
}

impl AcpTurnMachine {
    pub(crate) fn new() -> Self {
        Self { state: AtomicU64::new(0) }
    }

    fn cas_update<R>(&self, mut f: impl FnMut(u64) -> (u64, R)) -> R {
        let mut cur = self.state.load(Ordering::Acquire);
        loop {
            let (next, out) = f(cur);
            if next == cur {
                return out;
            }
            match self.state.compare_exchange(cur, next, Ordering::AcqRel, Ordering::Acquire) {
                Ok(_) => return out,
                Err(actual) => cur = actual,
            }
        }
    }

    pub(crate) fn enter_replay(&self) -> ReplayGuard<'_> {
        self.set_replaying(true);
        ReplayGuard { machine: self }
    }

    pub(crate) fn set_replaying(&self, active: bool) {
        self.cas_update(|cur| {
            let next = if active { cur | REPLAYING_BIT } else { cur & !REPLAYING_BIT };
            (next, ())
        });
    }

    pub(crate) fn is_replaying(&self) -> bool {
        (self.state.load(Ordering::Acquire) & REPLAYING_BIT) != 0
    }

    #[cfg(test)]
    pub(crate) fn in_flight(&self) -> u64 {
        self.state.load(Ordering::Acquire) & IN_FLIGHT_MASK
    }

    #[cfg(test)]
    pub(crate) fn is_detached(&self) -> bool {
        (self.state.load(Ordering::Acquire) & DETACHED_BIT) != 0
    }

    #[cfg(test)]
    pub(crate) fn is_abort_wanted(&self) -> bool {
        (self.state.load(Ordering::Acquire) & ABORT_WANTED_BIT) != 0
    }

    /// Registers a newly dispatched prompt, clearing any stale `DETACHED_BIT`
    /// while preserving `REPLAYING_BIT` and `ABORT_WANTED_BIT`.
    pub(crate) fn begin_prompt(&self) -> PromptStart {
        self.cas_update(|cur| {
            let in_flight = cur & IN_FLIGHT_MASK;
            let next_in_flight = in_flight
                .checked_add(1)
                .filter(|&n| n <= IN_FLIGHT_MASK)
                .expect("in-flight prompt count overflow");
            let next = (cur & (REPLAYING_BIT | ABORT_WANTED_BIT)) | next_in_flight;
            (next, PromptStart { is_first: in_flight == 0 })
        })
    }

    /// Reverts a `begin_prompt` call when sending the request fails synchronously.
    pub(crate) fn rollback_prompt(&self) {
        self.cas_update(|cur| {
            let in_flight = cur & IN_FLIGHT_MASK;
            let next_in_flight = in_flight.saturating_sub(1);
            ((cur & FLAGS_MASK) | next_in_flight, ())
        });
    }

    /// Fast path for steered turns: if `in_flight > 1`, atomically decrements by 1
    /// and returns `true` so intermediate prompt completions skip turn-end checks.
    pub(crate) fn try_finish_steered_prompt(&self) -> bool {
        self.cas_update(|cur| {
            let in_flight = cur & IN_FLIGHT_MASK;
            if in_flight > 1 {
                ((cur & FLAGS_MASK) | (in_flight - 1), true)
            } else {
                (cur, false)
            }
        })
    }

    /// Records a `session/prompt` `Ok` completion.
    ///
    /// Atomically checks `in_flight` and `ABORT_WANTED_BIT` together so an
    /// interleaved abort can never leave the turn stuck in `DETACHED_BIT`.
    pub(crate) fn on_prompt_ok(&self, may_detach: bool) -> PromptOkOutcome {
        self.cas_update(|cur| {
            let in_flight = cur & IN_FLIGHT_MASK;
            let abort_wanted = (cur & ABORT_WANTED_BIT) != 0;
            let next_in_flight = in_flight.saturating_sub(1);
            if next_in_flight > 0 {
                return ((cur & FLAGS_MASK) | next_in_flight, PromptOkOutcome::StillInFlight);
            }
            let replay = cur & REPLAYING_BIT;
            if may_detach && !abort_wanted {
                (replay | DETACHED_BIT, PromptOkOutcome::Detached)
            } else {
                (replay, PromptOkOutcome::Finish { abort_wanted })
            }
        })
    }

    /// Records a `session/prompt` `Err` completion.
    pub(crate) fn on_prompt_err(&self) -> PromptErrOutcome {
        self.cas_update(|cur| {
            let in_flight = cur & IN_FLIGHT_MASK;
            let abort_wanted = (cur & ABORT_WANTED_BIT) != 0;
            let next_in_flight = in_flight.saturating_sub(1);
            if next_in_flight > 0 {
                return ((cur & FLAGS_MASK) | next_in_flight, PromptErrOutcome::StillInFlight);
            }
            let replay = cur & REPLAYING_BIT;
            (replay, PromptErrOutcome::Finish { abort_wanted })
        })
    }

    /// Handles a root `usage_update`: finishes the turn if and only if
    /// `in_flight == 0` and `DETACHED_BIT` is set in the same atomic snapshot.
    pub(crate) fn on_usage_update(&self) -> UsageOutcome {
        self.cas_update(|cur| {
            let in_flight = cur & IN_FLIGHT_MASK;
            let detached = (cur & DETACHED_BIT) != 0;
            if in_flight == 0 && detached {
                let abort_wanted = (cur & ABORT_WANTED_BIT) != 0;
                (cur & REPLAYING_BIT, UsageOutcome::FinishDetached { abort_wanted })
            } else {
                (cur, UsageOutcome::NoOp)
            }
        })
    }

    /// Marks abort requested from `AcpDriver::abort()` prior to queuing `Command::Cancel`.
    pub(crate) fn request_abort(&self) {
        self.cas_update(|cur| (cur | ABORT_WANTED_BIT, ()));
    }

    /// Processes `Command::Cancel` on the connection loop.
    ///
    /// - If `in_flight == 0 && DETACHED`: consumes `DETACHED` and clears `ABORT_WANTED`,
    ///   returning `CancelOutcome::FinishAborted`.
    /// - If `in_flight == 0 && !DETACHED`: clears stale `ABORT_WANTED` and returns `Pending`.
    /// - If `in_flight > 0`: ensures `ABORT_WANTED` stays set for the in-flight prompt.
    pub(crate) fn on_cancel(&self) -> CancelOutcome {
        self.cas_update(|cur| {
            let in_flight = cur & IN_FLIGHT_MASK;
            let detached = (cur & DETACHED_BIT) != 0;
            if in_flight == 0 {
                let next = cur & REPLAYING_BIT;
                let outcome = if detached { CancelOutcome::FinishAborted } else { CancelOutcome::Pending };
                (next, outcome)
            } else {
                (cur | ABORT_WANTED_BIT, CancelOutcome::Pending)
            }
        })
    }
}

impl Default for AcpTurnMachine {
    fn default() -> Self {
        Self::new()
    }
}

impl fmt::Debug for AcpTurnMachine {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let bits = self.state.load(Ordering::Acquire);
        f.debug_struct("AcpTurnMachine")
            .field("in_flight", &(bits & IN_FLIGHT_MASK))
            .field("detached", &((bits & DETACHED_BIT) != 0))
            .field("abort_wanted", &((bits & ABORT_WANTED_BIT) != 0))
            .field("replaying", &((bits & REPLAYING_BIT) != 0))
            .finish()
    }
}

#[cfg(all(test, not(feature = "loom")))]
mod tests {
    use super::{AcpTurnMachine, CancelOutcome, PromptErrOutcome, PromptOkOutcome, UsageOutcome};

    #[test]
    fn turn_machine_tracks_prompts_detached_abort_replay_without_underflow() {
        let turn = AcpTurnMachine::new();
        assert_eq!(turn.in_flight(), 0);
        assert!(!turn.is_detached());
        assert!(!turn.is_abort_wanted());
        assert!(!turn.is_replaying());

        // Underflow on idle must saturate at 0.
        turn.rollback_prompt();
        assert_eq!(turn.in_flight(), 0);

        // Replay guard sets and clears REPLAYING_BIT independently of prompts.
        {
            let _guard = turn.enter_replay();
            assert!(turn.is_replaying());
            assert!(turn.begin_prompt().is_first);
            assert_eq!(turn.in_flight(), 1);
            assert!(turn.is_replaying());
        }
        assert!(!turn.is_replaying());
        assert_eq!(turn.in_flight(), 1);

        // Detached completion followed by usage_update finishes once.
        assert_eq!(turn.on_prompt_ok(true), PromptOkOutcome::Detached);
        assert!(turn.is_detached());
        assert_eq!(turn.in_flight(), 0);
        assert_eq!(turn.on_usage_update(), UsageOutcome::FinishDetached { abort_wanted: false });
        assert!(!turn.is_detached());
        assert_eq!(turn.on_usage_update(), UsageOutcome::NoOp);

        // Abort during active prompt refuses detach and turns error into Aborted.
        assert!(turn.begin_prompt().is_first);
        turn.request_abort();
        assert!(turn.is_abort_wanted());
        assert_eq!(turn.on_cancel(), CancelOutcome::Pending);
        assert_eq!(turn.on_prompt_err(), PromptErrOutcome::Finish { abort_wanted: true });
        assert!(!turn.is_abort_wanted());
        assert_eq!(turn.in_flight(), 0);
    }
}

#[cfg(all(test, feature = "loom"))]
mod loom_models {
    use loom::sync::Arc;
    use loom::sync::atomic::{AtomicUsize, Ordering};
    use loom::thread;

    use super::{AcpTurnMachine, CancelOutcome, PromptErrOutcome, PromptOkOutcome, UsageOutcome};

    fn check_bounded_3_threads(f: impl Fn() + Sync + Send + 'static) {
        let mut builder = loom::model::Builder::new();
        builder.preemption_bound = Some(2);
        builder.check(f);
    }

    #[test]
    fn prompt_ok_open_bg_races_abort_and_usage_update_emits_exactly_once() {
        check_bounded_3_threads(|| {
            let turn = Arc::new(AcpTurnMachine::new());
            let finished = Arc::new(AtomicUsize::new(0));
            assert!(turn.begin_prompt().is_first);

            let t_prompt = {
                let turn = Arc::clone(&turn);
                let finished = Arc::clone(&finished);
                thread::spawn(move || {
                    if let PromptOkOutcome::Finish { .. } = turn.on_prompt_ok(true) {
                        finished.fetch_add(1, Ordering::AcqRel);
                    }
                })
            };

            let t_abort = {
                let turn = Arc::clone(&turn);
                let finished = Arc::clone(&finished);
                thread::spawn(move || {
                    turn.request_abort();
                    if turn.on_cancel() == CancelOutcome::FinishAborted {
                        finished.fetch_add(1, Ordering::AcqRel);
                    }
                })
            };

            let t_usage = {
                let turn = Arc::clone(&turn);
                let finished = Arc::clone(&finished);
                thread::spawn(move || {
                    if let UsageOutcome::FinishDetached { .. } = turn.on_usage_update() {
                        finished.fetch_add(1, Ordering::AcqRel);
                    }
                })
            };

            t_prompt.join().unwrap();
            t_abort.join().unwrap();
            t_usage.join().unwrap();

            assert_eq!(finished.load(Ordering::Acquire), 1, "turn_finished must fire exactly once");
            assert_eq!(turn.in_flight(), 0);
            assert!(!turn.is_detached(), "detached turn must never get stuck after abort race");
            assert!(!turn.is_abort_wanted());
        });
    }

    #[test]
    fn steered_prompts_race_completion_error_and_abort_never_underflow() {
        check_bounded_3_threads(|| {
            let turn = Arc::new(AcpTurnMachine::new());
            let finished = Arc::new(AtomicUsize::new(0));
            assert!(turn.begin_prompt().is_first);
            assert!(!turn.begin_prompt().is_first);

            let t_first = {
                let turn = Arc::clone(&turn);
                let finished = Arc::clone(&finished);
                thread::spawn(move || {
                    if !turn.try_finish_steered_prompt()
                        && let PromptOkOutcome::Finish { .. } = turn.on_prompt_ok(true)
                    {
                        finished.fetch_add(1, Ordering::AcqRel);
                    }
                })
            };

            let t_second = {
                let turn = Arc::clone(&turn);
                let finished = Arc::clone(&finished);
                thread::spawn(move || {
                    if let PromptErrOutcome::Finish { .. } = turn.on_prompt_err() {
                        finished.fetch_add(1, Ordering::AcqRel);
                    }
                })
            };

            let t_abort = {
                let turn = Arc::clone(&turn);
                let finished = Arc::clone(&finished);
                thread::spawn(move || {
                    turn.request_abort();
                    if turn.on_cancel() == CancelOutcome::FinishAborted {
                        finished.fetch_add(1, Ordering::AcqRel);
                    }
                })
            };

            t_first.join().unwrap();
            t_second.join().unwrap();
            t_abort.join().unwrap();

            assert_eq!(finished.load(Ordering::Acquire), 1, "steered turn must emit turn_finished exactly once");
            assert_eq!(turn.in_flight(), 0, "in_flight must never underflow");
            assert!(!turn.is_detached());
            assert!(!turn.is_abort_wanted());
        });
    }

    #[test]
    fn prompt_err_races_abort_and_cancel_emits_exactly_once() {
        loom::model(|| {
            let turn = Arc::new(AcpTurnMachine::new());
            let finished = Arc::new(AtomicUsize::new(0));
            assert!(turn.begin_prompt().is_first);

            let t_err = {
                let turn = Arc::clone(&turn);
                let finished = Arc::clone(&finished);
                thread::spawn(move || {
                    if let PromptErrOutcome::Finish { .. } = turn.on_prompt_err() {
                        finished.fetch_add(1, Ordering::AcqRel);
                    }
                })
            };

            let t_abort = {
                let turn = Arc::clone(&turn);
                let finished = Arc::clone(&finished);
                thread::spawn(move || {
                    turn.request_abort();
                    if turn.on_cancel() == CancelOutcome::FinishAborted {
                        finished.fetch_add(1, Ordering::AcqRel);
                    }
                })
            };

            t_err.join().unwrap();
            t_abort.join().unwrap();

            assert_eq!(finished.load(Ordering::Acquire), 1);
            assert_eq!(turn.in_flight(), 0);
            assert!(!turn.is_detached());
            assert!(!turn.is_abort_wanted());
        });
    }

    #[test]
    fn replay_flag_never_corrupts_turn_completion_or_in_flight() {
        loom::model(|| {
            let turn = Arc::new(AcpTurnMachine::new());
            let finished = Arc::new(AtomicUsize::new(0));
            assert!(turn.begin_prompt().is_first);

            let t_replay = {
                let turn = Arc::clone(&turn);
                thread::spawn(move || {
                    let guard = turn.enter_replay();
                    assert!(turn.is_replaying());
                    drop(guard);
                })
            };

            let t_turn = {
                let turn = Arc::clone(&turn);
                let finished = Arc::clone(&finished);
                thread::spawn(move || {
                    match turn.on_prompt_ok(true) {
                        PromptOkOutcome::Finish { .. } => {
                            finished.fetch_add(1, Ordering::AcqRel);
                        }
                        PromptOkOutcome::Detached => {
                            if let UsageOutcome::FinishDetached { .. } = turn.on_usage_update() {
                                finished.fetch_add(1, Ordering::AcqRel);
                            }
                        }
                        PromptOkOutcome::StillInFlight => unreachable!(),
                    }
                    // Extra rollback / err on idle state must never underflow in_flight.
                    turn.rollback_prompt();
                    assert_eq!(turn.in_flight(), 0);
                })
            };

            t_replay.join().unwrap();
            t_turn.join().unwrap();

            assert_eq!(finished.load(Ordering::Acquire), 1);
            assert_eq!(turn.in_flight(), 0);
            assert!(!turn.is_replaying());
            assert!(!turn.is_detached());
            assert!(!turn.is_abort_wanted());
        });
    }
}
