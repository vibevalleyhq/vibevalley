use crate::ast::{Anchor, BackrefTarget, ConditionKind, Expr, LookaroundKind, ParsedPattern, QuantifierMode};
use crate::options::FindOption;
use crate::unicode::segment::SegmentMode;
use crate::unicode::{CharSet, fold_multi_expansion, fold1_equivalents, set_byte};

#[derive(Debug, Clone)]
pub enum StartPrefilter {
    /// Pattern starts with `\G`: only try matching at `start_byte`.
    AnchoredG,
    /// Pattern starts with `\A`: only try matching at byte 0.
    AnchoredStart,
    /// Pattern starts with a fixed non-empty literal byte slice.
    Literal(Vec<u8>),
    /// 256-bit mask of bytes that can begin a match.
    FirstByteMask([u64; 4]),
    /// No prefilter; scan every UTF-8 char boundary.
    Any,
}

#[derive(Debug, Clone)]
pub enum Op {
    Match,
    Fail,
    Byte(u8),
    Char(char),
    CharICase {
        ch: char,
        ascii_only: bool,
    },
    Bytes {
        offset: u32,
        len: u32,
    },
    StrICase {
        offset: u32,
        len: u32,
        ascii_only: bool,
    },
    AnyChar {
        dot_all: bool,
    },
    GeneralNewline,
    TextSegment(SegmentMode),
    CharClass(u32),
    Anchor(Anchor),
    Keep,
    Jump(u32),
    Split {
        primary: u32,
        fallback: u32,
    },
    SaveMark,
    CutToMark,
    SavePosLookaround,
    PosLookaroundEnd,
    SaveNegLookaround,
    NegLookaroundMatchFail,
    SaveCondMark,
    CutCondFallback,
    StepBackStart {
        min_chars: usize,
        max_chars: Option<usize>,
    },
    CheckLbEnd,
    PosLookbehindEnd,
    CaptureStart(u32),
    CaptureEnd(u32),
    CounterInit(u32),
    CounterCheckMax {
        counter: u32,
        max: u32,
        done_pc: u32,
    },
    CounterCheckMin {
        counter: u32,
        min: u32,
        body_pc: u32,
    },
    CounterInc(u32),
    EmptyCheckStart(u32),
    EmptyCheckEnd {
        check_id: u32,
        check_captures: bool,
        after_pc: u32,
    },
    Backref {
        group_list_idx: u32,
        level: Option<i32>,
        ignore_case: bool,
        ascii_icase: bool,
    },
    JumpIfBackrefInvalid {
        group_list_idx: u32,
        level: Option<i32>,
        else_pc: u32,
    },
    Call {
        target_pc: u32,
    },
    Return,
    AbsentRepeater {
        absent_pc: u32,
    },
    AbsentSetLimit {
        absent_pc: u32,
        /// When true, saves previous `range_end` for an upcoming `AbsentRestoreLimit`.
        scoped: bool,
    },
    AbsentRestoreLimit,
    RangeClear,
}

#[derive(Debug, Clone)]
pub struct Program {
    pub ops: Vec<Op>,
    pub literals: Vec<u8>,
    pub charsets: Vec<CharSet>,
    pub backref_groups: Vec<Vec<usize>>,
    pub num_captures: usize,
    pub num_counters: usize,
    pub num_empty_checks: usize,
    pub uses_level_backref: bool,
    pub named_groups: Vec<(String, Vec<usize>)>,
    pub has_g_anchor: bool,
    pub whole_options: FindOption,
    pub prefilter: StartPrefilter,
}

pub fn compile(parsed: &ParsedPattern) -> Program {
    let mut group_bodies: Vec<Option<&Expr>> = vec![None; parsed.num_captures + 1];
    group_bodies[0] = Some(&parsed.expr);
    collect_group_bodies(&parsed.expr, &mut group_bodies);

    let mut called_groups = vec![false; parsed.num_captures + 1];
    collect_called_groups(&parsed.expr, &mut called_groups);

    let mut uses_level_backref = false;
    detect_level_backref(&parsed.expr, &mut uses_level_backref);

    let prefilter = compute_prefilter(&parsed.expr, &group_bodies);

    let mut comp = Compiler {
        ops: Vec::new(),
        literals: Vec::new(),
        charsets: Vec::new(),
        backref_groups: Vec::new(),
        num_counters: 0,
        num_empty_checks: 0,
        call_patches: Vec::new(),
        absent_queue: Vec::new(),
        group_bodies: &group_bodies,
        called_groups: &called_groups,
        in_subroutine_group: None,
    };

    comp.emit_expr(&parsed.expr);
    comp.ops.push(Op::Match);

    // Compile subroutine entry points for any group referenced by `\g<...>`.
    let mut sub_pcs = vec![0u32; parsed.num_captures + 1];
    for g in 0..=parsed.num_captures {
        if !called_groups[g] {
            continue;
        }
        let pc = comp.ops.len() as u32;
        sub_pcs[g] = pc;
        if let Some(body) = group_bodies[g] {
            if g == 0 {
                comp.in_subroutine_group = None;
                comp.emit_expr(body);
            } else {
                comp.in_subroutine_group = Some(g);
                comp.ops.push(Op::CaptureStart(g as u32));
                comp.emit_expr(body);
                comp.ops.push(Op::CaptureEnd(g as u32));
                comp.in_subroutine_group = None;
            }
        }
        comp.ops.push(Op::Return);
    }

    // Compile queued absent sub-expressions (may recursively enqueue more).
    let mut q_idx = 0;
    while q_idx < comp.absent_queue.len() {
        let (patch_idx, absent_expr) = comp.absent_queue[q_idx].clone();
        q_idx += 1;
        let absent_pc = comp.ops.len() as u32;
        comp.emit_expr(&absent_expr);
        comp.ops.push(Op::Match);
        match &mut comp.ops[patch_idx] {
            Op::AbsentRepeater { absent_pc: dst } | Op::AbsentSetLimit { absent_pc: dst, .. } => *dst = absent_pc,
            _ => unreachable!(),
        }
    }

    // Patch all Call instructions (including ones emitted inside subroutines or absent bodies).
    for (op_idx, target_group) in comp.call_patches {
        if let Op::Call { target_pc } = &mut comp.ops[op_idx] {
            *target_pc = sub_pcs[target_group];
        }
    }

    Program {
        ops: comp.ops,
        literals: comp.literals,
        charsets: comp.charsets,
        backref_groups: comp.backref_groups,
        num_captures: parsed.num_captures,
        num_counters: comp.num_counters,
        num_empty_checks: comp.num_empty_checks,
        uses_level_backref,
        named_groups: parsed.named_groups.clone(),
        has_g_anchor: parsed.has_g_anchor,
        whole_options: parsed.whole_options,
        prefilter,
    }
}

