package durable

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"reflect"
	"strconv"
	"strings"
	"time"
	"unicode"

	"github.com/vibevalleyhq/vibevalley/internal/durable/store"
)

const (
	TaskKindCodeMode     = "pi.codemode"
	TaskKindCodeModeTool = "pi.codemode.tool"

	PhaseCodeExec      = "codemode_exec"
	PhaseCodeSleepWake = "codemode_sleep_wake"
	PhaseCodeToolRun   = "codemode_tool_run"

	defaultCodeMaxSteps       = 10_000
	defaultCodeMaxVars        = 256
	defaultCodeMaxOutputBytes = 1 << 20 // 1 MiB
)

// CodeModeSpec configures deterministic replay execution of a pure-Go orchestrated script.
type CodeModeSpec struct {
	Script         string `json:"script"`
	Seed           uint64 `json:"seed"`
	StartTimeMs    int64  `json:"startTimeMs"`
	MaxSteps       int    `json:"maxSteps,omitempty"`
	MaxVars        int    `json:"maxVars,omitempty"`
	MaxOutputBytes int    `json:"maxOutputBytes,omitempty"`
}

// CodeModeResult is committed as the final result of a CodeMode task.
type CodeModeResult struct {
	Value          any   `json:"value"`
	ExecutedSteps  int   `json:"executedSteps"`
	ReplayedCalls  int   `json:"replayedCalls"`
	ReplayedSleeps int   `json:"replayedSleeps"`
	VirtualNowMs   int64 `json:"virtualNowMs"`
}

type codeSleepCheckpoint struct {
	Spec     CodeModeSpec `json:"spec"`
	SleepKey string       `json:"sleepKey"`
	SleepMs  int64        `json:"sleepMs"`
}

type codeToolCheckpoint struct {
	ToolName string `json:"toolName"`
	Args     any    `json:"args"`
}

// CodeToolFunc executes a durable tool call spawned by a CodeMode script step.
type CodeToolFunc func(ctx context.Context, toolName string, args any) (any, error)

// RegisterCodeModePhases registers the deterministic CodeMode script replay phases on sched.
func RegisterCodeModePhases(sched *Scheduler, toolFn CodeToolFunc) {
	sched.RegisterPhase(TaskKindCodeMode, PhaseCodeExec, makeCodeExecPhase())
	sched.RegisterPhase(TaskKindCodeMode, PhaseCodeSleepWake, makeCodeSleepWakePhase())
	sched.RegisterPhase(TaskKindCodeModeTool, PhaseCodeToolRun, makeCodeToolRunPhase(toolFn))
}

func makeCodeToolRunPhase(toolFn CodeToolFunc) PhaseFunc {
	return func(ctx context.Context, tc *TaskContext) (Transition, error) {
		var cp codeToolCheckpoint
		if err := tc.UnmarshalCheckpoint(&cp); err != nil {
			return Transition{}, err
		}
		if toolFn == nil {
			return Transition{}, fmt.Errorf("%w: %s", ErrUnknownTool, cp.ToolName)
		}
		out, err := toolFn(ctx, cp.ToolName, cp.Args)
		if err != nil {
			return Transition{}, err
		}
		return TransComplete(out), nil
	}
}

func makeCodeSleepWakePhase() PhaseFunc {
	return func(ctx context.Context, tc *TaskContext) (Transition, error) {
		var cp codeSleepCheckpoint
		if err := tc.UnmarshalCheckpoint(&cp); err != nil {
			return Transition{}, err
		}
		// Persist sleep completion in memo_json so future crash replays fast-forward with 0 delay.
		if err := tc.Memo(ctx, cp.SleepKey, func() (any, error) {
			return true, nil
		}, nil); err != nil {
			return Transition{}, err
		}
		return TransNext(PhaseCodeExec, cp.Spec), nil
	}
}

