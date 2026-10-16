package bridge

import (
	"strings"
	"time"

	"vibevalley/pkg/smith/oar"
	"vibevalley/pkg/smith/oartest"
)

// echoScript is the behavior the TS suite's `scripted` backend runs:
// "slow" inputs take a long turn, everything else a short one; a turn says
// `echo:<input>`.
func echoScript(turn *oartest.Turn) error {
	delay := 10 * time.Millisecond
	if strings.Contains(turn.Input, "slow") {
		delay = 200 * time.Millisecond
	}
	select {
	case <-time.After(delay):
	case <-turn.Context.Done():
	}
	turn.Say("echo:" + turn.Input)
	return nil
}

// Registry is every runtime the bridge serves: the built-in runtimes plus
// `scripted`, the public test runtime running echoScript.
func Registry() (*oar.RuntimeRegistry, error) {
	runtimes := append([]oar.Runtime{oartest.Runtime(oartest.Options{Turn: echoScript})}, builtins()...)
	return oar.NewRuntimeRegistry(runtimes...)
}