struct Compiler<'a> {
    ops: Vec<Op>,
    literals: Vec<u8>,
    charsets: Vec<CharSet>,
    backref_groups: Vec<Vec<usize>>,
    num_counters: usize,
    num_empty_checks: usize,
    call_patches: Vec<(usize, usize)>,
    absent_queue: Vec<(usize, Expr)>,
    group_bodies: &'a [Option<&'a Expr>],
    called_groups: &'a [bool],
    in_subroutine_group: Option<usize>,
}

impl<'a> Compiler<'a> {
    fn intern_bytes(&mut self, bytes: &[u8]) -> (u32, u32) {
        let offset = self.literals.len() as u32;
        self.literals.extend_from_slice(bytes);
        (offset, bytes.len() as u32)
    }

    fn intern_charset(&mut self, set: &CharSet) -> u32 {
        let idx = self.charsets.len() as u32;
        self.charsets.push(set.clone());
        idx
    }

    fn intern_groups(&mut self, groups: &[usize]) -> u32 {
        let idx = self.backref_groups.len() as u32;
        self.backref_groups.push(groups.to_vec());
        idx
    }

    fn emit_expr(&mut self, expr: &Expr) {
        match expr {
            Expr::Empty => {}
            Expr::Fail => self.ops.push(Op::Fail),
            Expr::Literal {
                text,
                ignore_case,
                ascii_icase,
            } => self.emit_literal(text, *ignore_case, *ascii_icase),
            Expr::AnyChar { dot_all } => self.ops.push(Op::AnyChar { dot_all: *dot_all }),
            Expr::GeneralNewline => self.ops.push(Op::GeneralNewline),
            Expr::TextSegment(mode) => self.ops.push(Op::TextSegment(*mode)),
            Expr::CharClass(set) => {
                if set.is_empty() {
                    self.ops.push(Op::Fail);
                } else {
                    let idx = self.intern_charset(set);
                    self.ops.push(Op::CharClass(idx));
                }
            }
            Expr::Anchor(a) => self.ops.push(Op::Anchor(*a)),
            Expr::Keep => self.ops.push(Op::Keep),
            Expr::Seq(items) => {
                for item in items {
                    self.emit_expr(item);
                }
            }
            Expr::Alt(branches) => self.emit_alt(branches),
            Expr::Repeat { expr, min, max, mode } => self.emit_repeat(expr, *min, *max, *mode),
            Expr::Capture { index, expr, .. } => {
                // Groups referenced by `\g<...>` execute via `Call` even at their definition site
                // so recursion-level backreferences (`\k<1+n>`) observe uniform call depth.
                if self.called_groups[*index] && self.in_subroutine_group != Some(*index) {
                    let idx = self.ops.len();
                    self.ops.push(Op::Call { target_pc: 0 });
                    self.call_patches.push((idx, *index));
                } else {
                    self.ops.push(Op::CaptureStart(*index as u32));
                    self.emit_expr(expr);
                    self.ops.push(Op::CaptureEnd(*index as u32));
                }
            }
            Expr::Atomic(inner) => {
                self.ops.push(Op::SaveMark);
                self.emit_expr(inner);
                self.ops.push(Op::CutToMark);
            }
            Expr::Lookaround { kind, expr } => self.emit_lookaround(*kind, expr),
            Expr::Backref {
                target,
                ignore_case,
                ascii_icase,
            } => {
                let (groups, level) = match target {
                    BackrefTarget::Groups(g) => (g, None),
                    BackrefTarget::WithLevel { groups, level } => (groups, Some(*level)),
                };
                if groups.len() == 1 || level.is_some() {
                    let idx = self.intern_groups(groups);
                    self.ops.push(Op::Backref {
                        group_list_idx: idx,
                        level,
                        ignore_case: *ignore_case,
                        ascii_icase: *ascii_icase,
                    });
                } else {
                    // Duplicate named groups try each group from most recently defined to earliest,
                    // backtracking to earlier definitions if a later one fails to match.
                    let alts: Vec<Expr> = groups
                        .iter()
                        .map(|&g| Expr::Backref {
                            target: BackrefTarget::Groups(vec![g]),
                            ignore_case: *ignore_case,
                            ascii_icase: *ascii_icase,
                        })
                        .collect();
                    self.emit_alt(&alts);
                }
            }
            Expr::Call { target_group } => {
                let idx = self.ops.len();
                self.ops.push(Op::Call { target_pc: 0 });
                self.call_patches.push((idx, *target_group));
            }
            Expr::Condition {
                cond,
                then_branch,
                else_branch,
            } => self.emit_condition(cond, then_branch, else_branch.as_deref()),
            Expr::AbsentRepeater(absent) => {
                let idx = self.ops.len();
                self.ops.push(Op::AbsentRepeater { absent_pc: 0 });
                self.absent_queue.push((idx, (**absent).clone()));
            }
            Expr::AbsentExpression { absent, expr } => {
                let idx = self.ops.len();
                self.ops.push(Op::AbsentSetLimit { absent_pc: 0, scoped: true });
                self.absent_queue.push((idx, (**absent).clone()));
                self.emit_expr(expr);
                self.ops.push(Op::AbsentRestoreLimit);
            }
            Expr::AbsentStopper(absent) => {
                let idx = self.ops.len();
                self.ops.push(Op::AbsentSetLimit { absent_pc: 0, scoped: false });
                self.absent_queue.push((idx, (**absent).clone()));
            }
            Expr::RangeClear => self.ops.push(Op::RangeClear),
        }
    }