func makeCodeExecPhase() PhaseFunc {
	return func(ctx context.Context, tc *TaskContext) (Transition, error) {
		var spec CodeModeSpec
		if err := tc.UnmarshalCheckpoint(&spec); err != nil {
			return Transition{}, err
		}
		stmts, err := parseCodeScript(spec.Script)
		if err != nil {
			return Transition{}, err
		}

		maxSteps := spec.MaxSteps
		if maxSteps <= 0 {
			maxSteps = defaultCodeMaxSteps
		}
		maxVars := spec.MaxVars
		if maxVars <= 0 {
			maxVars = defaultCodeMaxVars
		}
		maxBytes := spec.MaxOutputBytes
		if maxBytes <= 0 {
			maxBytes = defaultCodeMaxOutputBytes
		}

		memo, err := decodeMemoMap(tc.Task().MemoJSON)
		if err != nil {
			return Transition{}, err
		}

		vm := &codeVM{
			seed:           spec.Seed,
			virtualNowMs:   spec.StartTimeMs,
			maxSteps:       maxSteps,
			maxVars:        maxVars,
			maxOutputBytes: maxBytes,
			env:            make(map[string]any),
		}
		if vm.seed == 0 {
			vm.seed = 0x9e3779b97f4a7c15
		}

		var callSeq int
		var sleepSeq int
		var replayedCalls int
		var replayedSleeps int
		var yieldTransition *Transition

		vm.onCall = func(toolName string, args any) (any, bool, error) {
			callSeq++
			dedupKey := fmt.Sprintf("%s:call:%d:%s", tc.Task().ID, callSeq, toolName)
			existing, ok, err := tc.Store().GetTaskByDedupKey(ctx, tc.Task().ID, dedupKey)
			if err != nil {
				return nil, false, err
			}
			if ok && existing.Status == store.TaskTerminal {
				if existing.TerminalReason != store.ReasonCompleted {
					errMsg := existing.ErrorText
					if errMsg == "" {
						errMsg = existing.TerminalReason
					}
					return nil, false, fmt.Errorf("codemode tool %s failed: %s", toolName, errMsg)
				}
				var val any
				if len(existing.ResultJSON) > 0 {
					if err := json.Unmarshal(existing.ResultJSON, &val); err != nil {
						return nil, false, err
					}
				}
				replayedCalls++
				return val, true, nil
			}

			child, _, err := tc.SpawnChild(ctx, ChildTaskSpec{
				DedupKey:   dedupKey,
				Kind:       TaskKindCodeModeTool,
				PhaseName:  PhaseCodeToolRun,
				Checkpoint: codeToolCheckpoint{ToolName: toolName, Args: args},
			})
			if err != nil {
				return nil, false, err
			}
			tr := TransWaitTasks(PhaseCodeExec, spec, store.WaitFailFast, []string{child.ID})
			yieldTransition = &tr
			return nil, false, errVMYield
		}

		vm.onSleep = func(ms int64) (bool, error) {
			if ms < 0 {
				ms = 0
			}
			sleepSeq++
			sleepKey := fmt.Sprintf("__cm_sleep_%d", sleepSeq)
			if _, done := memo[sleepKey]; done {
				vm.virtualNowMs += ms
				replayedSleeps++
				return true, nil
			}
			tr := TransSleep(PhaseCodeSleepWake, codeSleepCheckpoint{
				Spec:     spec,
				SleepKey: sleepKey,
				SleepMs:  ms,
			}, SleepOptions{WakeAfter: time.Duration(ms) * time.Millisecond})
			yieldTransition = &tr
			return false, errVMYield
		}

		retVal, returned, runErr := vm.execBlock(stmts)
		if errors.Is(runErr, errVMYield) && yieldTransition != nil {
			return *yieldTransition, nil
		}
		if runErr != nil {
			return Transition{}, runErr
		}
		if !returned {
			retVal = nil
		}
		encoded, err := json.Marshal(retVal)
		if err != nil {
			return Transition{}, err
		}
		if len(encoded) > maxBytes {
			return Transition{}, fmt.Errorf("%w: result size %d > %d", ErrScriptQuotaExceeded, len(encoded), maxBytes)
		}

		return TransComplete(CodeModeResult{
			Value:          retVal,
			ExecutedSteps:  vm.steps,
			ReplayedCalls:  replayedCalls,
			ReplayedSleeps: replayedSleeps,
			VirtualNowMs:   vm.virtualNowMs,
		}), nil
	}
}

var errVMYield = errors.New("codemode: yield")

// --- Pure Go Deterministic JS-subset Lexer, Parser & Step-Quota VM ---

type cmTokenKind int

const (
	tokEOF cmTokenKind = iota
	tokIdent
	tokNumber
	tokString
	tokLet
	tokConst
	tokIf
	tokElse
	tokWhile
	tokFor
	tokReturn
	tokTrue
	tokFalse
	tokNull
	tokLParen
	tokRParen
	tokLBrace
	tokRBrace
	tokLBracket
	tokRBracket
	tokComma
	tokColon
	tokSemi
	tokDot
	tokAssign
	tokPlus
	tokMinus
	tokStar
	tokSlash
	tokPercent
	tokEq
	tokNeq
	tokLt
	tokLe
	tokGt
	tokGe
	tokAnd
	tokOr
	tokBang
)

type cmToken struct {
	kind cmTokenKind
	val  string
}

