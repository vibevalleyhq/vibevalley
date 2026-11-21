use crate::ast::Anchor;
use crate::compiler::{Op, Program, StartPrefilter};
use crate::options::{ExecError, ExecLimits, FindOption};
use crate::unicode::segment;
use crate::unicode::{chars_eq_icase, is_general_newline, is_word_char, match_icase_str, test_byte};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct CaptureIndex {
    pub start: usize,
    pub end: usize,
}

impl CaptureIndex {
    pub const fn new(start: usize, end: usize) -> Self {
        Self { start, end }
    }

    pub const fn len(&self) -> usize {
        self.end - self.start
    }

    pub const fn is_empty(&self) -> bool {
        self.start == self.end
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RegExpMatch {
    /// Capture slots `0..=group_count`. Slot `0` is always `Some` (full match).
    /// Unmatched optional capture groups are `None`.
    pub captures: Vec<Option<CaptureIndex>>,
}

impl RegExpMatch {
    pub fn full(&self) -> CaptureIndex {
        self.captures[0].expect("slot 0 always matched")
    }

    pub fn start(&self) -> usize {
        self.full().start
    }

    pub fn end(&self) -> usize {
        self.full().end
    }

    pub fn get(&self, index: usize) -> Option<CaptureIndex> {
        self.captures.get(index).copied().flatten()
    }

    pub fn capture_count(&self) -> usize {
        self.captures.len()
    }
}

#[derive(Debug, Clone)]
enum StackFrame {
    Choice {
        pc: u32,
        pos: usize,
    },
    StepBack {
        next_pos: usize,
        next_step: usize,
        max_chars: Option<usize>,
        body_pc: u32,
    },
    AbsentStep {
        next_pos: usize,
        min_pos: usize,
        resume_pc: u32,
    },
    AtomicMark,
    PosLookaroundMark {
        saved_pos: usize,
    },
    NegLookaroundMark,
    CondMark,
    RestoreCapOpenPush {
        slot: usize,
    },
    RestoreCapEnd {
        slot: usize,
        prev_start: Option<usize>,
        prev_end: Option<usize>,
        open_pos: usize,
        prev_write_ver: u64,
        prev_status_ver: u64,
    },
    RestoreKeep(usize),
    RestoreCounter {
        id: usize,
        prev: u32,
    },
    RestoreEmptyCheck {
        id: usize,
        prev: (usize, u64, u64),
    },
    RestoreRangeEnd(usize),
    UndoLbTargetPush,
    UndoLbTargetPop(usize),
    UndoCallPush {
        saved_counters: Vec<u32>,
    },
    UndoCallPop {
        return_pc: u32,
        caller_counters: Vec<u32>,
        callee_counters: Vec<u32>,
    },
    UndoLevelCap,
    UndoScopedRangePush,
    UndoScopedRangePop(usize),
}

pub fn search(
    program: &Program,
    haystack: &str,
    start_byte: usize,
    end_byte: usize,
    runtime_options: FindOption,
    limits: ExecLimits,
) -> Result<Option<RegExpMatch>, ExecError> {
    if start_byte > haystack.len() || end_byte > haystack.len() || start_byte > end_byte {
        return Err(ExecError::InvalidStartOffset);
    }
    if !haystack.is_char_boundary(start_byte) || !haystack.is_char_boundary(end_byte) {
        return Err(ExecError::InvalidStartOffset);
    }

    let effective_opts = program.whole_options | runtime_options;
    let find_longest = effective_opts.contains(FindOption::FIND_LONGEST);
    let mut vm = Vm::new(program, haystack, start_byte, end_byte, effective_opts, limits);
    let mut best_overall: Option<RegExpMatch> = None;

    let consider = |m: RegExpMatch, best: &mut Option<RegExpMatch>| -> bool {
        if !find_longest {
            *best = Some(m);
            return true;
        }
        let m_len = m.full().len();
        if best.as_ref().is_none_or(|b| m_len > b.full().len()) {
            *best = Some(m);
        }
        false
    };

    match &program.prefilter {
        StartPrefilter::AnchoredG => {
            if effective_opts.contains(FindOption::NOT_BEGIN_POSITION) {
                return Ok(None);
            }
            vm.match_at(start_byte, 0)
        }
        StartPrefilter::AnchoredStart => {
            if start_byte > 0 || effective_opts.contains(FindOption::NOT_BEGIN_STRING) || effective_opts.contains(FindOption::NOTBOL) {
                return Ok(None);
            }
            vm.match_at(0, 0)
        }
        StartPrefilter::Literal(needle) => {
            let mut pos = start_byte;
            let hay_bytes = haystack.as_bytes();
            while pos + needle.len() <= end_byte {
                let Some(rel) = find_subslice(&hay_bytes[pos..end_byte], needle) else {
                    break;
                };
                let cand = pos + rel;
                if haystack.is_char_boundary(cand)
                    && let Some(m) = vm.match_at(cand, 0)?
                    && consider(m, &mut best_overall)
                {
                    return Ok(best_overall);
                }
                pos = cand + 1;
            }
            Ok(best_overall)
        }
        StartPrefilter::FirstByteMask(mask) => {
            let bytes = haystack.as_bytes();
            let mut pos = start_byte;
            while pos < end_byte {
                let b = bytes[pos];
                if test_byte(mask, b)
                    && let Some(m) = vm.match_at(pos, 0)?
                    && consider(m, &mut best_overall)
                {
                    return Ok(best_overall);
                }
                pos += utf8_char_len(b);
            }
            Ok(best_overall)
        }
        StartPrefilter::Any => {
            let bytes = haystack.as_bytes();
            let mut pos = start_byte;
            loop {
                if let Some(m) = vm.match_at(pos, 0)?
                    && consider(m, &mut best_overall)
                {
                    return Ok(best_overall);
                }
                if pos >= end_byte {
                    break;
                }
                pos += utf8_char_len(bytes[pos]);
            }
            Ok(best_overall)
        }
    }
}

struct Vm<'a> {
    program: &'a Program,
    haystack: &'a str,
    bytes: &'a [u8],
    search_start: usize,
    full_end: usize,
    range_end: usize,
    options: FindOption,
    limits: ExecLimits,
    steps: usize,
    pc: u32,
    pos: usize,
    keep_start: usize,
    cap_starts: Vec<Option<usize>>,
    cap_ends: Vec<Option<usize>>,
    cap_open_stacks: Vec<Vec<usize>>,
    cap_write_ver: u64,
    cap_status_ver: u64,
    counters: Vec<u32>,
    empty_checks: Vec<(usize, u64, u64)>,
    call_stack: Vec<(u32, Vec<u32>)>,
    lb_targets: Vec<usize>,
    scoped_ranges: Vec<usize>,
    level_caps: Vec<(usize, usize, usize, usize)>,
    stack: Vec<StackFrame>,
    scratch: Vec<StackFrame>,
}

impl<'a> Vm<'a> {
    fn new(program: &'a Program, haystack: &'a str, search_start: usize, full_end: usize, options: FindOption, limits: ExecLimits) -> Self {
        let slots = program.num_captures + 1;
        Self {
            program,
            haystack,
            bytes: haystack.as_bytes(),
            search_start,
            full_end,
            range_end: full_end,
            options,
            limits,
            steps: 0,
            pc: 0,
            pos: search_start,
            keep_start: search_start,
            cap_starts: vec![None; slots],
            cap_ends: vec![None; slots],
            cap_open_stacks: vec![Vec::new(); slots],
            cap_write_ver: 0,
            cap_status_ver: 0,
            counters: vec![0; program.num_counters],
            empty_checks: vec![(usize::MAX, 0, 0); program.num_empty_checks],
            call_stack: Vec::new(),
            lb_targets: Vec::new(),
            scoped_ranges: Vec::new(),
            level_caps: Vec::new(),
            stack: Vec::with_capacity(64),
            scratch: Vec::new(),
        }
    }