    fn emit_literal(&mut self, text: &str, ignore_case: bool, ascii_icase: bool) {
        if text.is_empty() {
            return;
        }
        if !ignore_case {
            if text.len() == 1 {
                self.ops.push(Op::Byte(text.as_bytes()[0]));
            } else if text.chars().count() == 1 {
                self.ops.push(Op::Char(text.chars().next().unwrap()));
            } else {
                let (offset, len) = self.intern_bytes(text.as_bytes());
                self.ops.push(Op::Bytes { offset, len });
            }
            return;
        }

        // Fast single-char case-insensitive op when the single char has no multi-char fold expansion.
        let mut chars = text.chars();
        if let (Some(ch), None) = (chars.next(), chars.next())
            && (ascii_icase || fold_multi_expansion(ch as u32).is_none())
        {
            self.ops.push(Op::CharICase { ch, ascii_only: ascii_icase });
            return;
        }
        let (offset, len) = self.intern_bytes(text.as_bytes());
        self.ops.push(Op::StrICase {
            offset,
            len,
            ascii_only: ascii_icase,
        });
    }

    fn emit_alt(&mut self, branches: &[Expr]) {
        if branches.is_empty() {
            return;
        }
        if branches.len() == 1 {
            self.emit_expr(&branches[0]);
            return;
        }

        let mut end_jumps = Vec::with_capacity(branches.len() - 1);
        for (i, branch) in branches.iter().enumerate() {
            if i + 1 < branches.len() {
                let split_idx = self.ops.len();
                self.ops.push(Op::Split {
                    primary: (split_idx + 1) as u32,
                    fallback: 0,
                });
                self.emit_expr(branch);
                let jmp_idx = self.ops.len();
                self.ops.push(Op::Jump(0));
                end_jumps.push(jmp_idx);
                let next_pc = self.ops.len() as u32;
                if let Op::Split { fallback, .. } = &mut self.ops[split_idx] {
                    *fallback = next_pc;
                }
            } else {
                self.emit_expr(branch);
            }
        }
        let after_pc = self.ops.len() as u32;
        for jmp_idx in end_jumps {
            if let Op::Jump(dst) = &mut self.ops[jmp_idx] {
                *dst = after_pc;
            }
        }
    }