func tokenizeCodeScript(src string) ([]cmToken, error) {
	var out []cmToken
	i := 0
	n := len(src)
	for i < n {
		ch := src[i]
		if unicode.IsSpace(rune(ch)) {
			i++
			continue
		}
		if ch == '/' && i+1 < n && src[i+1] == '/' {
			i += 2
			for i < n && src[i] != '\n' {
				i++
			}
			continue
		}
		if ch == '/' && i+1 < n && src[i+1] == '*' {
			i += 2
			closed := false
			for i+1 < n {
				if src[i] == '*' && src[i+1] == '/' {
					i += 2
					closed = true
					break
				}
				i++
			}
			if !closed {
				return nil, fmt.Errorf("%w: unterminated block comment", ErrScriptSyntax)
			}
			continue
		}
		if ch == '"' || ch == '\'' {
			quote := ch
			i++
			var sb strings.Builder
			closed := false
			for i < n {
				c := src[i]
				if c == '\\' && i+1 < n {
					i++
					esc := src[i]
					switch esc {
					case 'n':
						sb.WriteByte('\n')
					case 't':
						sb.WriteByte('\t')
					case 'r':
						sb.WriteByte('\r')
					default:
						sb.WriteByte(esc)
					}
					i++
					continue
				}
				if c == quote {
					i++
					closed = true
					break
				}
				sb.WriteByte(c)
				i++
			}
			if !closed {
				return nil, fmt.Errorf("%w: unterminated string", ErrScriptSyntax)
			}
			out = append(out, cmToken{kind: tokString, val: sb.String()})
			continue
		}
		if unicode.IsDigit(rune(ch)) {
			start := i
			hasDot := false
			for i < n && (unicode.IsDigit(rune(src[i])) || (src[i] == '.' && !hasDot)) {
				if src[i] == '.' {
					hasDot = true
				}
				i++
			}
			out = append(out, cmToken{kind: tokNumber, val: src[start:i]})
			continue
		}
		if unicode.IsLetter(rune(ch)) || ch == '_' || ch == '$' {
			start := i
			for i < n && (unicode.IsLetter(rune(src[i])) || unicode.IsDigit(rune(src[i])) || src[i] == '_' || src[i] == '$') {
				i++
			}
			word := src[start:i]
			switch word {
			case "let":
				out = append(out, cmToken{kind: tokLet, val: word})
			case "const":
				out = append(out, cmToken{kind: tokConst, val: word})
			case "if":
				out = append(out, cmToken{kind: tokIf, val: word})
			case "else":
				out = append(out, cmToken{kind: tokElse, val: word})
			case "while":
				out = append(out, cmToken{kind: tokWhile, val: word})
			case "for":
				out = append(out, cmToken{kind: tokFor, val: word})
			case "return":
				out = append(out, cmToken{kind: tokReturn, val: word})
			case "true":
				out = append(out, cmToken{kind: tokTrue, val: word})
			case "false":
				out = append(out, cmToken{kind: tokFalse, val: word})
			case "null":
				out = append(out, cmToken{kind: tokNull, val: word})
			default:
				out = append(out, cmToken{kind: tokIdent, val: word})
			}
			continue
		}

		// Multi-char operators.
		if strings.HasPrefix(src[i:], "===") {
			out = append(out, cmToken{kind: tokEq, val: "==="})
			i += 3
			continue
		}
		if strings.HasPrefix(src[i:], "!==") {
			out = append(out, cmToken{kind: tokNeq, val: "!=="})
			i += 3
			continue
		}
		if strings.HasPrefix(src[i:], "==") {
			out = append(out, cmToken{kind: tokEq, val: "=="})
			i += 2
			continue
		}
		if strings.HasPrefix(src[i:], "!=") {
			out = append(out, cmToken{kind: tokNeq, val: "!="})
			i += 2
			continue
		}
		if strings.HasPrefix(src[i:], "<=") {
			out = append(out, cmToken{kind: tokLe, val: "<="})
			i += 2
			continue
		}
		if strings.HasPrefix(src[i:], ">=") {
			out = append(out, cmToken{kind: tokGe, val: ">="})
			i += 2
			continue
		}
		if strings.HasPrefix(src[i:], "&&") {
			out = append(out, cmToken{kind: tokAnd, val: "&&"})
			i += 2
			continue
		}
		if strings.HasPrefix(src[i:], "||") {
			out = append(out, cmToken{kind: tokOr, val: "||"})
			i += 2
			continue
		}

		single := map[byte]cmTokenKind{
			'(': tokLParen,
			')': tokRParen,
			'{': tokLBrace,
			'}': tokRBrace,
			'[': tokLBracket,
			']': tokRBracket,
			',': tokComma,
			':': tokColon,
			';': tokSemi,
			'.': tokDot,
			'=': tokAssign,
			'+': tokPlus,
			'-': tokMinus,
			'*': tokStar,
			'/': tokSlash,
			'%': tokPercent,
			'<': tokLt,
			'>': tokGt,
			'!': tokBang,
		}
		if kind, ok := single[ch]; ok {
			out = append(out, cmToken{kind: kind, val: string(ch)})
			i++
			continue
		}
		return nil, fmt.Errorf("%w: unexpected character %q", ErrScriptSyntax, ch)
	}
	out = append(out, cmToken{kind: tokEOF})
	return out, nil
}

type cmStmt interface{ isStmt() }
type cmExpr interface{ isExpr() }

type stmtAssign struct {
	name string
	expr cmExpr
}

func (stmtAssign) isStmt() {}

type stmtIf struct {
	cond cmExpr
	then []cmStmt
	els  []cmStmt
}

func (stmtIf) isStmt() {}

type stmtWhile struct {
	cond cmExpr
	body []cmStmt
}

func (stmtWhile) isStmt() {}

type stmtFor struct {
	init cmStmt
	cond cmExpr
	post cmStmt
	body []cmStmt
}

func (stmtFor) isStmt() {}

type stmtReturn struct {
	expr cmExpr
}

func (stmtReturn) isStmt() {}

type stmtExpr struct {
	expr cmExpr
}

func (stmtExpr) isStmt() {}