    fn reset_for_attempt(&mut self, attempt_pos: usize, entry_pc: u32) {
        self.pc = entry_pc;
        self.pos = attempt_pos;
        self.keep_start = attempt_pos;
        self.range_end = self.full_end;
        self.cap_starts.fill(None);
        self.cap_ends.fill(None);
        for s in &mut self.cap_open_stacks {
            s.clear();
        }
        self.cap_write_ver = 0;
        self.cap_status_ver = 0;
        self.counters.fill(0);
        self.empty_checks.fill((usize::MAX, 0, 0));
        self.call_stack.clear();
        self.lb_targets.clear();
        self.scoped_ranges.clear();
        self.level_caps.clear();
        self.stack.clear();
    }

    #[inline]
    fn push_frame(&mut self, frame: StackFrame) -> Result<(), ExecError> {
        if self.stack.len() >= self.limits.max_backtrack_stack {
            return Err(ExecError::StackLimitExceeded);
        }
        self.stack.push(frame);
        Ok(())
    }

    fn match_at(&mut self, attempt_pos: usize, entry_pc: u32) -> Result<Option<RegExpMatch>, ExecError> {
        self.reset_for_attempt(attempt_pos, entry_pc);
        self.run_from_current_state()
    }

    fn run_from_current_state(&mut self) -> Result<Option<RegExpMatch>, ExecError> {
        let find_longest = self.options.contains(FindOption::FIND_LONGEST);
        let find_not_empty = self.options.contains(FindOption::FIND_NOT_EMPTY);
        let mut best_match: Option<RegExpMatch> = None;
        let mut best_len: usize = 0;

        loop {
            self.steps += 1;
            if self.steps > self.limits.max_steps {
                return Err(ExecError::StepLimitExceeded);
            }

            let op = &self.program.ops[self.pc as usize];
            match op {
                Op::Match => {
                    let m_start = self.keep_start;
                    let m_end = self.pos;
                    if find_not_empty && m_start == m_end {
                        if !self.backtrack() {
                            return Ok(best_match);
                        }
                        continue;
                    }
                    let m = self.build_match(m_start, m_end);
                    if !find_longest {
                        return Ok(Some(m));
                    }
                    let m_len = m_end.saturating_sub(m_start);
                    if best_match.is_none() || m_len > best_len {
                        best_len = m_len;
                        best_match = Some(m);
                    }
                    if !self.backtrack() {
                        return Ok(best_match);
                    }
                }
                Op::Fail => {
                    if !self.backtrack() {
                        return Ok(best_match);
                    }
                }
                &Op::Byte(b) => {
                    if self.pos < self.range_end && self.bytes[self.pos] == b {
                        self.pos += 1;
                        self.pc += 1;
                    } else if !self.backtrack() {
                        return Ok(best_match);
                    }
                }
                &Op::Char(ch) => {
                    if let Some((next_ch, len)) = self.peek_char()
                        && next_ch == ch
                    {
                        self.pos += len;
                        self.pc += 1;
                    } else if !self.backtrack() {
                        return Ok(best_match);
                    }
                }
                &Op::CharICase { ch, ascii_only } => {
                    if let Some((next_ch, len)) = self.peek_char()
                        && chars_eq_icase(ch, next_ch, ascii_only)
                    {
                        self.pos += len;
                        self.pc += 1;
                    } else if !self.backtrack() {
                        return Ok(best_match);
                    }
                }
                &Op::Bytes { offset, len } => {
                    let start = offset as usize;
                    let n = len as usize;
                    let lit = &self.program.literals[start..start + n];
                    if self.pos + n <= self.range_end && &self.bytes[self.pos..self.pos + n] == lit {
                        self.pos += n;
                        self.pc += 1;
                    } else if !self.backtrack() {
                        return Ok(best_match);
                    }
                }
                &Op::StrICase { offset, len, ascii_only } => {
                    let start = offset as usize;
                    let n = len as usize;
                    let pat = std::str::from_utf8(&self.program.literals[start..start + n]).expect("valid UTF-8 literal");
                    if let Some(new_pos) = match_icase_str(&self.haystack[..self.range_end], self.pos, pat, ascii_only) {
                        self.pos = new_pos;
                        self.pc += 1;
                    } else if !self.backtrack() {
                        return Ok(best_match);
                    }
                }
                &Op::AnyChar { dot_all } => {
                    if let Some((ch, len)) = self.peek_char()
                        && (dot_all || ch != '\n')
                    {
                        self.pos += len;
                        self.pc += 1;
                    } else if !self.backtrack() {
                        return Ok(best_match);
                    }
                }
                Op::GeneralNewline => {
                    if self.pos + 1 < self.range_end && self.bytes[self.pos] == b'\r' && self.bytes[self.pos + 1] == b'\n' {
                        self.pos += 2;
                        self.pc += 1;
                    } else if let Some((ch, len)) = self.peek_char()
                        && is_general_newline(ch)
                    {
                        self.pos += len;
                        self.pc += 1;
                    } else if !self.backtrack() {
                        return Ok(best_match);
                    }
                }
                &Op::TextSegment(mode) => {
                    if let Some(next_pos) = segment::next_segment_end(&self.haystack[..self.range_end], self.pos, mode) {
                        self.pos = next_pos;
                        self.pc += 1;
                    } else if !self.backtrack() {
                        return Ok(best_match);
                    }
                }
                &Op::CharClass(idx) => {
                    if let Some((ch, len)) = self.peek_char()
                        && self.program.charsets[idx as usize].contains(ch)
                    {
                        self.pos += len;
                        self.pc += 1;
                    } else if !self.backtrack() {
                        return Ok(best_match);
                    }
                }
                &Op::Anchor(anchor) => {
                    if self.check_anchor(anchor) {
                        self.pc += 1;
                    } else if !self.backtrack() {
                        return Ok(best_match);
                    }
                }
                Op::Keep => {
                    let prev = self.keep_start;
                    self.push_frame(StackFrame::RestoreKeep(prev))?;
                    self.keep_start = self.pos;
                    self.pc += 1;
                }
                &Op::Jump(target) => {
                    self.pc = target;
                }
                &Op::Split { primary, fallback } => {
                    let pos = self.pos;
                    self.push_frame(StackFrame::Choice { pc: fallback, pos })?;
                    self.pc = primary;
                }
                Op::SaveMark => {
                    self.push_frame(StackFrame::AtomicMark)?;
                    self.pc += 1;
                }
                Op::CutToMark => {
                    self.cut_choices_to_mark(|f| matches!(f, StackFrame::AtomicMark));
                    self.pc += 1;
                }
                Op::SavePosLookaround => {
                    let saved_pos = self.pos;
                    self.push_frame(StackFrame::PosLookaroundMark { saved_pos })?;
                    self.pc += 1;
                }
                Op::PosLookaroundEnd => {
                    let saved_pos = self.cut_choices_to_pos_lookaround();
                    self.pos = saved_pos;
                    self.pc += 1;
                }
                Op::SaveNegLookaround => {
                    self.push_frame(StackFrame::NegLookaroundMark)?;
                    self.pc += 1;
                }
                Op::NegLookaroundMatchFail => {
                    self.unwind_neg_lookaround();
                    if !self.backtrack() {
                        return Ok(best_match);
                    }
                }
                Op::SaveCondMark => {
                    self.push_frame(StackFrame::CondMark)?;
                    self.pc += 1;
                }
                Op::CutCondFallback => {
                    self.cut_cond_fallback();
                    self.pc += 1;
                }
                &Op::StepBackStart { min_chars, max_chars } => {
                    let orig_pos = self.pos;
                    if let Some(start_pos) = step_back_chars(self.haystack, orig_pos, min_chars) {
                        self.lb_targets.push(orig_pos);
                        self.push_frame(StackFrame::UndoLbTargetPush)?;
                        let body_pc = self.pc + 1;
                        if max_chars.is_none_or(|m| min_chars < m) && start_pos > 0 {
                            let next_pos = prev_char_pos(self.haystack, start_pos);
                            self.push_frame(StackFrame::StepBack {
                                next_pos,
                                next_step: min_chars + 1,
                                max_chars,
                                body_pc,
                            })?;
                        }
                        self.pos = start_pos;
                        self.pc = body_pc;
                    } else if !self.backtrack() {
                        return Ok(best_match);
                    }
                }
                Op::CheckLbEnd => {
                    if self.lb_targets.last().copied() == Some(self.pos) {
                        self.pc += 1;
                    } else if !self.backtrack() {
                        return Ok(best_match);
                    }
                }
                Op::PosLookbehindEnd => {
                    let target_end = self.lb_targets.pop().expect("balanced lb_targets");
                    let saved_pos = self.cut_choices_to_pos_lookaround();
                    self.push_frame(StackFrame::UndoLbTargetPop(target_end))?;
                    self.pos = saved_pos;
                    self.pc += 1;
                }
                &Op::CaptureStart(slot) => {
                    let slot = slot as usize;
                    self.cap_open_stacks[slot].push(self.pos);
                    self.push_frame(StackFrame::RestoreCapOpenPush { slot })?;
                    self.pc += 1;
                }
                &Op::CaptureEnd(slot) => {
                    let slot = slot as usize;
                    let open_pos = self.cap_open_stacks[slot].pop().expect("balanced cap_open_stacks");
                    let prev_start = self.cap_starts[slot];
                    let prev_end = self.cap_ends[slot];
                    let prev_write_ver = self.cap_write_ver;
                    let prev_status_ver = self.cap_status_ver;
                    self.push_frame(StackFrame::RestoreCapEnd {
                        slot,
                        prev_start,
                        prev_end,
                        open_pos,
                        prev_write_ver,
                        prev_status_ver,
                    })?;
                    self.cap_write_ver += 1;
                    if prev_end.is_none() {
                        self.cap_status_ver += 1;
                    }
                    self.cap_starts[slot] = Some(open_pos);
                    self.cap_ends[slot] = Some(self.pos);
                    if self.program.uses_level_backref {
                        self.level_caps.push((slot, self.call_stack.len(), open_pos, self.pos));
                        self.push_frame(StackFrame::UndoLevelCap)?;
                    }
                    self.pc += 1;
                }
                &Op::CounterInit(id) => {
                    let id = id as usize;
                    let prev = self.counters[id];
                    self.push_frame(StackFrame::RestoreCounter { id, prev })?;
                    self.counters[id] = 0;
                    self.pc += 1;
                }
                &Op::CounterCheckMin { counter, min, body_pc } => {
                    if self.counters[counter as usize] < min {
                        self.pc = body_pc;
                    } else {
                        self.pc += 1;
                    }
                }
                &Op::CounterCheckMax { counter, max, done_pc } => {
                    if self.counters[counter as usize] >= max {
                        self.pc = done_pc;
                    } else {
                        self.pc += 1;
                    }
                }
                &Op::CounterInc(id) => {
                    let id = id as usize;
                    let prev = self.counters[id];
                    self.push_frame(StackFrame::RestoreCounter { id, prev })?;
                    self.counters[id] = prev + 1;
                    self.pc += 1;
                }
                &Op::EmptyCheckStart(id) => {
                    let id = id as usize;
                    let prev = self.empty_checks[id];
                    self.push_frame(StackFrame::RestoreEmptyCheck { id, prev })?;
                    self.empty_checks[id] = (self.pos, self.cap_write_ver, self.cap_status_ver);
                    self.pc += 1;
                }
                &Op::EmptyCheckEnd {
                    check_id,
                    check_captures,
                    after_pc,
                } => {
                    let (prev_pos, prev_write_ver, prev_status_ver) = self.empty_checks[check_id as usize];
                    if self.pos == prev_pos {
                        if !check_captures {
                            // Empty iteration with no captures: stop repeating and continue after loop.
                            self.pc = after_pc;
                        } else if self.cap_status_ver != prev_status_ver {
                            // A capture group transitioned None -> Some: allowed to continue repeating.
                            self.pc += 1;
                        } else if self.cap_write_ver != prev_write_ver {
                            // Capture was redundantly overwritten with no status change: fail & unwind.
                            if !self.backtrack() {
                                return Ok(best_match);
                            }
                        } else {
                            // No capture touched in empty iteration: stop repeating.
                            self.pc = after_pc;
                        }
                    } else {
                        self.pc += 1;
                    }
                }
                &Op::Backref {
                    group_list_idx,
                    level,
                    ignore_case,
                    ascii_icase,
                } => {
                    if let Some((cap_start, cap_end)) = self.resolve_backref_span(group_list_idx as usize, level) {
                        let captured = &self.haystack[cap_start..cap_end];
                        if !ignore_case {
                            let n = captured.len();
                            if self.pos + n <= self.range_end && &self.bytes[self.pos..self.pos + n] == captured.as_bytes() {
                                self.pos += n;
                                self.pc += 1;
                            } else if !self.backtrack() {
                                return Ok(best_match);
                            }
                        } else if let Some(new_pos) = match_icase_str(&self.haystack[..self.range_end], self.pos, captured, ascii_icase) {
                            self.pos = new_pos;
                            self.pc += 1;
                        } else if !self.backtrack() {
                            return Ok(best_match);
                        }
                    } else if !self.backtrack() {
                        return Ok(best_match);
                    }
                }
                &Op::JumpIfBackrefInvalid {
                    group_list_idx,
                    level,
                    else_pc,
                } => {
                    if self.resolve_backref_span(group_list_idx as usize, level).is_some() {
                        self.pc += 1;
                    } else {
                        self.pc = else_pc;
                    }
                }
                &Op::Call { target_pc } => {
                    if self.call_stack.len() >= self.limits.max_call_depth {
                        return Err(ExecError::CallDepthExceeded);
                    }
                    let saved_counters = if self.counters.is_empty() { Vec::new() } else { self.counters.clone() };
                    self.call_stack.push((self.pc + 1, saved_counters.clone()));
                    self.push_frame(StackFrame::UndoCallPush { saved_counters })?;
                    self.pc = target_pc;
                }
                Op::Return => {
                    let (return_pc, caller_counters) = self.call_stack.pop().expect("balanced call_stack");
                    let callee_counters = if self.counters.is_empty() {
                        Vec::new()
                    } else {
                        std::mem::replace(&mut self.counters, caller_counters.clone())
                    };
                    self.push_frame(StackFrame::UndoCallPop {
                        return_pc,
                        caller_counters,
                        callee_counters,
                    })?;
                    self.pc = return_pc;
                }
                &Op::AbsentRepeater { absent_pc } => {
                    let orig_pos = self.pos;
                    let limit = self.find_absent_limit(absent_pc, orig_pos, self.range_end)?;
                    let resume_pc = self.pc + 1;
                    if limit > orig_pos {
                        let next_pos = prev_char_pos(self.haystack, limit);
                        self.push_frame(StackFrame::AbsentStep {
                            next_pos,
                            min_pos: orig_pos,
                            resume_pc,
                        })?;
                    }
                    self.pos = limit;
                    self.pc = resume_pc;
                }
                &Op::AbsentSetLimit { absent_pc, scoped } => {
                    let orig_pos = self.pos;
                    let limit = self.find_absent_limit(absent_pc, orig_pos, self.range_end)?;
                    let prev_end = self.range_end;
                    self.push_frame(StackFrame::RestoreRangeEnd(prev_end))?;
                    if scoped {
                        self.scoped_ranges.push(prev_end);
                        self.push_frame(StackFrame::UndoScopedRangePush)?;
                    }
                    self.range_end = limit;
                    self.pc += 1;
                }
                Op::AbsentRestoreLimit => {
                    let saved = self.scoped_ranges.pop().expect("balanced scoped_ranges");
                    let cur = self.range_end;
                    self.push_frame(StackFrame::UndoScopedRangePop(saved))?;
                    self.push_frame(StackFrame::RestoreRangeEnd(cur))?;
                    self.range_end = saved;
                    self.pc += 1;
                }
                Op::RangeClear => {
                    let prev = self.range_end;
                    self.push_frame(StackFrame::RestoreRangeEnd(prev))?;
                    self.range_end = self.full_end;
                    self.pc += 1;
                }
            }
        }
    }