    fn emit_repeat(&mut self, body: &Expr, min: u32, max: Option<u32>, mode: QuantifierMode) {
        if max == Some(0) {
            // `{0}` never executes inline; any subroutine target groups inside are compiled separately.
            return;
        }

        // Possessive quantifiers are equivalent to atomic wrapping of the greedy quantifier.
        if mode == QuantifierMode::Possessive {
            self.ops.push(Op::SaveMark);
            self.emit_repeat(body, min, max, QuantifierMode::Greedy);
            self.ops.push(Op::CutToMark);
            return;
        }

        let is_lazy = mode == QuantifierMode::Lazy;

        // Specialized fast paths for `?` / `??`, `*` / `*?`, `+` / `+?`.
        if min == 0 && max == Some(1) {
            let split_idx = self.ops.len();
            self.ops.push(Op::Split { primary: 0, fallback: 0 });
            let body_pc = self.ops.len() as u32;
            self.emit_expr(body);
            let after_pc = self.ops.len() as u32;
            let (primary, fallback) = if is_lazy { (after_pc, body_pc) } else { (body_pc, after_pc) };
            self.ops[split_idx] = Op::Split { primary, fallback };
            return;
        }

        let nullable = expr_can_match_empty(body, self.group_bodies);
        let has_caps = expr_has_captures(body, self.group_bodies);

        if min <= 1 && max.is_none() {
            let check_id = if nullable {
                let id = self.num_empty_checks as u32;
                self.num_empty_checks += 1;
                Some(id)
            } else {
                None
            };

            if min == 0 {
                let split_idx = self.ops.len();
                self.ops.push(Op::Split { primary: 0, fallback: 0 });
                let body_pc = self.ops.len() as u32;
                if let Some(id) = check_id {
                    self.ops.push(Op::EmptyCheckStart(id));
                }
                self.emit_expr(body);
                let empty_end_idx = if let Some(id) = check_id {
                    let idx = self.ops.len();
                    self.ops.push(Op::EmptyCheckEnd {
                        check_id: id,
                        check_captures: has_caps,
                        after_pc: 0,
                    });
                    Some(idx)
                } else {
                    None
                };
                self.ops.push(Op::Jump(split_idx as u32));
                let after_pc = self.ops.len() as u32;
                if let Some(idx) = empty_end_idx
                    && let Op::EmptyCheckEnd { after_pc: dst, .. } = &mut self.ops[idx]
                {
                    *dst = after_pc;
                }
                let (primary, fallback) = if is_lazy { (after_pc, body_pc) } else { (body_pc, after_pc) };
                self.ops[split_idx] = Op::Split { primary, fallback };
            } else {
                // `+` / `+?`
                let body_pc = self.ops.len() as u32;
                if let Some(id) = check_id {
                    self.ops.push(Op::EmptyCheckStart(id));
                }
                self.emit_expr(body);
                let empty_end_idx = if let Some(id) = check_id {
                    let idx = self.ops.len();
                    self.ops.push(Op::EmptyCheckEnd {
                        check_id: id,
                        check_captures: has_caps,
                        after_pc: 0,
                    });
                    Some(idx)
                } else {
                    None
                };
                let split_idx = self.ops.len();
                let after_pc = (split_idx + 1) as u32;
                if let Some(idx) = empty_end_idx
                    && let Op::EmptyCheckEnd { after_pc: dst, .. } = &mut self.ops[idx]
                {
                    *dst = after_pc;
                }
                let (primary, fallback) = if is_lazy { (after_pc, body_pc) } else { (body_pc, after_pc) };
                self.ops.push(Op::Split { primary, fallback });
            }
            return;
        }

        // General counted loop `{min, max}`.
        let counter = self.num_counters as u32;
        self.num_counters += 1;
        let check_id = if nullable && max.is_none() {
            let id = self.num_empty_checks as u32;
            self.num_empty_checks += 1;
            Some(id)
        } else {
            None
        };

        self.ops.push(Op::CounterInit(counter));
        let loop_head = self.ops.len() as u32;

        // If `counter < min`, must run body unconditionally.
        let check_min_idx = if min > 0 {
            let idx = self.ops.len();
            self.ops.push(Op::CounterCheckMin { counter, min, body_pc: 0 });
            Some(idx)
        } else {
            None
        };

        // If `max` is set and `counter >= max`, jump to after.
        let check_max_idx = if let Some(m) = max {
            let idx = self.ops.len();
            self.ops.push(Op::CounterCheckMax { counter, max: m, done_pc: 0 });
            Some(idx)
        } else {
            None
        };

        // Optional zone (`min <= counter < max`): split between continuing and exiting.
        let split_idx = if max != Some(min) {
            let idx = self.ops.len();
            self.ops.push(Op::Split { primary: 0, fallback: 0 });
            Some(idx)
        } else {
            None
        };

        let body_pc = self.ops.len() as u32;
        if let Some(id) = check_id {
            self.ops.push(Op::EmptyCheckStart(id));
        }
        self.emit_expr(body);
        self.ops.push(Op::CounterInc(counter));
        let empty_end_idx = if let Some(id) = check_id {
            let idx = self.ops.len();
            self.ops.push(Op::EmptyCheckEnd {
                check_id: id,
                check_captures: has_caps,
                after_pc: 0,
            });
            Some(idx)
        } else {
            None
        };
        self.ops.push(Op::Jump(loop_head));

        let after_pc = self.ops.len() as u32;
        if let Some(idx) = empty_end_idx
            && let Op::EmptyCheckEnd { after_pc: dst, .. } = &mut self.ops[idx]
        {
            *dst = after_pc;
        }
        if let Some(idx) = check_min_idx
            && let Op::CounterCheckMin { body_pc: dst, .. } = &mut self.ops[idx]
        {
            *dst = body_pc;
        }
        if let Some(idx) = check_max_idx
            && let Op::CounterCheckMax { done_pc: dst, .. } = &mut self.ops[idx]
        {
            *dst = after_pc;
        }
        if let Some(idx) = split_idx {
            let (primary, fallback) = if is_lazy { (after_pc, body_pc) } else { (body_pc, after_pc) };
            self.ops[idx] = Op::Split { primary, fallback };
        }
    }