type exprLit struct{ val any }
type exprIdent struct{ name string }
type exprArray struct{ elems []cmExpr }
type exprObjField struct {
	key string
	val cmExpr
}
type exprObj struct{ fields []exprObjField }
type exprMember struct {
	obj   cmExpr
	field string
}
type exprIndex struct {
	obj cmExpr
	idx cmExpr
}
type exprCall struct {
	callee cmExpr
	args   []cmExpr
}
type exprUnary struct {
	op   cmTokenKind
	expr cmExpr
}
type exprBinary struct {
	op    cmTokenKind
	left  cmExpr
	right cmExpr
}

func (exprLit) isExpr()    {}
func (exprIdent) isExpr()  {}
func (exprArray) isExpr()  {}
func (exprObj) isExpr()    {}
func (exprMember) isExpr() {}
func (exprIndex) isExpr()  {}
func (exprCall) isExpr()   {}
func (exprUnary) isExpr()  {}
func (exprBinary) isExpr() {}

type cmParser struct {
	toks []cmToken
	pos  int
}

func parseCodeScript(src string) ([]cmStmt, error) {
	toks, err := tokenizeCodeScript(src)
	if err != nil {
		return nil, err
	}
	p := &cmParser{toks: toks}
	var stmts []cmStmt
	for p.peek().kind != tokEOF {
		st, err := p.parseStmt()
		if err != nil {
			return nil, err
		}
		stmts = append(stmts, st)
	}
	return stmts, nil
}

func (p *cmParser) peek() cmToken {
	if p.pos >= len(p.toks) {
		return cmToken{kind: tokEOF}
	}
	return p.toks[p.pos]
}

func (p *cmParser) next() cmToken {
	t := p.peek()
	if p.pos < len(p.toks) {
		p.pos++
	}
	return t
}

func (p *cmParser) match(k cmTokenKind) bool {
	if p.peek().kind == k {
		p.pos++
		return true
	}
	return false
}

func (p *cmParser) expect(k cmTokenKind, msg string) (cmToken, error) {
	t := p.peek()
	if t.kind != k {
		return cmToken{}, fmt.Errorf("%w: expected %s, got %q", ErrScriptSyntax, msg, t.val)
	}
	p.pos++
	return t, nil
}

func (p *cmParser) consumeSemiOptional() {
	_ = p.match(tokSemi)
}

func (p *cmParser) parseBlock() ([]cmStmt, error) {
	if _, err := p.expect(tokLBrace, "{"); err != nil {
		return nil, err
	}
	var stmts []cmStmt
	for p.peek().kind != tokRBrace && p.peek().kind != tokEOF {
		st, err := p.parseStmt()
		if err != nil {
			return nil, err
		}
		stmts = append(stmts, st)
	}
	if _, err := p.expect(tokRBrace, "}"); err != nil {
		return nil, err
	}
	return stmts, nil
}

func (p *cmParser) parseStmt() (cmStmt, error) {
	switch p.peek().kind {
	case tokLet, tokConst:
		p.next()
		id, err := p.expect(tokIdent, "identifier")
		if err != nil {
			return nil, err
		}
		if _, err := p.expect(tokAssign, "="); err != nil {
			return nil, err
		}
		ex, err := p.parseExpr()
		if err != nil {
			return nil, err
		}
		p.consumeSemiOptional()
		return stmtAssign{name: id.val, expr: ex}, nil

	case tokIf:
		p.next()
		if _, err := p.expect(tokLParen, "("); err != nil {
			return nil, err
		}
		cond, err := p.parseExpr()
		if err != nil {
			return nil, err
		}
		if _, err := p.expect(tokRParen, ")"); err != nil {
			return nil, err
		}
		thenBlock, err := p.parseBlock()
		if err != nil {
			return nil, err
		}
		var elseBlock []cmStmt
		if p.match(tokElse) {
			if p.peek().kind == tokIf {
				nested, err := p.parseStmt()
				if err != nil {
					return nil, err
				}
				elseBlock = []cmStmt{nested}
			} else {
				elseBlock, err = p.parseBlock()
				if err != nil {
					return nil, err
				}
			}
		}
		return stmtIf{cond: cond, then: thenBlock, els: elseBlock}, nil

	case tokWhile:
		p.next()
		if _, err := p.expect(tokLParen, "("); err != nil {
			return nil, err
		}
		cond, err := p.parseExpr()
		if err != nil {
			return nil, err
		}
		if _, err := p.expect(tokRParen, ")"); err != nil {
			return nil, err
		}
		body, err := p.parseBlock()
		if err != nil {
			return nil, err
		}
		return stmtWhile{cond: cond, body: body}, nil

	case tokFor:
		p.next()
		if _, err := p.expect(tokLParen, "("); err != nil {
			return nil, err
		}
		var initStmt cmStmt
		if !p.match(tokSemi) {
			var err error
			initStmt, err = p.parseSimpleAssignOrExpr()
			if err != nil {
				return nil, err
			}
			if _, err := p.expect(tokSemi, ";"); err != nil {
				return nil, err
			}
		}
		var cond cmExpr = exprLit{val: true}
		if !p.match(tokSemi) {
			var err error
			cond, err = p.parseExpr()
			if err != nil {
				return nil, err
			}
			if _, err := p.expect(tokSemi, ";"); err != nil {
				return nil, err
			}
		}
		var postStmt cmStmt
		if p.peek().kind != tokRParen {
			var err error
			postStmt, err = p.parseSimpleAssignOrExpr()
			if err != nil {
				return nil, err
			}
		}
		if _, err := p.expect(tokRParen, ")"); err != nil {
			return nil, err
		}
		body, err := p.parseBlock()
		if err != nil {
			return nil, err
		}
		return stmtFor{init: initStmt, cond: cond, post: postStmt, body: body}, nil

	case tokReturn:
		p.next()
		var ex cmExpr
		if p.peek().kind != tokSemi && p.peek().kind != tokRBrace && p.peek().kind != tokEOF {
			var err error
			ex, err = p.parseExpr()
			if err != nil {
				return nil, err
			}
		}
		p.consumeSemiOptional()
		return stmtReturn{expr: ex}, nil

	default:
		st, err := p.parseSimpleAssignOrExpr()
		if err != nil {
			return nil, err
		}
		p.consumeSemiOptional()
		return st, nil
	}
}