    fn find_absent_limit(&mut self, absent_pc: u32, from: usize, end: usize) -> Result<usize, ExecError> {
        let remaining_steps = self.limits.max_steps.saturating_sub(self.steps);
        let sub_limits = ExecLimits {
            max_steps: remaining_steps,
            max_backtrack_stack: self.limits.max_backtrack_stack,
            max_call_depth: self.limits.max_call_depth,
        };
        let mut sub_vm = Vm::new(
            self.program,
            self.haystack,
            from,
            end,
            self.options.difference(FindOption::FIND_LONGEST),
            sub_limits,
        );
        let mut p = from;
        loop {
            sub_vm.reset_for_attempt(p, absent_pc);
            sub_vm.cap_starts.copy_from_slice(&self.cap_starts);
            sub_vm.cap_ends.copy_from_slice(&self.cap_ends);
            let matched = sub_vm.run_from_current_state()?;
            self.steps += sub_vm.steps;
            sub_vm.steps = 0;
            if matched.is_some() {
                return Ok(p);
            }
            if p >= end {
                return Ok(end);
            }
            p += utf8_char_len(self.bytes[p]);
        }
    }

    fn resolve_backref_span(&self, group_list_idx: usize, level: Option<i32>) -> Option<(usize, usize)> {
        let groups = &self.program.backref_groups[group_list_idx];
        if let Some(lv) = level {
            let target_depth = (self.call_stack.len() as isize) + (lv as isize);
            if target_depth < 0 {
                return None;
            }
            let target_depth = target_depth as usize;
            for &(slot, depth, s, e) in self.level_caps.iter().rev() {
                if depth == target_depth && groups.contains(&slot) {
                    return Some((s, e));
                }
            }
            return None;
        }
        for &g in groups {
            if let (Some(s), Some(e)) = (self.cap_starts[g], self.cap_ends[g]) {
                return Some((s, e));
            }
        }
        None
    }