    fn emit_lookaround(&mut self, kind: LookaroundKind, expr: &Expr) {
        match kind {
            LookaroundKind::PosLookahead => {
                self.ops.push(Op::SavePosLookaround);
                self.emit_expr(expr);
                self.ops.push(Op::PosLookaroundEnd);
            }
            LookaroundKind::NegLookahead => {
                let split_idx = self.ops.len();
                self.ops.push(Op::Split {
                    primary: (split_idx + 1) as u32,
                    fallback: 0,
                });
                self.ops.push(Op::SaveNegLookaround);
                self.emit_expr(expr);
                self.ops.push(Op::NegLookaroundMatchFail);
                let after_pc = self.ops.len() as u32;
                if let Op::Split { fallback, .. } = &mut self.ops[split_idx] {
                    *fallback = after_pc;
                }
            }
            LookaroundKind::PosLookbehind => {
                // Split top-level alternations so each fixed-length branch steps back directly in O(1).
                if let Expr::Alt(branches) = expr {
                    let per_branch: Vec<Expr> = branches
                        .iter()
                        .map(|b| Expr::Lookaround {
                            kind: LookaroundKind::PosLookbehind,
                            expr: Box::new(b.clone()),
                        })
                        .collect();
                    self.emit_alt(&per_branch);
                    return;
                }
                let (min_chars, max_chars) = expr_char_len_bounds(expr, self.group_bodies);
                self.ops.push(Op::SavePosLookaround);
                self.ops.push(Op::StepBackStart { min_chars, max_chars });
                self.emit_expr(expr);
                self.ops.push(Op::CheckLbEnd);
                self.ops.push(Op::PosLookbehindEnd);
            }
            LookaroundKind::NegLookbehind => {
                if let Expr::Alt(branches) = expr {
                    for b in branches {
                        self.emit_lookaround(LookaroundKind::NegLookbehind, b);
                    }
                    return;
                }
                let (min_chars, max_chars) = expr_char_len_bounds(expr, self.group_bodies);
                let split_idx = self.ops.len();
                self.ops.push(Op::Split {
                    primary: (split_idx + 1) as u32,
                    fallback: 0,
                });
                self.ops.push(Op::SaveNegLookaround);
                self.ops.push(Op::StepBackStart { min_chars, max_chars });
                self.emit_expr(expr);
                self.ops.push(Op::CheckLbEnd);
                self.ops.push(Op::NegLookaroundMatchFail);
                let after_pc = self.ops.len() as u32;
                if let Op::Split { fallback, .. } = &mut self.ops[split_idx] {
                    *fallback = after_pc;
                }
            }
        }
    }

    fn emit_condition(&mut self, cond: &ConditionKind, then_branch: &Expr, else_branch: Option<&Expr>) {
        match cond {
            ConditionKind::BackrefValid { groups, level } => {
                let idx = self.intern_groups(groups);
                let check_idx = self.ops.len();
                self.ops.push(Op::JumpIfBackrefInvalid {
                    group_list_idx: idx,
                    level: *level,
                    else_pc: 0,
                });
                self.emit_expr(then_branch);
                let jmp_after = self.ops.len();
                self.ops.push(Op::Jump(0));
                let else_pc = self.ops.len() as u32;
                if let Some(e) = else_branch {
                    self.emit_expr(e);
                }
                let after_pc = self.ops.len() as u32;
                if let Op::JumpIfBackrefInvalid { else_pc: dst, .. } = &mut self.ops[check_idx] {
                    *dst = else_pc;
                }
                if let Op::Jump(dst) = &mut self.ops[jmp_after] {
                    *dst = after_pc;
                }
            }
            ConditionKind::Expr(cond_expr) => {
                let split_idx = self.ops.len();
                self.ops.push(Op::Split {
                    primary: (split_idx + 1) as u32,
                    fallback: 0,
                });
                self.ops.push(Op::SaveCondMark);
                self.emit_expr(cond_expr);
                self.ops.push(Op::CutCondFallback);
                self.emit_expr(then_branch);
                let jmp_after = self.ops.len();
                self.ops.push(Op::Jump(0));
                let else_pc = self.ops.len() as u32;
                if let Some(e) = else_branch {
                    self.emit_expr(e);
                }
                let after_pc = self.ops.len() as u32;
                if let Op::Split { fallback, .. } = &mut self.ops[split_idx] {
                    *fallback = else_pc;
                }
                if let Op::Jump(dst) = &mut self.ops[jmp_after] {
                    *dst = after_pc;
                }
            }
        }
    }
}

fn collect_group_bodies<'a>(expr: &'a Expr, out: &mut [Option<&'a Expr>]) {
    match expr {
        Expr::Capture { index, expr, .. } => {
            out[*index] = Some(expr);
            collect_group_bodies(expr, out);
        }
        Expr::Seq(items) | Expr::Alt(items) => {
            for item in items {
                collect_group_bodies(item, out);
            }
        }
        Expr::Repeat { expr, .. } | Expr::Atomic(expr) | Expr::Lookaround { expr, .. } | Expr::AbsentRepeater(expr) | Expr::AbsentStopper(expr) => {
            collect_group_bodies(expr, out)
        }
        Expr::AbsentExpression { absent, expr } => {
            collect_group_bodies(absent, out);
            collect_group_bodies(expr, out);
        }
        Expr::Condition {
            cond,
            then_branch,
            else_branch,
        } => {
            if let ConditionKind::Expr(e) = cond {
                collect_group_bodies(e, out);
            }
            collect_group_bodies(then_branch, out);
            if let Some(e) = else_branch {
                collect_group_bodies(e, out);
            }
        }
        _ => {}
    }
}

fn collect_called_groups(expr: &Expr, out: &mut [bool]) {
    match expr {
        Expr::Call { target_group } => out[*target_group] = true,
        Expr::Seq(items) | Expr::Alt(items) => {
            for item in items {
                collect_called_groups(item, out);
            }
        }
        Expr::Repeat { expr, .. }
        | Expr::Capture { expr, .. }
        | Expr::Atomic(expr)
        | Expr::Lookaround { expr, .. }
        | Expr::AbsentRepeater(expr)
        | Expr::AbsentStopper(expr) => collect_called_groups(expr, out),
        Expr::AbsentExpression { absent, expr } => {
            collect_called_groups(absent, out);
            collect_called_groups(expr, out);
        }
        Expr::Condition {
            cond,
            then_branch,
            else_branch,
        } => {
            if let ConditionKind::Expr(e) = cond {
                collect_called_groups(e, out);
            }
            collect_called_groups(then_branch, out);
            if let Some(e) = else_branch {
                collect_called_groups(e, out);
            }
        }
        _ => {}
    }
}