func (p *cmParser) parseSimpleAssignOrExpr() (cmStmt, error) {
	if p.peek().kind == tokLet || p.peek().kind == tokConst {
		p.next()
		id, err := p.expect(tokIdent, "identifier")
		if err != nil {
			return nil, err
		}
		if _, err := p.expect(tokAssign, "="); err != nil {
			return nil, err
		}
		ex, err := p.parseExpr()
		if err != nil {
			return nil, err
		}
		return stmtAssign{name: id.val, expr: ex}, nil
	}
	if p.peek().kind == tokIdent && p.pos+1 < len(p.toks) && p.toks[p.pos+1].kind == tokAssign {
		id := p.next()
		p.next()
		ex, err := p.parseExpr()
		if err != nil {
			return nil, err
		}
		return stmtAssign{name: id.val, expr: ex}, nil
	}
	ex, err := p.parseExpr()
	if err != nil {
		return nil, err
	}
	return stmtExpr{expr: ex}, nil
}

func (p *cmParser) parseExpr() (cmExpr, error) { return p.parseOr() }

func (p *cmParser) parseOr() (cmExpr, error) {
	left, err := p.parseAnd()
	if err != nil {
		return nil, err
	}
	for p.match(tokOr) {
		right, err := p.parseAnd()
		if err != nil {
			return nil, err
		}
		left = exprBinary{op: tokOr, left: left, right: right}
	}
	return left, nil
}

func (p *cmParser) parseAnd() (cmExpr, error) {
	left, err := p.parseEq()
	if err != nil {
		return nil, err
	}
	for p.match(tokAnd) {
		right, err := p.parseEq()
		if err != nil {
			return nil, err
		}
		left = exprBinary{op: tokAnd, left: left, right: right}
	}
	return left, nil
}

func (p *cmParser) parseEq() (cmExpr, error) {
	left, err := p.parseCmp()
	if err != nil {
		return nil, err
	}
	for p.peek().kind == tokEq || p.peek().kind == tokNeq {
		op := p.next().kind
		right, err := p.parseCmp()
		if err != nil {
			return nil, err
		}
		left = exprBinary{op: op, left: left, right: right}
	}
	return left, nil
}

func (p *cmParser) parseCmp() (cmExpr, error) {
	left, err := p.parseAdd()
	if err != nil {
		return nil, err
	}
	for p.peek().kind == tokLt || p.peek().kind == tokLe || p.peek().kind == tokGt || p.peek().kind == tokGe {
		op := p.next().kind
		right, err := p.parseAdd()
		if err != nil {
			return nil, err
		}
		left = exprBinary{op: op, left: left, right: right}
	}
	return left, nil
}

func (p *cmParser) parseAdd() (cmExpr, error) {
	left, err := p.parseMul()
	if err != nil {
		return nil, err
	}
	for p.peek().kind == tokPlus || p.peek().kind == tokMinus {
		op := p.next().kind
		right, err := p.parseMul()
		if err != nil {
			return nil, err
		}
		left = exprBinary{op: op, left: left, right: right}
	}
	return left, nil
}

func (p *cmParser) parseMul() (cmExpr, error) {
	left, err := p.parseUnary()
	if err != nil {
		return nil, err
	}
	for p.peek().kind == tokStar || p.peek().kind == tokSlash || p.peek().kind == tokPercent {
		op := p.next().kind
		right, err := p.parseUnary()
		if err != nil {
			return nil, err
		}
		left = exprBinary{op: op, left: left, right: right}
	}
	return left, nil
}

func (p *cmParser) parseUnary() (cmExpr, error) {
	if p.peek().kind == tokMinus || p.peek().kind == tokBang {
		op := p.next().kind
		ex, err := p.parseUnary()
		if err != nil {
			return nil, err
		}
		return exprUnary{op: op, expr: ex}, nil
	}
	return p.parsePostfix()
}