    fn build_match(&self, start: usize, end: usize) -> RegExpMatch {
        let mut captures = Vec::with_capacity(self.cap_starts.len());
        captures.push(Some(CaptureIndex::new(start, end)));
        for i in 1..self.cap_starts.len() {
            match (self.cap_starts[i], self.cap_ends[i]) {
                (Some(s), Some(e)) if s <= e => captures.push(Some(CaptureIndex::new(s, e))),
                _ => captures.push(None),
            }
        }
        RegExpMatch { captures }
    }

    #[inline]
    fn peek_char(&self) -> Option<(char, usize)> {
        if self.pos >= self.range_end {
            return None;
        }
        let ch = self.haystack[self.pos..self.range_end].chars().next()?;
        Some((ch, ch.len_utf8()))
    }

    fn check_anchor(&self, anchor: Anchor) -> bool {
        match anchor {
            Anchor::BeginBuf => self.pos == 0 && !self.options.contains(FindOption::NOTBOL) && !self.options.contains(FindOption::NOT_BEGIN_STRING),
            Anchor::EndBuf => self.pos == self.range_end && !self.options.contains(FindOption::NOTEOL) && !self.options.contains(FindOption::NOT_END_STRING),
            Anchor::BeginPosition => self.pos == self.search_start && !self.options.contains(FindOption::NOT_BEGIN_POSITION),
            Anchor::BeginLine => {
                if self.pos == 0 {
                    !self.options.contains(FindOption::NOTBOL)
                } else if self.pos < self.range_end {
                    self.bytes[self.pos - 1] == b'\n'
                } else {
                    false
                }
            }
            Anchor::EndLine => {
                if self.pos == self.range_end {
                    !self.options.contains(FindOption::NOTEOL)
                } else {
                    self.bytes[self.pos] == b'\n'
                }
            }
            Anchor::SemiEndBuf => {
                if self.options.contains(FindOption::NOTEOL) || self.options.contains(FindOption::NOT_END_STRING) {
                    return false;
                }
                if self.pos == self.range_end {
                    true
                } else {
                    self.bytes[self.pos] == b'\n' && self.pos + 1 == self.range_end
                }
            }
            Anchor::WordBoundary { ascii_only } => self.is_word_boundary(ascii_only),
            Anchor::NotWordBoundary { ascii_only } => !self.is_word_boundary(ascii_only),
            Anchor::TextSegmentBoundary { mode, negated } => segment::is_break_position(&self.haystack[..self.range_end], self.pos, mode) ^ negated,
        }
    }

