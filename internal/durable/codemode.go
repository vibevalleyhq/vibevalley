package durable

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"hash/fnv"
	"math"
	"strings"
	"sync"
	"time"

	"github.com/dop251/goja"
	"github.com/dop251/goja/ast"
	"github.com/dop251/goja/file"
	"github.com/dop251/goja/token"
	"github.com/dop251/goja/unistring"

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
	defaultCodeMaxOutputBytes = 1 << 20      // 1 MiB
	defaultCodeMaxMemoryBytes = 16 << 20     // 16 MiB
	defaultCodeMaxStringBytes = 1 << 20      // 1 MiB
	defaultCodeTimeoutMs      = int64(5_000) // 5s watchdog timeout
	defaultCodeMaxCallStack   = 512
)

// CodeModeSpec configures deterministic replay execution of a Goja JavaScript script.
type CodeModeSpec struct {
	Script         string `json:"script"`
	Seed           uint64 `json:"seed"`
	StartTimeMs    int64  `json:"startTimeMs"`
	MaxSteps       int    `json:"maxSteps,omitempty"`
	MaxVars        int    `json:"maxVars,omitempty"`
	MaxOutputBytes int    `json:"maxOutputBytes,omitempty"`
	MaxMemoryBytes int64  `json:"maxMemoryBytes,omitempty"`
	MaxStringBytes int    `json:"maxStringBytes,omitempty"`
	TimeoutMs      int64  `json:"timeoutMs,omitempty"`
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

type codeToolMemoRecord struct {
	ToolName string          `json:"toolName"`
	OK       bool            `json:"ok"`
	Result   json.RawMessage `json:"result,omitempty"`
	Error    string          `json:"error,omitempty"`
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
		if out == nil {
			return TransComplete(json.RawMessage("null")), nil
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

var errVMYield = errors.New("codemode: yield")

func makeCodeExecPhase() PhaseFunc {
	return func(ctx context.Context, tc *TaskContext) (Transition, error) {
		var spec CodeModeSpec
		if err := tc.UnmarshalCheckpoint(&spec); err != nil {
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
		maxOutputBytes := spec.MaxOutputBytes
		if maxOutputBytes <= 0 {
			maxOutputBytes = defaultCodeMaxOutputBytes
		}
		maxMemoryBytes := spec.MaxMemoryBytes
		if maxMemoryBytes <= 0 {
			maxMemoryBytes = defaultCodeMaxMemoryBytes
		}
		maxStringBytes := spec.MaxStringBytes
		if maxStringBytes <= 0 {
			maxStringBytes = defaultCodeMaxStringBytes
		}
		if int64(maxStringBytes) > maxMemoryBytes {
			maxStringBytes = int(maxMemoryBytes)
		}
		timeoutMs := spec.TimeoutMs
		if timeoutMs <= 0 {
			timeoutMs = defaultCodeTimeoutMs
		}

		seed := spec.Seed
		if seed == 0 {
			seed = 0x9e3779b97f4a7c15
		}
		virtualNowMs := spec.StartTimeMs
		if virtualNowMs == 0 && tc.Task().CreatedAtMs != 0 {
			virtualNowMs = tc.Task().CreatedAtMs
		}

		memo, err := decodeMemoMap(tc.Task().MemoJSON)
		if err != nil {
			return Transition{}, err
		}

		compiled, tickIdent, chkIdent, err := compileCodeScript(spec.Script, seed, maxVars)
		if err != nil {
			return Transition{}, err
		}

		rt := goja.New()
		rt.SetMaxCallStackSize(defaultCodeMaxCallStack)

		prng := splitMix64{state: seed}
		rt.SetTimeSource(func() time.Time {
			return time.UnixMilli(virtualNowMs).UTC()
		})
		rt.SetRandSource(prng.next)

		guard := &codeGuard{
			rt:             rt,
			maxSteps:       maxSteps,
			maxVars:        maxVars,
			maxMemoryBytes: maxMemoryBytes,
			maxStringBytes: maxStringBytes,
		}

		jsonObj := rt.Get("JSON").ToObject(rt)
		jsonParseFn, _ := goja.AssertFunction(jsonObj.Get("parse"))
		jsonStringifyFn, _ := goja.AssertFunction(jsonObj.Get("stringify"))

		var callSeq int
		var sleepSeq int
		var replayedCalls int
		var replayedSleeps int
		var yieldTransition *Transition

		replayToolRecord := func(toolName string, rec codeToolMemoRecord) goja.Value {
			replayedCalls++
			if !rec.OK {
				panic(rt.NewGoError(fmt.Errorf("codemode tool %s failed: %s", toolName, rec.Error)))
			}
			v, pErr := parseJSONToJSValue(rt, jsonObj, jsonParseFn, rec.Result)
			if pErr != nil {
				guard.interrupt(pErr)
				return goja.Undefined()
			}
			return v
		}

		invokeTool := func(call goja.FunctionCall) goja.Value {
			if len(call.Arguments) < 1 {
				panic(rt.NewGoError(fmt.Errorf("%w: call() requires tool name", ErrScriptSyntax)))
			}
			nameVal := call.Arguments[0]
			if !goja.IsString(nameVal) {
				panic(rt.NewGoError(fmt.Errorf("%w: call() first arg must be string", ErrScriptSyntax)))
			}
			toolName := nameVal.String()
			if toolName == "" {
				panic(rt.NewGoError(fmt.Errorf("%w: call() tool name must be non-empty", ErrScriptSyntax)))
			}

			var toolArg any
			if len(call.Arguments) > 1 && !goja.IsUndefined(call.Arguments[1]) {
				var convErr error
				toolArg, convErr = jsValueToGoAny(rt, jsonObj, jsonStringifyFn, call.Arguments[1])
				if convErr != nil {
					rethrowGojaError(rt, convErr)
				}
			}

			callSeq++
			dedupKey := fmt.Sprintf("%s:call:%d:%s", tc.Task().ID, callSeq, toolName)

			if rawMemo, ok := memo[dedupKey]; ok {
				var rec codeToolMemoRecord
				if uErr := json.Unmarshal(rawMemo, &rec); uErr == nil && rec.ToolName == toolName {
					return replayToolRecord(toolName, rec)
				}
			}

			existing, ok, err := tc.Store().GetTaskByDedupKey(ctx, tc.Task().ID, dedupKey)
			if err != nil {
				guard.interrupt(err)
				return goja.Undefined()
			}
			if ok && existing.Status == store.TaskTerminal {
				rec := codeToolMemoRecord{ToolName: toolName}
				if existing.TerminalReason != store.ReasonCompleted {
					errMsg := existing.ErrorText
					if errMsg == "" {
						errMsg = existing.TerminalReason
					}
					rec.OK = false
					rec.Error = errMsg
				} else {
					rec.OK = true
					if len(existing.ResultJSON) > 0 {
						rec.Result = existing.ResultJSON
					} else {
						rec.Result = json.RawMessage("null")
					}
				}
				if mErr := tc.Memo(ctx, dedupKey, func() (any, error) {
					return rec, nil
				}, nil); mErr != nil {
					guard.interrupt(mErr)
					return goja.Undefined()
				}
				if encoded, mErr := json.Marshal(rec); mErr == nil {
					memo[dedupKey] = encoded
				}
				return replayToolRecord(toolName, rec)
			}

			child, _, err := tc.SpawnChild(ctx, ChildTaskSpec{
				DedupKey:   dedupKey,
				Kind:       TaskKindCodeModeTool,
				PhaseName:  PhaseCodeToolRun,
				Checkpoint: codeToolCheckpoint{ToolName: toolName, Args: toolArg},
			})
			if err != nil {
				guard.interrupt(err)
				return goja.Undefined()
			}
			tr := TransWaitTasks(PhaseCodeExec, spec, store.WaitFailFast, []string{child.ID})
			yieldTransition = &tr
			guard.interrupt(errVMYield)
			return goja.Undefined()
		}

		invokeSleep := func(call goja.FunctionCall) goja.Value {
			var ms int64
			if len(call.Arguments) > 0 && !goja.IsUndefined(call.Arguments[0]) {
				f := call.Arguments[0].ToFloat()
				if math.IsNaN(f) || f < 0 {
					ms = 0
				} else if math.IsInf(f, 1) || f >= float64(math.MaxInt64/int64(time.Millisecond)) {
					panicNewJSError(rt, "RangeError", "sleep duration overflow")
				} else {
					ms = int64(f)
				}
			}
			sleepSeq++
			sleepKey := fmt.Sprintf("__cm_sleep_%d", sleepSeq)
			if _, done := memo[sleepKey]; done {
				virtualNowMs += ms
				replayedSleeps++
				return goja.Undefined()
			}
			opts := SleepOptions{WakeAfter: time.Duration(ms) * time.Millisecond}
			if ms <= 0 {
				// Ensure 0ms sleeps still wake immediately instead of sleeping indefinitely.
				opts = SleepOptions{WakeUntilMs: tc.Clock().NowMs()}
			}
			tr := TransSleep(PhaseCodeSleepWake, codeSleepCheckpoint{
				Spec:     spec,
				SleepKey: sleepKey,
				SleepMs:  ms,
			}, opts)
			yieldTransition = &tr
			guard.interrupt(errVMYield)
			return goja.Undefined()
		}

		nowFn := func(goja.FunctionCall) goja.Value {
			return rt.ToValue(virtualNowMs)
		}
		randFn := func(goja.FunctionCall) goja.Value {
			return rt.ToValue(prng.next())
		}

		vibeObj := rt.NewObject()
		_ = vibeObj.Set("call", invokeTool)
		_ = vibeObj.Set("sleep", invokeSleep)
		_ = vibeObj.Set("now", nowFn)
		_ = vibeObj.Set("random", randFn)

		clockObj := rt.NewObject()
		_ = clockObj.Set("now", nowFn)

		_ = rt.Set("callTool", invokeTool)
		_ = rt.Set("call", invokeTool)
		_ = rt.Set("sleep", invokeSleep)
		_ = rt.Set("rand", randFn)
		_ = rt.Set("clock", clockObj)
		_ = rt.Set("vibe", vibeObj)

		installAllocationGuards(rt, guard, jsonObj, jsonStringifyFn)
		installDynamicEvalGuards(rt, guard, tickIdent, chkIdent)

		if err := rt.GlobalObject().DefineDataProperty(
			tickIdent,
			rt.ToValue(guard.tickFunc()),
			goja.FLAG_FALSE,
			goja.FLAG_FALSE,
			goja.FLAG_FALSE,
		); err != nil {
			return Transition{}, err
		}
		if err := rt.GlobalObject().DefineDataProperty(
			chkIdent,
			rt.ToValue(guard.checkValueFunc()),
			goja.FLAG_FALSE,
			goja.FLAG_FALSE,
			goja.FLAG_FALSE,
		); err != nil {
			return Transition{}, err
		}
		guard.initialGlobalKeys = len(rt.GlobalObject().Keys())

		watchdog := time.AfterFunc(time.Duration(timeoutMs)*time.Millisecond, func() {
			guard.interrupt(fmt.Errorf("%w: execution exceeded %dms", ErrScriptTimeout, timeoutMs))
		})
		defer watchdog.Stop()

		stopCtx := context.AfterFunc(ctx, func() {
			if err := ctx.Err(); err != nil {
				guard.interrupt(err)
			} else {
				guard.interrupt(context.Canceled)
			}
		})
		defer stopCtx()

		val, runErr := rt.RunProgram(compiled)
		watchdog.Stop()
		stopCtx()

		if runErr != nil {
			var intErr *goja.InterruptedError
			if errors.As(runErr, &intErr) {
				cause := guard.cause()
				if cause == nil {
					cause = intErr.Unwrap()
				}
				if errors.Is(cause, errVMYield) && yieldTransition != nil {
					return *yieldTransition, nil
				}
				if cause != nil {
					return Transition{}, cause
				}
				return Transition{}, intErr
			}
			var stackErr *goja.StackOverflowError
			if errors.As(runErr, &stackErr) {
				return Transition{}, fmt.Errorf("%w: %v", ErrScriptQuotaExceeded, stackErr)
			}
			return Transition{}, runErr
		}

		if maxVars > 0 {
			if added := len(rt.GlobalObject().Keys()) - guard.initialGlobalKeys; added > maxVars {
				return Transition{}, fmt.Errorf("%w: global variable limit %d exceeded (%d)", ErrScriptQuotaExceeded, maxVars, added)
			}
		}

		retVal, err := jsValueToGoAny(rt, jsonObj, jsonStringifyFn, val)
		if err != nil {
			return Transition{}, err
		}
		encoded, err := json.Marshal(retVal)
		if err != nil {
			return Transition{}, err
		}
		if len(encoded) > maxOutputBytes {
			return Transition{}, fmt.Errorf("%w: result size %d > %d", ErrScriptQuotaExceeded, len(encoded), maxOutputBytes)
		}

		return TransComplete(CodeModeResult{
			Value:          retVal,
			ExecutedSteps:  guard.steps,
			ReplayedCalls:  replayedCalls,
			ReplayedSleeps: replayedSleeps,
			VirtualNowMs:   virtualNowMs,
		}), nil
	}
}

type splitMix64 struct {
	state uint64
}

// next implements deterministic SplitMix64 PRNG returning [0, 1).
func (s *splitMix64) next() float64 {
	s.state += 0x9e3779b97f4a7c15
	z := s.state
	z = (z ^ (z >> 30)) * 0xbf58476d1ce4e5b9
	z = (z ^ (z >> 27)) * 0x94d049bb133111eb
	z = z ^ (z >> 31)
	return float64(z>>11) / float64(uint64(1)<<53)
}

type codeGuard struct {
	rt                *goja.Runtime
	steps             int
	maxSteps          int
	maxVars           int
	initialGlobalKeys int
	allocBytes        int64
	maxMemoryBytes    int64
	maxStringBytes    int

	mu           sync.Mutex
	interruptErr error
}

func (g *codeGuard) interrupt(err error) {
	if err == nil {
		return
	}
	g.mu.Lock()
	first := g.interruptErr == nil
	if first {
		g.interruptErr = err
	}
	g.mu.Unlock()
	if first {
		g.rt.Interrupt(err)
	}
}

func (g *codeGuard) cause() error {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.interruptErr
}

func (g *codeGuard) tickFunc() func(goja.FunctionCall) goja.Value {
	return func(goja.FunctionCall) goja.Value {
		g.steps++
		if g.steps > g.maxSteps {
			g.interrupt(fmt.Errorf("%w: %d steps > %d", ErrStepQuotaExceeded, g.steps, g.maxSteps))
			return goja.Undefined()
		}
		if g.maxVars > 0 && g.steps&15 == 0 {
			added := len(g.rt.GlobalObject().Keys()) - g.initialGlobalKeys
			if added > g.maxVars {
				g.interrupt(fmt.Errorf("%w: global variable limit %d exceeded (%d)", ErrScriptQuotaExceeded, g.maxVars, added))
			}
		}
		return goja.Undefined()
	}
}

func (g *codeGuard) checkValueFunc() func(goja.FunctionCall) goja.Value {
	return func(call goja.FunctionCall) goja.Value {
		if len(call.Arguments) == 0 {
			return goja.Undefined()
		}
		v := call.Arguments[0]
		if s, ok := v.(goja.String); ok {
			g.checkStringLen(int64(s.Length()))
		}
		return v
	}
}

func (g *codeGuard) checkStringLen(n int64) bool {
	if n <= 0 {
		return true
	}
	if n > int64(g.maxStringBytes) {
		g.interrupt(fmt.Errorf("%w: string length %d > %d", ErrScriptQuotaExceeded, n, g.maxStringBytes))
		return false
	}
	return g.charge(n)
}

func (g *codeGuard) charge(n int64) bool {
	if n <= 0 {
		return true
	}
	if n > g.maxMemoryBytes-g.allocBytes {
		g.interrupt(fmt.Errorf("%w: memory quota exceeded (%d + %d > %d)", ErrScriptQuotaExceeded, g.allocBytes, n, g.maxMemoryBytes))
		return false
	}
	g.allocBytes += n
	return true
}

func installAllocationGuards(rt *goja.Runtime, guard *codeGuard, jsonObj *goja.Object, jsonStringifyFn goja.Callable) {
	wrapProtoMethod := func(proto *goja.Object, name string, wrapper func(orig goja.Callable, call goja.FunctionCall) goja.Value) {
		if proto == nil {
			return
		}
		origVal := proto.Get(name)
		origFn, ok := goja.AssertFunction(origVal)
		if !ok {
			return
		}
		origObj := origVal.ToObject(rt)
		proxy := rt.NewProxy(origObj, &goja.ProxyTrapConfig{
			Apply: func(_ *goja.Object, this goja.Value, args []goja.Value) goja.Value {
				return wrapper(origFn, goja.FunctionCall{This: this, Arguments: args})
			},
		})
		_ = proto.Set(name, proxy)
	}

	strProto := rt.Get("String").ToObject(rt).Get("prototype").ToObject(rt)
	wrapProtoMethod(strProto, "repeat", func(orig goja.Callable, call goja.FunctionCall) goja.Value {
		if len(call.Arguments) > 0 && !goja.IsUndefined(call.This) && !goja.IsNull(call.This) {
			thisStr := call.This.ToString()
			sLen := jsValueStrLen(thisStr)
			cnt := call.Arguments[0].ToFloat()
			if cnt > 0 && !math.IsNaN(cnt) {
				if math.IsInf(cnt, 1) || cnt > float64(guard.maxStringBytes) {
					guard.interrupt(fmt.Errorf("%w: repeat count exceeds quota", ErrScriptQuotaExceeded))
					return goja.Undefined()
				}
				c := int64(cnt)
				if sLen > 0 && c > int64(guard.maxStringBytes)/sLen {
					guard.interrupt(fmt.Errorf("%w: string repeat exceeds quota", ErrScriptQuotaExceeded))
					return goja.Undefined()
				}
				if !guard.checkStringLen(sLen * c) {
					return goja.Undefined()
				}
			}
			res, err := orig(thisStr, rt.ToValue(cnt))
			if err != nil {
				rethrowGojaError(rt, err)
			}
			return res
		}
		res, err := orig(call.This, call.Arguments...)
		if err != nil {
			rethrowGojaError(rt, err)
		}
		return res
	})

	padGuard := func(orig goja.Callable, call goja.FunctionCall) goja.Value {
		if len(call.Arguments) > 0 && !goja.IsUndefined(call.This) && !goja.IsNull(call.This) {
			thisStr := call.This.ToString()
			target := call.Arguments[0].ToFloat()
			if target > 0 && !math.IsNaN(target) {
				if math.IsInf(target, 1) || target > float64(guard.maxStringBytes) {
					guard.interrupt(fmt.Errorf("%w: string pad exceeds quota", ErrScriptQuotaExceeded))
					return goja.Undefined()
				}
				if !guard.checkStringLen(int64(target)) {
					return goja.Undefined()
				}
			}
			args := append([]goja.Value(nil), call.Arguments...)
			args[0] = rt.ToValue(target)
			if len(args) > 1 && !goja.IsUndefined(args[1]) {
				args[1] = args[1].ToString()
			}
			res, err := orig(thisStr, args...)
			if err != nil {
				rethrowGojaError(rt, err)
			}
			return res
		}
		res, err := orig(call.This, call.Arguments...)
		if err != nil {
			rethrowGojaError(rt, err)
		}
		return res
	}
	wrapProtoMethod(strProto, "padStart", padGuard)
	wrapProtoMethod(strProto, "padEnd", padGuard)

	wrapProtoMethod(strProto, "concat", func(orig goja.Callable, call goja.FunctionCall) goja.Value {
		if !goja.IsUndefined(call.This) && !goja.IsNull(call.This) {
			thisStr := call.This.ToString()
			total := jsValueStrLen(thisStr)
			args := make([]goja.Value, len(call.Arguments))
			for i, a := range call.Arguments {
				s := a.ToString()
				args[i] = s
				total += jsValueStrLen(s)
				if total > int64(guard.maxStringBytes) {
					guard.interrupt(fmt.Errorf("%w: string concat exceeds quota", ErrScriptQuotaExceeded))
					return goja.Undefined()
				}
			}
			if !guard.checkStringLen(total) {
				return goja.Undefined()
			}
			res, err := orig(thisStr, args...)
			if err != nil {
				rethrowGojaError(rt, err)
			}
			return res
		}
		res, err := orig(call.This, call.Arguments...)
		if err != nil {
			rethrowGojaError(rt, err)
		}
		return res
	})

	arrProto := rt.Get("Array").ToObject(rt).Get("prototype").ToObject(rt)
	wrapProtoMethod(arrProto, "join", func(orig goja.Callable, call goja.FunctionCall) goja.Value {
		args := call.Arguments
		if obj, ok := call.This.(*goja.Object); ok {
			length := obj.Get("length").ToInteger()
			if length > int64(guard.maxStringBytes)+1 {
				guard.interrupt(fmt.Errorf("%w: array join length %d exceeds quota", ErrScriptQuotaExceeded, length))
				return goja.Undefined()
			}
			if len(args) > 0 && !goja.IsUndefined(args[0]) {
				sep := args[0].ToString()
				sepLen := jsValueStrLen(sep)
				if length > 1 && sepLen > 0 && length-1 > int64(guard.maxStringBytes)/sepLen {
					guard.interrupt(fmt.Errorf("%w: array join size exceeds quota", ErrScriptQuotaExceeded))
					return goja.Undefined()
				}
				args = append([]goja.Value(nil), args...)
				args[0] = sep
			}
		}
		res, err := orig(call.This, args...)
		if err != nil {
			rethrowGojaError(rt, err)
		}
		if s, ok := res.(goja.String); ok {
			if !guard.checkStringLen(int64(s.Length())) {
				return goja.Undefined()
			}
		}
		return res
	})

	wrapProtoMethod(arrProto, "fill", func(orig goja.Callable, call goja.FunctionCall) goja.Value {
		if obj, ok := call.This.(*goja.Object); ok {
			length := obj.Get("length").ToInteger()
			if length > 0 && !guard.charge(length*16) {
				return goja.Undefined()
			}
		}
		res, err := orig(call.This, call.Arguments...)
		if err != nil {
			rethrowGojaError(rt, err)
		}
		return res
	})

	for _, name := range []string{"push", "unshift", "concat", "splice"} {
		wrapProtoMethod(arrProto, name, func(orig goja.Callable, call goja.FunctionCall) goja.Value {
			if !guard.charge(int64(len(call.Arguments)+1) * 16) {
				return goja.Undefined()
			}
			res, err := orig(call.This, call.Arguments...)
			if err != nil {
				rethrowGojaError(rt, err)
			}
			return res
		})
	}

	// Guard ArrayBuffer and ArrayBuffer.prototype methods.
	abVal := rt.Get("ArrayBuffer")
	abCtor, _ := abVal.(*goja.Object)
	if abCtor != nil {
		abProto := abCtor.Get("prototype").ToObject(rt)
		for _, m := range []string{"slice", "transfer", "transferToFixedLength", "resize"} {
			wrapProtoMethod(abProto, m, func(orig goja.Callable, call goja.FunctionCall) goja.Value {
				if obj, ok := call.This.(*goja.Object); ok {
					sz := obj.Get("byteLength").ToInteger()
					if len(call.Arguments) > 0 && !goja.IsUndefined(call.Arguments[0]) {
						arg0 := call.Arguments[0].ToInteger()
						if m == "resize" || m == "transfer" || m == "transferToFixedLength" {
							sz = arg0
						}
					}
					if sz > 0 && !guard.charge(sz) {
						return goja.Undefined()
					}
				}
				res, err := orig(call.This, call.Arguments...)
				if err != nil {
					rethrowGojaError(rt, err)
				}
				return res
			})
		}

		abProxy := rt.NewProxy(abCtor, &goja.ProxyTrapConfig{
			Construct: func(target *goja.Object, args []goja.Value, _ *goja.Object) *goja.Object {
				if len(args) > 0 {
					n := args[0].ToFloat()
					if n > 0 && !math.IsNaN(n) {
						if math.IsInf(n, 1) || n > float64(guard.maxMemoryBytes) {
							guard.interrupt(fmt.Errorf("%w: ArrayBuffer size exceeds quota", ErrScriptQuotaExceeded))
							return rt.NewObject()
						}
						if !guard.charge(int64(n)) {
							return rt.NewObject()
						}
					}
					args = append([]goja.Value(nil), args...)
					args[0] = rt.ToValue(n)
				}
				obj, err := rt.New(target, args...)
				if err != nil {
					rethrowGojaError(rt, err)
				}
				return obj
			},
		})
		_ = rt.Set("ArrayBuffer", abProxy)
	}

	// Guard TypedArrays (Uint8Array, Float64Array, etc.).
	typedArrays := []struct {
		name     string
		elemSize int64
	}{
		{"Int8Array", 1},
		{"Uint8Array", 1},
		{"Uint8ClampedArray", 1},
		{"Int16Array", 2},
		{"Uint16Array", 2},
		{"Float16Array", 2},
		{"Int32Array", 4},
		{"Uint32Array", 4},
		{"Float32Array", 4},
		{"Float64Array", 8},
		{"BigInt64Array", 8},
		{"BigUint64Array", 8},
	}
	for _, ta := range typedArrays {
		taVal := rt.Get(ta.name)
		taCtor, ok := taVal.(*goja.Object)
		if !ok || taCtor == nil {
			continue
		}
		elemSize := ta.elemSize
		taProxy := rt.NewProxy(taCtor, &goja.ProxyTrapConfig{
			Construct: func(target *goja.Object, args []goja.Value, _ *goja.Object) *goja.Object {
				if len(args) > 0 {
					var chargeBytes int64
					if goja.IsNumber(args[0]) {
						n := args[0].ToFloat()
						if n > 0 && !math.IsNaN(n) {
							if math.IsInf(n, 1) || n > float64(guard.maxMemoryBytes/elemSize) {
								guard.interrupt(fmt.Errorf("%w: TypedArray size exceeds quota", ErrScriptQuotaExceeded))
								return rt.NewObject()
							}
							chargeBytes = int64(n) * elemSize
						}
					} else if abCtor == nil || !rt.InstanceOf(args[0], abCtor) {
						if o, isObj := args[0].(*goja.Object); isObj {
							l := o.Get("length").ToInteger()
							if l > 0 {
								if l > guard.maxMemoryBytes/elemSize {
									guard.interrupt(fmt.Errorf("%w: TypedArray size exceeds quota", ErrScriptQuotaExceeded))
									return rt.NewObject()
								}
								chargeBytes = l * elemSize
							}
						}
					}
					if chargeBytes > 0 && !guard.charge(chargeBytes) {
						return rt.NewObject()
					}
				}
				obj, err := rt.New(target, args...)
				if err != nil {
					rethrowGojaError(rt, err)
				}
				return obj
			},
		})
		_ = rt.Set(ta.name, taProxy)
	}

	// Guard Array(...) / new Array(...).
	if arrCtor, ok := rt.Get("Array").(*goja.Object); ok && arrCtor != nil {
		checkArrArgs := func(args []goja.Value) bool {
			if len(args) > 1 {
				return guard.charge(int64(len(args)) * 16)
			}
			return true
		}
		arrProxy := rt.NewProxy(arrCtor, &goja.ProxyTrapConfig{
			Apply: func(target *goja.Object, _ goja.Value, args []goja.Value) goja.Value {
				if !checkArrArgs(args) {
					return goja.Undefined()
				}
				obj, err := rt.New(target, args...)
				if err != nil {
					rethrowGojaError(rt, err)
				}
				return obj
			},
			Construct: func(target *goja.Object, args []goja.Value, _ *goja.Object) *goja.Object {
				if !checkArrArgs(args) {
					return rt.NewObject()
				}
				obj, err := rt.New(target, args...)
				if err != nil {
					rethrowGojaError(rt, err)
				}
				return obj
			},
		})
		_ = rt.Set("Array", arrProxy)
	}

	// Guard JSON.stringify output length.
	if jsonStringifyFn != nil {
		origStringifyObj := jsonObj.Get("stringify").ToObject(rt)
		stringifyProxy := rt.NewProxy(origStringifyObj, &goja.ProxyTrapConfig{
			Apply: func(_ *goja.Object, this goja.Value, args []goja.Value) goja.Value {
				res, err := jsonStringifyFn(this, args...)
				if err != nil {
					rethrowGojaError(rt, err)
				}
				if s, ok := res.(goja.String); ok {
					if !guard.checkStringLen(int64(s.Length())) {
						return goja.Undefined()
					}
				}
				return res
			},
		})
		_ = jsonObj.Set("stringify", stringifyProxy)
	}
}

func jsValueStrLen(v goja.Value) int64 {
	if s, ok := v.(goja.String); ok {
		return int64(s.Length())
	}
	if s, ok := v.ToString().(goja.String); ok {
		return int64(s.Length())
	}
	return int64(len(v.String()))
}

func panicNewJSError(rt *goja.Runtime, ctorName, msg string) {
	if ctor := rt.Get(ctorName); ctor != nil && !goja.IsUndefined(ctor) {
		if obj, err := rt.New(ctor, rt.ToValue(msg)); err == nil {
			panic(obj)
		}
	}
	panic(rt.NewTypeError(msg))
}

func rethrowGojaError(rt *goja.Runtime, err error) {
	if err == nil {
		return
	}
	var ex *goja.Exception
	if errors.As(err, &ex) {
		panic(ex)
	}
	var intErr *goja.InterruptedError
	if errors.As(err, &intErr) {
		panic(intErr)
	}
	var stackErr *goja.StackOverflowError
	if errors.As(err, &stackErr) {
		panic(stackErr)
	}
	panic(rt.NewGoError(err))
}

func installDynamicEvalGuards(rt *goja.Runtime, guard *codeGuard, tickIdent, chkIdent string) {
	syntaxErrCtor := rt.Get("SyntaxError")
	throwSyntax := func(err error) {
		if obj, nErr := rt.New(syntaxErrCtor, rt.ToValue(err.Error())); nErr == nil {
			panic(obj)
		}
		panic(rt.NewGoError(err))
	}

	compileAndInstrument := func(src string) *goja.Program {
		prg, err := goja.Parse("eval.js", src)
		if err != nil {
			throwSyntax(err)
		}
		instrumentProgramAST(prg, tickIdent, chkIdent)
		compiled, err := goja.CompileAST(prg, false)
		if err != nil {
			throwSyntax(err)
		}
		return compiled
	}

	evalFn := func(call goja.FunctionCall) goja.Value {
		if len(call.Arguments) == 0 {
			return goja.Undefined()
		}
		srcStr, ok := call.Arguments[0].(goja.String)
		if !ok {
			return call.Arguments[0]
		}
		compiled := compileAndInstrument(srcStr.String())
		res, err := rt.RunProgram(compiled)
		if err != nil {
			rethrowGojaError(rt, err)
		}
		return res
	}
	_ = rt.Set("eval", evalFn)

	origFuncCtor, ok := rt.Get("Function").(*goja.Object)
	if !ok || origFuncCtor == nil {
		return
	}
	buildDynamicFuncWithPrefix := func(prefix string, args []goja.Value) goja.Value {
		var params []string
		body := ""
		if len(args) > 0 {
			body = args[len(args)-1].ToString().String()
			for i := 0; i < len(args)-1; i++ {
				params = append(params, args[i].ToString().String())
			}
		}
		fnSrc := "(" + prefix + "(" + strings.Join(params, ",") + ") {\n" + body + "\n})"
		compiled := compileAndInstrument(fnSrc)
		res, err := rt.RunProgram(compiled)
		if err != nil {
			rethrowGojaError(rt, err)
		}
		return res
	}
	wrapFuncCtor := func(orig *goja.Object, prefix string) goja.Proxy {
		return rt.NewProxy(orig, &goja.ProxyTrapConfig{
			Apply: func(_ *goja.Object, _ goja.Value, args []goja.Value) goja.Value {
				return buildDynamicFuncWithPrefix(prefix, args)
			},
			Construct: func(_ *goja.Object, args []goja.Value, _ *goja.Object) *goja.Object {
				v := buildDynamicFuncWithPrefix(prefix, args)
				return v.ToObject(rt)
			},
		})
	}
	funcProxy := wrapFuncCtor(origFuncCtor, "function")
	_ = rt.Set("Function", funcProxy)
	if fnProto, ok := origFuncCtor.Get("prototype").(*goja.Object); ok && fnProto != nil {
		_ = fnProto.Set("constructor", funcProxy)
	}
	for _, spec := range []struct {
		probe  string
		prefix string
	}{
		{"(function*(){}).constructor", "function*"},
		{"(async function(){}).constructor", "async function"},
		{"(async function*(){}).constructor", "async function*"},
	} {
		if ctorVal, err := rt.RunString(spec.probe); err == nil {
			if ctorObj, ok := ctorVal.(*goja.Object); ok && ctorObj != nil {
				if proto, ok := ctorObj.Get("prototype").(*goja.Object); ok && proto != nil {
					_ = proto.Set("constructor", wrapFuncCtor(ctorObj, spec.prefix))
				}
			}
		}
	}
}

func jsValueToGoAny(rt *goja.Runtime, jsonObj *goja.Object, jsonStringifyFn goja.Callable, val goja.Value) (any, error) {
	if val == nil || goja.IsUndefined(val) || goja.IsNull(val) {
		return nil, nil
	}
	if goja.IsNaN(val) || goja.IsInfinity(val) {
		return nil, nil
	}
	if obj, ok := val.(*goja.Object); ok {
		raw, err := obj.MarshalJSON()
		if err != nil {
			return nil, err
		}
		var out any
		if err := json.Unmarshal(raw, &out); err != nil {
			return nil, err
		}
		return out, nil
	}
	if goja.IsBigInt(val) {
		if jsonStringifyFn != nil {
			if _, err := jsonStringifyFn(jsonObj, val); err != nil {
				return nil, err
			}
		}
		return nil, fmt.Errorf("%w: cannot serialize BigInt to JSON", ErrScriptSyntax)
	}
	return val.Export(), nil
}

func parseJSONToJSValue(rt *goja.Runtime, jsonObj *goja.Object, jsonParseFn goja.Callable, raw []byte) (goja.Value, error) {
	trimmed := strings.TrimSpace(string(raw))
	if trimmed == "" || trimmed == "null" {
		return goja.Null(), nil
	}
	if jsonParseFn == nil {
		var v any
		if err := json.Unmarshal(raw, &v); err != nil {
			return nil, err
		}
		return rt.ToValue(v), nil
	}
	return jsonParseFn(jsonObj, rt.ToValue(trimmed))
}

// --- AST Parsing & Deterministic Quota / Memory Instrumentation ---

func compileCodeScript(src string, seed uint64, maxVars int) (compiled *goja.Program, tickIdent string, chkIdent string, err error) {
	prg, err := goja.Parse("codemode.js", src)
	if err != nil && strings.Contains(err.Error(), "Illegal return statement") {
		wrapped := "(function() {\n" + src + "\n})()"
		prg, err = goja.Parse("codemode.js", wrapped)
	}
	if err != nil {
		return nil, "", "", fmt.Errorf("%w: %v", ErrScriptSyntax, err)
	}

	seen, varCount := collectASTIdentsAndVars(prg)
	if maxVars > 0 && varCount > maxVars {
		return nil, "", "", fmt.Errorf("%w: variable limit %d exceeded (%d declared)", ErrScriptQuotaExceeded, maxVars, varCount)
	}

	h := fnv.New64a()
	_, _ = h.Write([]byte(src))
	tag := h.Sum64() ^ seed

	tickIdent = pickFreshIdent(seen, fmt.Sprintf("__vv_tick_%x", tag))
	chkIdent = pickFreshIdent(seen, fmt.Sprintf("__vv_chk_%x", tag))

	instrumentProgramAST(prg, tickIdent, chkIdent)

	compiled, err = goja.CompileAST(prg, false)
	if err != nil {
		return nil, "", "", fmt.Errorf("%w: %v", ErrScriptSyntax, err)
	}
	return compiled, tickIdent, chkIdent, nil
}

func pickFreshIdent(seen map[string]bool, base string) string {
	if !seen[base] {
		seen[base] = true
		return base
	}
	for i := 0; ; i++ {
		cand := fmt.Sprintf("%s_%d", base, i)
		if !seen[cand] {
			seen[cand] = true
			return cand
		}
	}
}

func collectASTIdentsAndVars(prg *ast.Program) (map[string]bool, int) {
	seen := make(map[string]bool)
	var varCount int

	recordIdent := func(id *ast.Identifier) {
		if id != nil {
			seen[id.Name.String()] = true
		}
	}

	var scanPattern func(p ast.Expression, isDecl bool)
	var scanExpr func(ex ast.Expression)
	var scanStmt func(st ast.Statement)
	var scanStmts func(stmts []ast.Statement)

	scanPattern = func(p ast.Expression, isDecl bool) {
		if p == nil {
			return
		}
		switch node := p.(type) {
		case *ast.Identifier:
			recordIdent(node)
			if isDecl {
				varCount++
			}
		case *ast.Binding:
			scanPattern(node.Target, isDecl)
			scanExpr(node.Initializer)
		case *ast.ArrayPattern:
			for _, el := range node.Elements {
				scanPattern(el, isDecl)
			}
			scanPattern(node.Rest, isDecl)
		case *ast.ObjectPattern:
			for _, prop := range node.Properties {
				switch pr := prop.(type) {
				case *ast.PropertyShort:
					recordIdent(&pr.Name)
					if isDecl {
						varCount++
					}
					scanExpr(pr.Initializer)
				case *ast.PropertyKeyed:
					if pr.Computed {
						scanExpr(pr.Key)
					} else if id, ok := pr.Key.(*ast.Identifier); ok {
						recordIdent(id)
					}
					scanPattern(pr.Value, isDecl)
				case *ast.SpreadElement:
					scanPattern(pr.Expression, isDecl)
				}
			}
			scanPattern(node.Rest, isDecl)
		default:
			scanExpr(p)
		}
	}

	scanFunc := func(fn *ast.FunctionLiteral) {
		if fn == nil {
			return
		}
		recordIdent(fn.Name)
		if fn.ParameterList != nil {
			for _, b := range fn.ParameterList.List {
				scanPattern(b, true)
			}
			if fn.ParameterList.Rest != nil {
				scanPattern(fn.ParameterList.Rest, true)
			}
		}
		if fn.Body != nil {
			scanStmt(fn.Body)
		}
	}

	scanClass := func(cl *ast.ClassLiteral) {
		if cl == nil {
			return
		}
		recordIdent(cl.Name)
		scanExpr(cl.SuperClass)
		for _, el := range cl.Body {
			switch e := el.(type) {
			case *ast.FieldDefinition:
				scanExpr(e.Key)
				scanExpr(e.Initializer)
			case *ast.MethodDefinition:
				scanExpr(e.Key)
				scanFunc(e.Body)
			case *ast.ClassStaticBlock:
				scanStmt(e.Block)
			}
		}
	}

	scanExpr = func(ex ast.Expression) {
		if ex == nil {
			return
		}
		switch e := ex.(type) {
		case *ast.Identifier:
			recordIdent(e)
		case *ast.ArrayLiteral:
			for _, v := range e.Value {
				scanExpr(v)
			}
		case *ast.ObjectLiteral:
			for _, prop := range e.Value {
				switch pr := prop.(type) {
				case *ast.PropertyShort:
					recordIdent(&pr.Name)
					scanExpr(pr.Initializer)
				case *ast.PropertyKeyed:
					scanExpr(pr.Key)
					scanExpr(pr.Value)
				case *ast.SpreadElement:
					scanExpr(pr.Expression)
				}
			}
		case *ast.AssignExpression:
			scanExpr(e.Left)
			scanExpr(e.Right)
		case *ast.BinaryExpression:
			scanExpr(e.Left)
			scanExpr(e.Right)
		case *ast.BracketExpression:
			scanExpr(e.Left)
			scanExpr(e.Member)
		case *ast.CallExpression:
			scanExpr(e.Callee)
			for _, a := range e.ArgumentList {
				scanExpr(a)
			}
		case *ast.NewExpression:
			scanExpr(e.Callee)
			for _, a := range e.ArgumentList {
				scanExpr(a)
			}
		case *ast.ConditionalExpression:
			scanExpr(e.Test)
			scanExpr(e.Consequent)
			scanExpr(e.Alternate)
		case *ast.DotExpression:
			scanExpr(e.Left)
			recordIdent(&e.Identifier)
		case *ast.PrivateDotExpression:
			scanExpr(e.Left)
		case *ast.OptionalChain:
			scanExpr(e.Expression)
		case *ast.Optional:
			scanExpr(e.Expression)
		case *ast.FunctionLiteral:
			scanFunc(e)
		case *ast.ClassLiteral:
			scanClass(e)
		case *ast.ArrowFunctionLiteral:
			if e.ParameterList != nil {
				for _, b := range e.ParameterList.List {
					scanPattern(b, true)
				}
				if e.ParameterList.Rest != nil {
					scanPattern(e.ParameterList.Rest, true)
				}
			}
			switch b := e.Body.(type) {
			case *ast.BlockStatement:
				scanStmt(b)
			case *ast.ExpressionBody:
				scanExpr(b.Expression)
			}
		case *ast.SequenceExpression:
			for _, item := range e.Sequence {
				scanExpr(item)
			}
		case *ast.TemplateLiteral:
			scanExpr(e.Tag)
			for _, item := range e.Expressions {
				scanExpr(item)
			}
		case *ast.UnaryExpression:
			scanExpr(e.Operand)
		case *ast.YieldExpression:
			scanExpr(e.Argument)
		case *ast.AwaitExpression:
			scanExpr(e.Argument)
		case *ast.SpreadElement:
			scanExpr(e.Expression)
		case *ast.Binding:
			scanPattern(e, false)
		case *ast.ArrayPattern:
			scanPattern(e, false)
		case *ast.ObjectPattern:
			scanPattern(e, false)
		}
	}

	scanStmt = func(st ast.Statement) {
		if st == nil {
			return
		}
		switch s := st.(type) {
		case *ast.BlockStatement:
			scanStmts(s.List)
		case *ast.BranchStatement:
			recordIdent(s.Label)
		case *ast.CaseStatement:
			scanExpr(s.Test)
			scanStmts(s.Consequent)
		case *ast.CatchStatement:
			scanPattern(s.Parameter, true)
			scanStmt(s.Body)
		case *ast.DoWhileStatement:
			scanStmt(s.Body)
			scanExpr(s.Test)
		case *ast.ExpressionStatement:
			scanExpr(s.Expression)
		case *ast.ForInStatement:
			switch into := s.Into.(type) {
			case *ast.ForIntoVar:
				scanPattern(into.Binding, true)
			case *ast.ForDeclaration:
				scanPattern(into.Target, true)
			case *ast.ForIntoExpression:
				scanExpr(into.Expression)
			}
			scanExpr(s.Source)
			scanStmt(s.Body)
		case *ast.ForOfStatement:
			switch into := s.Into.(type) {
			case *ast.ForIntoVar:
				scanPattern(into.Binding, true)
			case *ast.ForDeclaration:
				scanPattern(into.Target, true)
			case *ast.ForIntoExpression:
				scanExpr(into.Expression)
			}
			scanExpr(s.Source)
			scanStmt(s.Body)
		case *ast.ForStatement:
			switch init := s.Initializer.(type) {
			case *ast.ForLoopInitializerExpression:
				scanExpr(init.Expression)
			case *ast.ForLoopInitializerVarDeclList:
				for _, b := range init.List {
					scanPattern(b, true)
				}
			case *ast.ForLoopInitializerLexicalDecl:
				for _, b := range init.LexicalDeclaration.List {
					scanPattern(b, true)
				}
			}
			scanExpr(s.Test)
			scanExpr(s.Update)
			scanStmt(s.Body)
		case *ast.IfStatement:
			scanExpr(s.Test)
			scanStmt(s.Consequent)
			scanStmt(s.Alternate)
		case *ast.LabelledStatement:
			recordIdent(s.Label)
			scanStmt(s.Statement)
		case *ast.ReturnStatement:
			scanExpr(s.Argument)
		case *ast.SwitchStatement:
			scanExpr(s.Discriminant)
			for _, cs := range s.Body {
				scanStmt(cs)
			}
		case *ast.ThrowStatement:
			scanExpr(s.Argument)
		case *ast.TryStatement:
			scanStmt(s.Body)
			if s.Catch != nil {
				scanStmt(s.Catch)
			}
			if s.Finally != nil {
				scanStmt(s.Finally)
			}
		case *ast.VariableStatement:
			for _, b := range s.List {
				scanPattern(b, true)
			}
		case *ast.LexicalDeclaration:
			for _, b := range s.List {
				scanPattern(b, true)
			}
		case *ast.WhileStatement:
			scanExpr(s.Test)
			scanStmt(s.Body)
		case *ast.WithStatement:
			scanExpr(s.Object)
			scanStmt(s.Body)
		case *ast.FunctionDeclaration:
			if s.Function != nil && s.Function.Name != nil {
				varCount++
			}
			scanFunc(s.Function)
		case *ast.ClassDeclaration:
			if s.Class != nil && s.Class.Name != nil {
				varCount++
			}
			scanClass(s.Class)
		}
	}

	scanStmts = func(stmts []ast.Statement) {
		for _, s := range stmts {
			scanStmt(s)
		}
	}

	scanStmts(prg.Body)
	return seen, varCount
}

func instrumentProgramAST(prg *ast.Program, tickIdent, chkIdent string) {
	safePos := func(idx file.Idx) file.Idx {
		if idx < 1 {
			return 1
		}
		return idx
	}
	makeTickCall := func(pos file.Idx) ast.Expression {
		p := safePos(pos)
		return &ast.CallExpression{
			Callee:           &ast.Identifier{Name: unistring.String(tickIdent), Idx: p},
			LeftParenthesis:  p,
			RightParenthesis: p,
		}
	}
	makeTickStmt := func(pos file.Idx) ast.Statement {
		return &ast.ExpressionStatement{
			Expression: makeTickCall(pos),
		}
	}
	wrapChk := func(ex ast.Expression) ast.Expression {
		p := safePos(ex.Idx0())
		return &ast.CallExpression{
			Callee:           &ast.Identifier{Name: unistring.String(chkIdent), Idx: p},
			LeftParenthesis:  p,
			ArgumentList:     []ast.Expression{ex},
			RightParenthesis: safePos(ex.Idx1()),
		}
	}

	var instExpr func(ex ast.Expression) ast.Expression
	var instLValue func(ex ast.Expression)
	var instBinding func(b *ast.Binding)
	var instPatternTarget func(ex ast.Expression)
	var instFunc func(fn *ast.FunctionLiteral)
	var instClass func(cl *ast.ClassLiteral)
	var instStmt func(st ast.Statement) ast.Statement
	var instStmtList func(stmts []ast.Statement, skipPrologue bool, ensureTick bool, fallbackPos file.Idx) []ast.Statement
	var instLoopBody func(body ast.Statement, fallbackPos file.Idx) ast.Statement

	instPatternTarget = func(ex ast.Expression) {
		if ex == nil {
			return
		}
		switch node := ex.(type) {
		case *ast.Binding:
			instBinding(node)
		case *ast.ArrayPattern:
			for _, el := range node.Elements {
				instPatternTarget(el)
			}
			instPatternTarget(node.Rest)
		case *ast.ObjectPattern:
			for _, prop := range node.Properties {
				switch pr := prop.(type) {
				case *ast.PropertyShort:
					if pr.Initializer != nil {
						pr.Initializer = instExpr(pr.Initializer)
					}
				case *ast.PropertyKeyed:
					if pr.Computed {
						pr.Key = instExpr(pr.Key)
					}
					instPatternTarget(pr.Value)
				case *ast.SpreadElement:
					instPatternTarget(pr.Expression)
				}
			}
			instPatternTarget(node.Rest)
		default:
			instLValue(ex)
		}
	}

	instBinding = func(b *ast.Binding) {
		if b == nil {
			return
		}
		instPatternTarget(b.Target)
		if b.Initializer != nil {
			b.Initializer = instExpr(b.Initializer)
		}
	}

	instLValue = func(ex ast.Expression) {
		if ex == nil {
			return
		}
		switch e := ex.(type) {
		case *ast.BracketExpression:
			e.Left = instExpr(e.Left)
			e.Member = instExpr(e.Member)
		case *ast.DotExpression:
			e.Left = instExpr(e.Left)
		case *ast.PrivateDotExpression:
			e.Left = instExpr(e.Left)
		case *ast.ArrayPattern, *ast.ObjectPattern, *ast.Binding:
			instPatternTarget(e)
		}
	}

	instFunc = func(fn *ast.FunctionLiteral) {
		if fn == nil {
			return
		}
		if fn.ParameterList != nil {
			for _, b := range fn.ParameterList.List {
				instBinding(b)
			}
			if fn.ParameterList.Rest != nil {
				instPatternTarget(fn.ParameterList.Rest)
			}
		}
		if fn.Body != nil {
			fn.Body.List = instStmtList(fn.Body.List, true, true, fn.Body.Idx0())
		}
	}

	instClass = func(cl *ast.ClassLiteral) {
		if cl == nil {
			return
		}
		if cl.SuperClass != nil {
			cl.SuperClass = instExpr(cl.SuperClass)
		}
		for _, el := range cl.Body {
			switch e := el.(type) {
			case *ast.FieldDefinition:
				if e.Computed && e.Key != nil {
					e.Key = instExpr(e.Key)
				}
				if e.Initializer != nil {
					e.Initializer = instExpr(e.Initializer)
				}
			case *ast.MethodDefinition:
				if e.Computed && e.Key != nil {
					e.Key = instExpr(e.Key)
				}
				instFunc(e.Body)
			case *ast.ClassStaticBlock:
				if e.Block != nil {
					e.Block.List = instStmtList(e.Block.List, false, true, e.Block.Idx0())
				}
			}
		}
	}

	instExpr = func(ex ast.Expression) ast.Expression {
		if ex == nil {
			return nil
		}
		switch e := ex.(type) {
		case *ast.ArrayLiteral:
			for i, v := range e.Value {
				e.Value[i] = instExpr(v)
			}
			return e
		case *ast.ObjectLiteral:
			for _, prop := range e.Value {
				switch pr := prop.(type) {
				case *ast.PropertyShort:
					if pr.Initializer != nil {
						pr.Initializer = instExpr(pr.Initializer)
					}
				case *ast.PropertyKeyed:
					if pr.Computed && pr.Key != nil {
						pr.Key = instExpr(pr.Key)
					}
					if pr.Value != nil {
						pr.Value = instExpr(pr.Value)
					}
				case *ast.SpreadElement:
					pr.Expression = instExpr(pr.Expression)
				}
			}
			return e
		case *ast.AssignExpression:
			instLValue(e.Left)
			e.Right = instExpr(e.Right)
			if e.Operator == token.PLUS {
				return wrapChk(e)
			}
			return e
		case *ast.BinaryExpression:
			e.Left = instExpr(e.Left)
			e.Right = instExpr(e.Right)
			if e.Operator == token.PLUS {
				return wrapChk(e)
			}
			return e
		case *ast.BracketExpression:
			e.Left = instExpr(e.Left)
			e.Member = instExpr(e.Member)
			return e
		case *ast.CallExpression:
			switch c := e.Callee.(type) {
			case *ast.DotExpression:
				c.Left = instExpr(c.Left)
			case *ast.PrivateDotExpression:
				c.Left = instExpr(c.Left)
			case *ast.BracketExpression:
				c.Left = instExpr(c.Left)
				c.Member = instExpr(c.Member)
			default:
				e.Callee = instExpr(e.Callee)
			}
			for i, a := range e.ArgumentList {
				e.ArgumentList[i] = instExpr(a)
			}
			return e
		case *ast.NewExpression:
			e.Callee = instExpr(e.Callee)
			for i, a := range e.ArgumentList {
				e.ArgumentList[i] = instExpr(a)
			}
			return e
		case *ast.ConditionalExpression:
			e.Test = instExpr(e.Test)
			e.Consequent = instExpr(e.Consequent)
			e.Alternate = instExpr(e.Alternate)
			return e
		case *ast.DotExpression:
			e.Left = instExpr(e.Left)
			return e
		case *ast.PrivateDotExpression:
			e.Left = instExpr(e.Left)
			return e
		case *ast.OptionalChain:
			e.Expression = instExpr(e.Expression)
			return e
		case *ast.Optional:
			e.Expression = instExpr(e.Expression)
			return e
		case *ast.FunctionLiteral:
			instFunc(e)
			return e
		case *ast.ClassLiteral:
			instClass(e)
			return e
		case *ast.ArrowFunctionLiteral:
			if e.ParameterList != nil {
				for _, b := range e.ParameterList.List {
					instBinding(b)
				}
				if e.ParameterList.Rest != nil {
					instPatternTarget(e.ParameterList.Rest)
				}
			}
			switch b := e.Body.(type) {
			case *ast.BlockStatement:
				b.List = instStmtList(b.List, true, true, b.Idx0())
			case *ast.ExpressionBody:
				pos := safePos(b.Idx0())
				expr := instExpr(b.Expression)
				e.Body = &ast.BlockStatement{
					LeftBrace: pos,
					List: []ast.Statement{
						makeTickStmt(pos),
						&ast.ReturnStatement{
							Return:   pos,
							Argument: expr,
						},
					},
					RightBrace: safePos(b.Idx1()),
				}
			}
			return e
		case *ast.SequenceExpression:
			for i, item := range e.Sequence {
				e.Sequence[i] = instExpr(item)
			}
			return e
		case *ast.TemplateLiteral:
			if e.Tag != nil {
				e.Tag = instExpr(e.Tag)
			}
			for i, item := range e.Expressions {
				e.Expressions[i] = instExpr(item)
			}
			if e.Tag == nil {
				return wrapChk(e)
			}
			return e
		case *ast.UnaryExpression:
			if e.Operator == token.DELETE || e.Operator == token.INCREMENT || e.Operator == token.DECREMENT {
				instLValue(e.Operand)
			} else {
				e.Operand = instExpr(e.Operand)
			}
			return e
		case *ast.YieldExpression:
			e.Argument = instExpr(e.Argument)
			return e
		case *ast.AwaitExpression:
			e.Argument = instExpr(e.Argument)
			return e
		case *ast.SpreadElement:
			e.Expression = instExpr(e.Expression)
			return e
		case *ast.Binding:
			instBinding(e)
			return e
		case *ast.ArrayPattern, *ast.ObjectPattern:
			instPatternTarget(e)
			return e
		default:
			return ex
		}
	}

	instLoopBody = func(body ast.Statement, fallbackPos file.Idx) ast.Statement {
		if body == nil {
			pos := safePos(fallbackPos)
			return &ast.BlockStatement{
				LeftBrace:  pos,
				List:       []ast.Statement{makeTickStmt(pos)},
				RightBrace: pos,
			}
		}
		if blk, ok := body.(*ast.BlockStatement); ok {
			blk.List = instStmtList(blk.List, false, true, blk.Idx0())
			return blk
		}
		inst := instStmt(body)
		pos := safePos(body.Idx0())
		return &ast.BlockStatement{
			LeftBrace:  pos,
			List:       []ast.Statement{makeTickStmt(pos), inst},
			RightBrace: safePos(body.Idx1()),
		}
	}

	instStmt = func(st ast.Statement) ast.Statement {
		if st == nil {
			return nil
		}
		switch s := st.(type) {
		case *ast.BlockStatement:
			s.List = instStmtList(s.List, false, false, s.Idx0())
			return s
		case *ast.CaseStatement:
			if s.Test != nil {
				s.Test = instExpr(s.Test)
			}
			s.Consequent = instStmtList(s.Consequent, false, false, s.Idx0())
			return s
		case *ast.CatchStatement:
			if s.Parameter != nil {
				instPatternTarget(s.Parameter)
			}
			if s.Body != nil {
				s.Body.List = instStmtList(s.Body.List, false, false, s.Body.Idx0())
			}
			return s
		case *ast.DoWhileStatement:
			s.Body = instLoopBody(s.Body, s.Idx0())
			s.Test = instExpr(s.Test)
			return s
		case *ast.ExpressionStatement:
			s.Expression = instExpr(s.Expression)
			return s
		case *ast.ForInStatement:
			switch into := s.Into.(type) {
			case *ast.ForIntoVar:
				instBinding(into.Binding)
			case *ast.ForDeclaration:
				instPatternTarget(into.Target)
			case *ast.ForIntoExpression:
				instLValue(into.Expression)
			}
			s.Source = instExpr(s.Source)
			s.Body = instLoopBody(s.Body, s.Idx0())
			return s
		case *ast.ForOfStatement:
			switch into := s.Into.(type) {
			case *ast.ForIntoVar:
				instBinding(into.Binding)
			case *ast.ForDeclaration:
				instPatternTarget(into.Target)
			case *ast.ForIntoExpression:
				instLValue(into.Expression)
			}
			s.Source = instExpr(s.Source)
			s.Body = instLoopBody(s.Body, s.Idx0())
			return s
		case *ast.ForStatement:
			switch init := s.Initializer.(type) {
			case *ast.ForLoopInitializerExpression:
				init.Expression = instExpr(init.Expression)
			case *ast.ForLoopInitializerVarDeclList:
				for _, b := range init.List {
					instBinding(b)
				}
			case *ast.ForLoopInitializerLexicalDecl:
				for _, b := range init.LexicalDeclaration.List {
					instBinding(b)
				}
			}
			if s.Test != nil {
				s.Test = instExpr(s.Test)
			}
			if s.Update != nil {
				s.Update = instExpr(s.Update)
			}
			s.Body = instLoopBody(s.Body, s.Idx0())
			return s
		case *ast.IfStatement:
			s.Test = instExpr(s.Test)
			s.Consequent = instStmt(s.Consequent)
			s.Alternate = instStmt(s.Alternate)
			return s
		case *ast.LabelledStatement:
			s.Statement = instStmt(s.Statement)
			return s
		case *ast.ReturnStatement:
			if s.Argument != nil {
				s.Argument = instExpr(s.Argument)
			}
			return s
		case *ast.SwitchStatement:
			s.Discriminant = instExpr(s.Discriminant)
			for _, cs := range s.Body {
				_ = instStmt(cs)
			}
			return s
		case *ast.ThrowStatement:
			s.Argument = instExpr(s.Argument)
			return s
		case *ast.TryStatement:
			if s.Body != nil {
				s.Body.List = instStmtList(s.Body.List, false, false, s.Body.Idx0())
			}
			if s.Catch != nil {
				_ = instStmt(s.Catch)
			}
			if s.Finally != nil {
				s.Finally.List = instStmtList(s.Finally.List, false, false, s.Finally.Idx0())
			}
			return s
		case *ast.VariableStatement:
			for _, b := range s.List {
				instBinding(b)
			}
			return s
		case *ast.LexicalDeclaration:
			for _, b := range s.List {
				instBinding(b)
			}
			return s
		case *ast.WhileStatement:
			s.Test = instExpr(s.Test)
			s.Body = instLoopBody(s.Body, s.Idx0())
			return s
		case *ast.WithStatement:
			s.Object = instExpr(s.Object)
			s.Body = instStmt(s.Body)
			return s
		case *ast.FunctionDeclaration:
			instFunc(s.Function)
			return s
		case *ast.ClassDeclaration:
			instClass(s.Class)
			return s
		default:
			return st
		}
	}

	instStmtList = func(stmts []ast.Statement, skipPrologue bool, ensureTick bool, fallbackPos file.Idx) []ast.Statement {
		out := make([]ast.Statement, 0, len(stmts)*2+1)
		i := 0
		if skipPrologue {
			for i < len(stmts) {
				es, ok := stmts[i].(*ast.ExpressionStatement)
				if !ok {
					break
				}
				if _, isStr := es.Expression.(*ast.StringLiteral); !isStr {
					break
				}
				out = append(out, stmts[i])
				i++
			}
		}
		tickInserted := false
		for ; i < len(stmts); i++ {
			s := stmts[i]
			switch s.(type) {
			case *ast.FunctionDeclaration, *ast.EmptyStatement:
				out = append(out, instStmt(s))
			default:
				out = append(out, makeTickStmt(s.Idx0()), instStmt(s))
				tickInserted = true
			}
		}
		if ensureTick && !tickInserted {
			out = append(out, makeTickStmt(fallbackPos))
		}
		return out
	}

	var progPos file.Idx = 1
	if len(prg.Body) > 0 {
		progPos = safePos(prg.Body[0].Idx0())
	}
	prg.Body = instStmtList(prg.Body, true, false, progPos)
}