func (p *cmParser) parsePostfix() (cmExpr, error) {
	ex, err := p.parsePrimary()
	if err != nil {
		return nil, err
	}
	for {
		switch p.peek().kind {
		case tokDot:
			p.next()
			id, err := p.expect(tokIdent, "field name")
			if err != nil {
				return nil, err
			}
			ex = exprMember{obj: ex, field: id.val}
		case tokLBracket:
			p.next()
			idx, err := p.parseExpr()
			if err != nil {
				return nil, err
			}
			if _, err := p.expect(tokRBracket, "]"); err != nil {
				return nil, err
			}
			ex = exprIndex{obj: ex, idx: idx}
		case tokLParen:
			p.next()
			var args []cmExpr
			for p.peek().kind != tokRParen && p.peek().kind != tokEOF {
				arg, err := p.parseExpr()
				if err != nil {
					return nil, err
				}
				args = append(args, arg)
				if !p.match(tokComma) {
					break
				}
			}
			if _, err := p.expect(tokRParen, ")"); err != nil {
				return nil, err
			}
			ex = exprCall{callee: ex, args: args}
		default:
			return ex, nil
		}
	}
}

func (p *cmParser) parsePrimary() (cmExpr, error) {
	t := p.next()
	switch t.kind {
	case tokNumber:
		if strings.Contains(t.val, ".") {
			f, err := strconv.ParseFloat(t.val, 64)
			if err != nil || math.IsNaN(f) || math.IsInf(f, 0) {
				return nil, fmt.Errorf("%w: invalid number %q", ErrScriptSyntax, t.val)
			}
			return exprLit{val: f}, nil
		}
		v, err := strconv.ParseInt(t.val, 10, 64)
		if err != nil {
			f, err2 := strconv.ParseFloat(t.val, 64)
			if err2 != nil {
				return nil, fmt.Errorf("%w: invalid integer %q", ErrScriptSyntax, t.val)
			}
			return exprLit{val: f}, nil
		}
		return exprLit{val: v}, nil

	case tokString:
		return exprLit{val: t.val}, nil
	case tokTrue:
		return exprLit{val: true}, nil
	case tokFalse:
		return exprLit{val: false}, nil
	case tokNull:
		return exprLit{val: nil}, nil
	case tokIdent:
		return exprIdent{name: t.val}, nil

	case tokLParen:
		ex, err := p.parseExpr()
		if err != nil {
			return nil, err
		}
		if _, err := p.expect(tokRParen, ")"); err != nil {
			return nil, err
		}
		return ex, nil

	case tokLBracket:
		var elems []cmExpr
		for p.peek().kind != tokRBracket && p.peek().kind != tokEOF {
			el, err := p.parseExpr()
			if err != nil {
				return nil, err
			}
			elems = append(elems, el)
			if !p.match(tokComma) {
				break
			}
		}
		if _, err := p.expect(tokRBracket, "]"); err != nil {
			return nil, err
		}
		return exprArray{elems: elems}, nil

	case tokLBrace:
		var fields []exprObjField
		for p.peek().kind != tokRBrace && p.peek().kind != tokEOF {
			var key string
			switch p.peek().kind {
			case tokIdent, tokString:
				key = p.next().val
			default:
				return nil, fmt.Errorf("%w: expected object key, got %q", ErrScriptSyntax, p.peek().val)
			}
			if _, err := p.expect(tokColon, ":"); err != nil {
				return nil, err
			}
			val, err := p.parseExpr()
			if err != nil {
				return nil, err
			}
			fields = append(fields, exprObjField{key: key, val: val})
			if !p.match(tokComma) {
				break
			}
		}
		if _, err := p.expect(tokRBrace, "}"); err != nil {
			return nil, err
		}
		return exprObj{fields: fields}, nil

	default:
		return nil, fmt.Errorf("%w: unexpected token %q", ErrScriptSyntax, t.val)
	}
}

type codeVM struct {
	seed           uint64
	virtualNowMs   int64
	steps          int
	maxSteps       int
	maxVars        int
	maxOutputBytes int
	env            map[string]any
	onCall         func(toolName string, args any) (val any, replayed bool, err error)
	onSleep        func(ms int64) (replayed bool, err error)
}

func (vm *codeVM) tick() error {
	vm.steps++
	if vm.steps > vm.maxSteps {
		return fmt.Errorf("%w: %d steps > %d", ErrStepQuotaExceeded, vm.steps, vm.maxSteps)
	}
	return nil
}

// nextRand implements deterministic SplitMix64 PRNG returning [0, 1).
func (vm *codeVM) nextRand() float64 {
	vm.seed += 0x9e3779b97f4a7c15
	z := vm.seed
	z = (z ^ (z >> 30)) * 0xbf58476d1ce4e5b9
	z = (z ^ (z >> 27)) * 0x94d049bb133111eb
	z = z ^ (z >> 31)
	// Map top 53 bits to [0, 1).
	return float64(z>>11) / float64(uint64(1)<<53)
}

func (vm *codeVM) setVar(name string, val any) error {
	if _, exists := vm.env[name]; !exists && len(vm.env) >= vm.maxVars {
		return fmt.Errorf("%w: variable limit %d exceeded", ErrScriptQuotaExceeded, vm.maxVars)
	}
	vm.env[name] = val
	return nil
}