    fn is_word_boundary(&self, ascii_only: bool) -> bool {
        let left_word = if self.pos > 0 {
            self.haystack[..self.pos].chars().next_back().is_some_and(|c| is_word_char(c, ascii_only))
        } else {
            false
        };
        let right_word = if self.pos < self.range_end {
            self.haystack[self.pos..self.range_end]
                .chars()
                .next()
                .is_some_and(|c| is_word_char(c, ascii_only))
        } else {
            false
        };
        left_word != right_word
    }

    fn apply_undo(&mut self, frame: StackFrame) {
        match frame {
            StackFrame::RestoreCapOpenPush { slot } => {
                self.cap_open_stacks[slot].pop();
            }
            StackFrame::RestoreCapEnd {
                slot,
                prev_start,
                prev_end,
                open_pos,
                prev_write_ver,
                prev_status_ver,
            } => {
                self.cap_starts[slot] = prev_start;
                self.cap_ends[slot] = prev_end;
                self.cap_open_stacks[slot].push(open_pos);
                self.cap_write_ver = prev_write_ver;
                self.cap_status_ver = prev_status_ver;
            }
            StackFrame::RestoreKeep(prev) => {
                self.keep_start = prev;
            }
            StackFrame::RestoreCounter { id, prev } => {
                self.counters[id] = prev;
            }
            StackFrame::RestoreEmptyCheck { id, prev } => {
                self.empty_checks[id] = prev;
            }
            StackFrame::RestoreRangeEnd(prev) => {
                self.range_end = prev;
            }
            StackFrame::UndoLbTargetPush => {
                self.lb_targets.pop();
            }
            StackFrame::UndoLbTargetPop(val) => {
                self.lb_targets.push(val);
            }
            StackFrame::UndoCallPush { saved_counters } => {
                self.call_stack.pop();
                if !saved_counters.is_empty() {
                    self.counters = saved_counters;
                }
            }
            StackFrame::UndoCallPop {
                return_pc,
                caller_counters,
                callee_counters,
            } => {
                self.call_stack.push((return_pc, caller_counters));
                if !callee_counters.is_empty() {
                    self.counters = callee_counters;
                }
            }
            StackFrame::UndoLevelCap => {
                self.level_caps.pop();
            }
            StackFrame::UndoScopedRangePush => {
                self.scoped_ranges.pop();
            }
            StackFrame::UndoScopedRangePop(val) => {
                self.scoped_ranges.push(val);
            }
            StackFrame::Choice { .. }
            | StackFrame::StepBack { .. }
            | StackFrame::AbsentStep { .. }
            | StackFrame::AtomicMark
            | StackFrame::PosLookaroundMark { .. }
            | StackFrame::NegLookaroundMark
            | StackFrame::CondMark => {}
        }
    }