fn detect_level_backref(expr: &Expr, out: &mut bool) {
    if *out {
        return;
    }
    match expr {
        Expr::Backref {
            target: BackrefTarget::WithLevel { .. },
            ..
        }
        | Expr::Condition {
            cond: ConditionKind::BackrefValid { level: Some(_), .. },
            ..
        } => *out = true,
        Expr::Seq(items) | Expr::Alt(items) => {
            for item in items {
                detect_level_backref(item, out);
            }
        }
        Expr::Repeat { expr, .. }
        | Expr::Capture { expr, .. }
        | Expr::Atomic(expr)
        | Expr::Lookaround { expr, .. }
        | Expr::AbsentRepeater(expr)
        | Expr::AbsentStopper(expr) => detect_level_backref(expr, out),
        Expr::AbsentExpression { absent, expr } => {
            detect_level_backref(absent, out);
            detect_level_backref(expr, out);
        }
        Expr::Condition {
            cond,
            then_branch,
            else_branch,
        } => {
            if let ConditionKind::Expr(e) = cond {
                detect_level_backref(e, out);
            }
            detect_level_backref(then_branch, out);
            if let Some(e) = else_branch {
                detect_level_backref(e, out);
            }
        }
        _ => {}
    }
}

fn expr_can_match_empty(expr: &Expr, group_bodies: &[Option<&Expr>]) -> bool {
    let mut visited = vec![false; group_bodies.len()];
    expr_can_match_empty_rec(expr, group_bodies, &mut visited)
}

fn expr_can_match_empty_rec(expr: &Expr, group_bodies: &[Option<&Expr>], visited: &mut [bool]) -> bool {
    match expr {
        Expr::Empty | Expr::Anchor(_) | Expr::Keep | Expr::Lookaround { .. } | Expr::RangeClear => true,
        Expr::Fail | Expr::AnyChar { .. } | Expr::GeneralNewline | Expr::TextSegment(_) | Expr::CharClass(_) => false,
        Expr::Literal { text, .. } => text.is_empty(),
        Expr::Backref { .. } => true,
        Expr::Seq(items) => items.iter().all(|i| expr_can_match_empty_rec(i, group_bodies, visited)),
        Expr::Alt(branches) => branches.iter().any(|b| expr_can_match_empty_rec(b, group_bodies, visited)),
        Expr::Repeat { expr, min, .. } => *min == 0 || expr_can_match_empty_rec(expr, group_bodies, visited),
        Expr::Capture { expr, .. } | Expr::Atomic(expr) => expr_can_match_empty_rec(expr, group_bodies, visited),
        Expr::Call { target_group } => {
            if visited[*target_group] {
                return true;
            }
            visited[*target_group] = true;
            let res = group_bodies[*target_group].is_some_and(|b| expr_can_match_empty_rec(b, group_bodies, visited));
            visited[*target_group] = false;
            res
        }
        Expr::Condition { then_branch, else_branch, .. } => {
            expr_can_match_empty_rec(then_branch, group_bodies, visited)
                || else_branch.as_deref().is_none_or(|e| expr_can_match_empty_rec(e, group_bodies, visited))
        }
        Expr::AbsentRepeater(_) | Expr::AbsentStopper(_) => true,
        Expr::AbsentExpression { expr, .. } => expr_can_match_empty_rec(expr, group_bodies, visited),
    }
}

fn expr_has_captures(expr: &Expr, group_bodies: &[Option<&Expr>]) -> bool {
    let mut visited = vec![false; group_bodies.len()];
    expr_has_captures_rec(expr, group_bodies, &mut visited)
}

fn expr_has_captures_rec(expr: &Expr, group_bodies: &[Option<&Expr>], visited: &mut [bool]) -> bool {
    match expr {
        Expr::Capture { .. } => true,
        Expr::Seq(items) | Expr::Alt(items) => items.iter().any(|i| expr_has_captures_rec(i, group_bodies, visited)),
        Expr::Repeat { expr, .. } | Expr::Atomic(expr) | Expr::Lookaround { expr, .. } | Expr::AbsentRepeater(expr) | Expr::AbsentStopper(expr) => {
            expr_has_captures_rec(expr, group_bodies, visited)
        }
        Expr::AbsentExpression { expr, .. } => expr_has_captures_rec(expr, group_bodies, visited),
        Expr::Call { target_group } => {
            if visited[*target_group] {
                return false;
            }
            visited[*target_group] = true;
            let res = *target_group != 0 || group_bodies[*target_group].is_some_and(|b| expr_has_captures_rec(b, group_bodies, visited));
            visited[*target_group] = false;
            res
        }
        Expr::Condition {
            cond,
            then_branch,
            else_branch,
        } => {
            let c = match cond {
                ConditionKind::Expr(e) => expr_has_captures_rec(e, group_bodies, visited),
                ConditionKind::BackrefValid { .. } => false,
            };
            c || expr_has_captures_rec(then_branch, group_bodies, visited)
                || else_branch.as_deref().is_some_and(|e| expr_has_captures_rec(e, group_bodies, visited))
        }
        _ => false,
    }
}