func (vm *codeVM) execBlock(stmts []cmStmt) (any, bool, error) {
	for _, st := range stmts {
		if err := vm.tick(); err != nil {
			return nil, false, err
		}
		switch s := st.(type) {
		case stmtAssign:
			val, err := vm.evalExpr(s.expr)
			if err != nil {
				return nil, false, err
			}
			if err := vm.setVar(s.name, val); err != nil {
				return nil, false, err
			}
		case stmtExpr:
			if _, err := vm.evalExpr(s.expr); err != nil {
				return nil, false, err
			}
		case stmtReturn:
			if s.expr == nil {
				return nil, true, nil
			}
			val, err := vm.evalExpr(s.expr)
			if err != nil {
				return nil, false, err
			}
			return val, true, nil
		case stmtIf:
			cond, err := vm.evalExpr(s.cond)
			if err != nil {
				return nil, false, err
			}
			if isTruthy(cond) {
				v, ret, err := vm.execBlock(s.then)
				if err != nil || ret {
					return v, ret, err
				}
			} else if len(s.els) > 0 {
				v, ret, err := vm.execBlock(s.els)
				if err != nil || ret {
					return v, ret, err
				}
			}
		case stmtWhile:
			for {
				if err := vm.tick(); err != nil {
					return nil, false, err
				}
				cond, err := vm.evalExpr(s.cond)
				if err != nil {
					return nil, false, err
				}
				if !isTruthy(cond) {
					break
				}
				v, ret, err := vm.execBlock(s.body)
				if err != nil || ret {
					return v, ret, err
				}
			}
		case stmtFor:
			if s.init != nil {
				if _, ret, err := vm.execBlock([]cmStmt{s.init}); err != nil || ret {
					return nil, ret, err
				}
			}
			for {
				if err := vm.tick(); err != nil {
					return nil, false, err
				}
				cond, err := vm.evalExpr(s.cond)
				if err != nil {
					return nil, false, err
				}
				if !isTruthy(cond) {
					break
				}
				v, ret, err := vm.execBlock(s.body)
				if err != nil || ret {
					return v, ret, err
				}
				if s.post != nil {
					if _, ret, err := vm.execBlock([]cmStmt{s.post}); err != nil || ret {
						return nil, ret, err
					}
				}
			}
		}
	}
	return nil, false, nil
}

func (vm *codeVM) evalExpr(ex cmExpr) (any, error) {
	if err := vm.tick(); err != nil {
		return nil, err
	}
	switch e := ex.(type) {
	case exprLit:
		return e.val, nil
	case exprIdent:
		if e.name == "clock" {
			return map[string]any{"__clock": true}, nil
		}
		return vm.env[e.name], nil
	case exprArray:
		out := make([]any, len(e.elems))
		for i, el := range e.elems {
			v, err := vm.evalExpr(el)
			if err != nil {
				return nil, err
			}
			out[i] = v
		}
		return out, nil
	case exprObj:
		out := make(map[string]any, len(e.fields))
		for _, f := range e.fields {
			v, err := vm.evalExpr(f.val)
			if err != nil {
				return nil, err
			}
			out[f.key] = v
		}
		return out, nil
	case exprMember:
		if id, ok := e.obj.(exprIdent); ok && id.name == "clock" && e.field == "now" {
			return "clock.now", nil
		}
		obj, err := vm.evalExpr(e.obj)
		if err != nil {
			return nil, err
		}
		if m, ok := obj.(map[string]any); ok {
			return m[e.field], nil
		}
		return nil, nil
	case exprIndex:
		obj, err := vm.evalExpr(e.obj)
		if err != nil {
			return nil, err
		}
		idxVal, err := vm.evalExpr(e.idx)
		if err != nil {
			return nil, err
		}
		switch col := obj.(type) {
		case []any:
			idx, ok := toInt64(idxVal)
			if ok && idx >= 0 && int(idx) < len(col) {
				return col[idx], nil
			}
			return nil, nil
		case map[string]any:
			return col[fmt.Sprint(idxVal)], nil
		default:
			return nil, nil
		}
	case exprUnary:
		v, err := vm.evalExpr(e.expr)
		if err != nil {
			return nil, err
		}
		if e.op == tokBang {
			return !isTruthy(v), nil
		}
		if e.op == tokMinus {
			if iv, ok := toInt64(v); ok {
				return -iv, nil
			}
			if fv, ok := toFloat64(v); ok {
				return -fv, nil
			}
		}
		return nil, nil
	case exprBinary:
		if e.op == tokAnd {
			l, err := vm.evalExpr(e.left)
			if err != nil {
				return nil, err
			}
			if !isTruthy(l) {
				return false, nil
			}
			r, err := vm.evalExpr(e.right)
			if err != nil {
				return nil, err
			}
			return isTruthy(r), nil
		}
		if e.op == tokOr {
			l, err := vm.evalExpr(e.left)
			if err != nil {
				return nil, err
			}
			if isTruthy(l) {
				return l, nil
			}
			return vm.evalExpr(e.right)
		}
		l, err := vm.evalExpr(e.left)
		if err != nil {
			return nil, err
		}
		r, err := vm.evalExpr(e.right)
		if err != nil {
			return nil, err
		}
		return evalBinary(e.op, l, r)
	case exprCall:
		var fnName string
		switch c := e.callee.(type) {
		case exprIdent:
			fnName = c.name
		case exprMember:
			if id, ok := c.obj.(exprIdent); ok && id.name == "clock" && c.field == "now" {
				fnName = "clock.now"
			}
		}
		args := make([]any, len(e.args))
		for i, a := range e.args {
			v, err := vm.evalExpr(a)
			if err != nil {
				return nil, err
			}
			args[i] = v
		}
		switch fnName {
		case "clock.now":
			return vm.virtualNowMs, nil
		case "rand":
			return vm.nextRand(), nil
		case "sleep":
			var ms int64
			if len(args) > 0 {
				if v, ok := toInt64(args[0]); ok {
					ms = v
				} else if f, ok := toFloat64(args[0]); ok {
					ms = int64(f)
				}
			}
			if vm.onSleep != nil {
				_, err := vm.onSleep(ms)
				return nil, err
			}
			vm.virtualNowMs += ms
			return nil, nil
		case "call":
			if len(args) < 1 {
				return nil, fmt.Errorf("%w: call() requires tool name", ErrScriptSyntax)
			}
			toolName, ok := args[0].(string)
			if !ok {
				return nil, fmt.Errorf("%w: call() first arg must be string", ErrScriptSyntax)
			}
			var toolArg any
			if len(args) > 1 {
				toolArg = args[1]
			}
			if vm.onCall == nil {
				return nil, fmt.Errorf("%w: %s", ErrUnknownTool, toolName)
			}
			val, _, err := vm.onCall(toolName, toolArg)
			return val, err
		default:
			return nil, fmt.Errorf("%w: unknown builtin %q", ErrScriptSyntax, fnName)
		}
	}
	return nil, nil
}