    fn backtrack(&mut self) -> bool {
        while let Some(frame) = self.stack.pop() {
            match frame {
                StackFrame::Choice { pc, pos } => {
                    self.pc = pc;
                    self.pos = pos;
                    return true;
                }
                StackFrame::StepBack {
                    next_pos,
                    next_step,
                    max_chars,
                    body_pc,
                } => {
                    if max_chars.is_none_or(|m| next_step < m) && next_pos > 0 {
                        let further = prev_char_pos(self.haystack, next_pos);
                        if self.stack.len() < self.limits.max_backtrack_stack {
                            self.stack.push(StackFrame::StepBack {
                                next_pos: further,
                                next_step: next_step + 1,
                                max_chars,
                                body_pc,
                            });
                        }
                    }
                    self.pc = body_pc;
                    self.pos = next_pos;
                    return true;
                }
                StackFrame::AbsentStep { next_pos, min_pos, resume_pc } => {
                    if next_pos > min_pos {
                        let further = prev_char_pos(self.haystack, next_pos);
                        if self.stack.len() < self.limits.max_backtrack_stack {
                            self.stack.push(StackFrame::AbsentStep {
                                next_pos: further,
                                min_pos,
                                resume_pc,
                            });
                        }
                    }
                    self.pc = resume_pc;
                    self.pos = next_pos;
                    return true;
                }
                StackFrame::AtomicMark | StackFrame::PosLookaroundMark { .. } | StackFrame::NegLookaroundMark | StackFrame::CondMark => {}
                undo => self.apply_undo(undo),
            }
        }
        false
    }