/// Computes `(min_chars, max_chars)` bounds (in UTF-8 scalar values) for lookbehind step-back.
fn expr_char_len_bounds(expr: &Expr, group_bodies: &[Option<&Expr>]) -> (usize, Option<usize>) {
    let mut visited = vec![false; group_bodies.len()];
    expr_char_len_bounds_rec(expr, group_bodies, &mut visited)
}

fn expr_char_len_bounds_rec(expr: &Expr, group_bodies: &[Option<&Expr>], visited: &mut [bool]) -> (usize, Option<usize>) {
    match expr {
        Expr::Empty | Expr::Anchor(_) | Expr::Keep | Expr::Lookaround { .. } | Expr::RangeClear | Expr::AbsentStopper(_) => (0, Some(0)),
        Expr::Fail => (0, Some(0)),
        Expr::Literal {
            text,
            ignore_case,
            ascii_icase,
        } => {
            let n = text.chars().count();
            if !*ignore_case || *ascii_icase {
                (n, Some(n))
            } else if n == 1 && fold_multi_expansion(text.chars().next().unwrap() as u32).is_none() {
                (1, Some(1))
            } else if n == 0 {
                (0, Some(0))
            } else {
                // Multi-char Unicode case fold can map 1..3 chars <-> 1..3 chars (e.g. `ss` <-> `ß`).
                let min = n.div_ceil(3).max(1);
                let max = n.saturating_mul(3);
                (min, Some(max))
            }
        }
        Expr::AnyChar { .. } | Expr::CharClass(_) => (1, Some(1)),
        Expr::GeneralNewline => (1, Some(2)),
        Expr::TextSegment(_) => (1, None),
        Expr::Backref { .. } | Expr::AbsentRepeater(_) => (0, None),
        Expr::AbsentExpression { expr, .. } => expr_char_len_bounds_rec(expr, group_bodies, visited),
        Expr::Seq(items) => {
            let mut min_sum: usize = 0;
            let mut max_sum: Option<usize> = Some(0);
            for item in items {
                let (lo, hi) = expr_char_len_bounds_rec(item, group_bodies, visited);
                min_sum = min_sum.saturating_add(lo);
                max_sum = match (max_sum, hi) {
                    (Some(a), Some(b)) => a.checked_add(b),
                    _ => None,
                };
            }
            (min_sum, max_sum)
        }
        Expr::Alt(branches) => {
            if branches.is_empty() {
                return (0, Some(0));
            }
            let mut min_all = usize::MAX;
            let mut max_all: Option<usize> = Some(0);
            for b in branches {
                let (lo, hi) = expr_char_len_bounds_rec(b, group_bodies, visited);
                min_all = min_all.min(lo);
                max_all = match (max_all, hi) {
                    (Some(a), Some(b)) => Some(a.max(b)),
                    _ => None,
                };
            }
            (min_all, max_all)
        }
        Expr::Repeat { expr, min, max, .. } => {
            if *max == Some(0) {
                return (0, Some(0));
            }
            let (lo, hi) = expr_char_len_bounds_rec(expr, group_bodies, visited);
            let total_min = lo.saturating_mul(*min as usize);
            let total_max = match (*max, hi) {
                (Some(m), Some(h)) => h.checked_mul(m as usize),
                _ => None,
            };
            (total_min, total_max)
        }
        Expr::Capture { expr, .. } | Expr::Atomic(expr) => expr_char_len_bounds_rec(expr, group_bodies, visited),
        Expr::Call { target_group } => {
            if visited[*target_group] {
                return (0, None);
            }
            visited[*target_group] = true;
            let res = group_bodies[*target_group].map_or((0, Some(0)), |b| expr_char_len_bounds_rec(b, group_bodies, visited));
            visited[*target_group] = false;
            res
        }
        Expr::Condition {
            cond,
            then_branch,
            else_branch,
        } => {
            let (c_lo, c_hi) = match cond {
                ConditionKind::Expr(e) => expr_char_len_bounds_rec(e, group_bodies, visited),
                ConditionKind::BackrefValid { .. } => (0, Some(0)),
            };
            let (t_lo, t_hi) = expr_char_len_bounds_rec(then_branch, group_bodies, visited);
            let then_lo = c_lo.saturating_add(t_lo);
            let then_hi = match (c_hi, t_hi) {
                (Some(a), Some(b)) => a.checked_add(b),
                _ => None,
            };
            let (e_lo, e_hi) = match else_branch {
                Some(e) => expr_char_len_bounds_rec(e, group_bodies, visited),
                None => (0, Some(0)),
            };
            let max_hi = match (then_hi, e_hi) {
                (Some(a), Some(b)) => Some(a.max(b)),
                _ => None,
            };
            (then_lo.min(e_lo), max_hi)
        }
    }
}

fn compute_prefilter(expr: &Expr, group_bodies: &[Option<&Expr>]) -> StartPrefilter {
    if must_start_with_anchor(expr, Anchor::BeginPosition) {
        return StartPrefilter::AnchoredG;
    }
    if must_start_with_anchor(expr, Anchor::BeginBuf) {
        return StartPrefilter::AnchoredStart;
    }
    if let Some(lit) = extract_exact_prefix(expr)
        && !lit.is_empty()
    {
        return StartPrefilter::Literal(lit);
    }
    let mut mask = [0u64; 4];
    if collect_first_bytes(expr, group_bodies, &mut mask) {
        // Only use mask if it actually filters out at least some ASCII bytes.
        if mask != [u64::MAX; 4] {
            return StartPrefilter::FirstByteMask(mask);
        }
    }
    StartPrefilter::Any
}