func evalBinary(op cmTokenKind, l, r any) (any, error) {
	switch op {
	case tokPlus:
		_, lok := l.(string)
		_, rok := r.(string)
		if lok || rok {
			return fmt.Sprint(l) + fmt.Sprint(r), nil
		}
		if li, ok1 := toInt64(l); ok1 {
			if ri, ok2 := toInt64(r); ok2 {
				return li + ri, nil
			}
		}
		lf, ok1 := toFloat64(l)
		rf, ok2 := toFloat64(r)
		if ok1 && ok2 {
			return lf + rf, nil
		}
		return fmt.Sprint(l) + fmt.Sprint(r), nil
	case tokMinus:
		if li, ok1 := toInt64(l); ok1 {
			if ri, ok2 := toInt64(r); ok2 {
				return li - ri, nil
			}
		}
		lf, _ := toFloat64(l)
		rf, _ := toFloat64(r)
		return lf - rf, nil
	case tokStar:
		if li, ok1 := toInt64(l); ok1 {
			if ri, ok2 := toInt64(r); ok2 {
				return li * ri, nil
			}
		}
		lf, _ := toFloat64(l)
		rf, _ := toFloat64(r)
		return lf * rf, nil
	case tokSlash:
		rf, _ := toFloat64(r)
		if rf == 0 {
			return nil, fmt.Errorf("%w: division by zero", ErrScriptSyntax)
		}
		if li, ok1 := toInt64(l); ok1 {
			if ri, ok2 := toInt64(r); ok2 && li%ri == 0 {
				return li / ri, nil
			}
		}
		lf, _ := toFloat64(l)
		return lf / rf, nil
	case tokPercent:
		li, _ := toInt64(l)
		ri, _ := toInt64(r)
		if ri == 0 {
			return nil, fmt.Errorf("%w: modulo by zero", ErrScriptSyntax)
		}
		return li % ri, nil
	case tokEq:
		return valuesEqual(l, r), nil
	case tokNeq:
		return !valuesEqual(l, r), nil
	case tokLt:
		lf, _ := toFloat64(l)
		rf, _ := toFloat64(r)
		return lf < rf, nil
	case tokLe:
		lf, _ := toFloat64(l)
		rf, _ := toFloat64(r)
		return lf <= rf, nil
	case tokGt:
		lf, _ := toFloat64(l)
		rf, _ := toFloat64(r)
		return lf > rf, nil
	case tokGe:
		lf, _ := toFloat64(l)
		rf, _ := toFloat64(r)
		return lf >= rf, nil
	}
	return nil, nil
}

func isTruthy(v any) bool {
	if v == nil {
		return false
	}
	switch x := v.(type) {
	case bool:
		return x
	case int64:
		return x != 0
	case float64:
		return x != 0 && !math.IsNaN(x)
	case string:
		return x != ""
	default:
		return true
	}
}

func toInt64(v any) (int64, bool) {
	switch x := v.(type) {
	case int64:
		return x, true
	case int:
		return int64(x), true
	case float64:
		if float64(int64(x)) == x {
			return int64(x), true
		}
		return 0, false
	default:
		return 0, false
	}
}

func toFloat64(v any) (float64, bool) {
	switch x := v.(type) {
	case float64:
		return x, true
	case int64:
		return float64(x), true
	case int:
		return float64(x), true
	default:
		return 0, false
	}
}

func valuesEqual(a, b any) bool {
	if af, ok1 := toFloat64(a); ok1 {
		if bf, ok2 := toFloat64(b); ok2 {
			return af == bf
		}
	}
	return reflect.DeepEqual(a, b)
}