    /// Removes choice frames above the matching mark while preserving all undo frames.
    fn cut_choices_to_mark<F: Fn(&StackFrame) -> bool>(&mut self, is_mark: F) {
        self.scratch.clear();
        while let Some(frame) = self.stack.pop() {
            if is_mark(&frame) {
                break;
            }
            if !is_choice_frame(&frame) {
                self.scratch.push(frame);
            }
        }
        while let Some(undo) = self.scratch.pop() {
            self.stack.push(undo);
        }
    }

    fn cut_choices_to_pos_lookaround(&mut self) -> usize {
        self.scratch.clear();
        let mut saved_pos = self.pos;
        while let Some(frame) = self.stack.pop() {
            if let StackFrame::PosLookaroundMark { saved_pos: sp } = frame {
                saved_pos = sp;
                break;
            }
            if !is_choice_frame(&frame) {
                self.scratch.push(frame);
            }
        }
        while let Some(undo) = self.scratch.pop() {
            self.stack.push(undo);
        }
        saved_pos
    }

    fn unwind_neg_lookaround(&mut self) {
        while let Some(frame) = self.stack.pop() {
            if matches!(frame, StackFrame::NegLookaroundMark) {
                break;
            }
            self.apply_undo(frame);
        }
        // Discard the Split's fallback Choice immediately beneath NegLookaroundMark.
        if let Some(frame) = self.stack.pop() {
            debug_assert!(matches!(frame, StackFrame::Choice { .. }));
        }
    }