fn must_start_with_anchor(expr: &Expr, target: Anchor) -> bool {
    match expr {
        Expr::Anchor(a) => *a == target,
        Expr::Seq(items) => {
            for item in items {
                if must_start_with_anchor(item, target) {
                    return true;
                }
                if !matches!(item, Expr::Empty | Expr::Anchor(_) | Expr::Keep | Expr::Lookaround { .. }) {
                    return false;
                }
            }
            false
        }
        Expr::Alt(branches) => !branches.is_empty() && branches.iter().all(|b| must_start_with_anchor(b, target)),
        Expr::Capture { expr, .. } | Expr::Atomic(expr) => must_start_with_anchor(expr, target),
        Expr::Repeat { expr, min, .. } => *min > 0 && must_start_with_anchor(expr, target),
        _ => false,
    }
}

fn extract_exact_prefix(expr: &Expr) -> Option<Vec<u8>> {
    match expr {
        Expr::Literal { text, ignore_case: false, .. } if !text.is_empty() => Some(text.as_bytes().to_vec()),
        Expr::Seq(items) => {
            let mut out = Vec::new();
            for item in items {
                match item {
                    Expr::Empty | Expr::Keep | Expr::Anchor(_) | Expr::Lookaround { .. } => {
                        if !out.is_empty() {
                            break;
                        }
                    }
                    Expr::Literal { text, ignore_case: false, .. } => {
                        out.extend_from_slice(text.as_bytes());
                    }
                    _ => {
                        if out.is_empty()
                            && let Some(sub) = extract_exact_prefix(item)
                        {
                            out.extend_from_slice(&sub);
                        }
                        break;
                    }
                }
            }
            if out.is_empty() { None } else { Some(out) }
        }
        Expr::Capture { expr, .. } | Expr::Atomic(expr) => extract_exact_prefix(expr),
        Expr::Repeat { expr, min, .. } if *min > 0 => extract_exact_prefix(expr),
        _ => None,
    }
}

/// Returns `true` if `mask` completely covers all possible starting bytes of a match.
/// Returns `false` if the expression can match empty or any arbitrary byte.
fn collect_first_bytes(expr: &Expr, group_bodies: &[Option<&Expr>], mask: &mut [u64; 4]) -> bool {
    match expr {
        Expr::Literal {
            text,
            ignore_case,
            ascii_icase,
        } => {
            let Some(ch) = text.chars().next() else {
                return false;
            };
            if !*ignore_case {
                let mut buf = [0u8; 4];
                let s = ch.encode_utf8(&mut buf);
                set_byte(mask, s.as_bytes()[0]);
                return true;
            }
            if *ascii_icase {
                if ch.is_ascii_alphabetic() {
                    set_byte(mask, (ch as u8).to_ascii_lowercase());
                    set_byte(mask, (ch as u8).to_ascii_uppercase());
                } else {
                    let mut buf = [0u8; 4];
                    let s = ch.encode_utf8(&mut buf);
                    set_byte(mask, s.as_bytes()[0]);
                }
                return true;
            }
            // Unicode ignore-case: if single char may fold to multi-char or vice-versa, be conservative.
            let cp = ch as u32;
            if fold_multi_expansion(cp).is_some() || matches!(ch.to_ascii_lowercase(), 's' | 'f' | 'i' | 'l' | 'h' | 'j' | 't' | 'w' | 'y' | 'a' | 'n') {
                return false;
            }
            let mut buf = [0u8; 4];
            if let Some(group) = fold1_equivalents(cp) {
                for &m in group {
                    if let Some(c) = char::from_u32(m) {
                        let s = c.encode_utf8(&mut buf);
                        set_byte(mask, s.as_bytes()[0]);
                    }
                }
            } else {
                let s = ch.encode_utf8(&mut buf);
                set_byte(mask, s.as_bytes()[0]);
            }
            true
        }
        Expr::CharClass(set) => {
            let m = set.first_utf8_byte_mask();
            for i in 0..4 {
                mask[i] |= m[i];
            }
            true
        }
        Expr::GeneralNewline => {
            for b in [b'\r', b'\n', 0x0b, 0x0c, 0xC2, 0xE2] {
                set_byte(mask, b);
            }
            true
        }
        Expr::Seq(items) => {
            for item in items {
                if matches!(item, Expr::Empty | Expr::Anchor(_) | Expr::Keep | Expr::Lookaround { .. }) {
                    continue;
                }
                if expr_can_match_empty(item, group_bodies) {
                    if !collect_first_bytes(item, group_bodies, mask) {
                        return false;
                    }
                    continue;
                }
                return collect_first_bytes(item, group_bodies, mask);
            }
            false
        }
        Expr::Alt(branches) => {
            if branches.is_empty() {
                return false;
            }
            for b in branches {
                if !collect_first_bytes(b, group_bodies, mask) {
                    return false;
                }
            }
            true
        }
        Expr::Capture { expr, .. } | Expr::Atomic(expr) => collect_first_bytes(expr, group_bodies, mask),
        Expr::Repeat { expr, min, .. } => *min > 0 && collect_first_bytes(expr, group_bodies, mask),
        _ => false,
    }
}