    fn cut_cond_fallback(&mut self) {
        self.scratch.clear();
        while let Some(frame) = self.stack.pop() {
            if matches!(frame, StackFrame::CondMark) {
                break;
            }
            self.scratch.push(frame);
        }
        // Remove the single `else` fallback Choice immediately beneath CondMark.
        if let Some(frame) = self.stack.pop() {
            debug_assert!(matches!(frame, StackFrame::Choice { .. }));
        }
        while let Some(saved) = self.scratch.pop() {
            self.stack.push(saved);
        }
    }
}

#[inline]
fn is_choice_frame(frame: &StackFrame) -> bool {
    matches!(frame, StackFrame::Choice { .. } | StackFrame::StepBack { .. } | StackFrame::AbsentStep { .. })
}

#[inline]
fn utf8_char_len(first_byte: u8) -> usize {
    if first_byte < 0x80 {
        1
    } else if first_byte < 0xE0 {
        2
    } else if first_byte < 0xF0 {
        3
    } else {
        4
    }
}

#[inline]
fn prev_char_pos(s: &str, pos: usize) -> usize {
    let bytes = s.as_bytes();
    let mut p = pos - 1;
    while p > 0 && (bytes[p] & 0xC0) == 0x80 {
        p -= 1;
    }
    p
}

fn step_back_chars(s: &str, mut pos: usize, count: usize) -> Option<usize> {
    for _ in 0..count {
        if pos == 0 {
            return None;
        }
        pos = prev_char_pos(s, pos);
    }
    Some(pos)
}

fn find_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() {
        return Some(0);
    }
    if needle.len() == 1 {
        let b = needle[0];
        return haystack.iter().position(|&x| x == b);
    }
    let first = needle[0];
    let limit = haystack.len().checked_sub(needle.len())?;
    let mut i = 0;
    while i <= limit {
        let rel = haystack[i..=limit].iter().position(|&x| x == first)?;
        let pos = i + rel;
        if &haystack[pos..pos + needle.len()] == needle {
            return Some(pos);
        }
        i = pos + 1;
    }
    None
}
