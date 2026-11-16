package delta_test

import (
	"encoding/json"
	"fmt"
	"math"
	"math/rand/v2"
	"reflect"
	"testing"

	"github.com/vibevalleyhq/vibevalley/pkg/chord/delta"
)

func TestValidateValueStrictJSON(t *testing.T) {
	valid := []any{
		nil,
		true,
		false,
		"hello",
		int64(42),
		int64(-9007199254740993),
		float64(3.14159),
		float64(0),
		[]any{nil, true, "x", int64(1), float64(2.5), map[string]any{"nested": "ok"}},
		map[string]any{"a": int64(1), "b": []any{"s"}, "c": nil},
	}
	for i, v := range valid {
		if err := delta.ValidateValue(v); err != nil {
			t.Fatalf("valid case %d (%T) rejected: %v", i, v, err)
		}
	}

	invalid := []any{
		math.NaN(),
		math.Inf(1),
		math.Inf(-1),
		int(1),
		int32(1),
		uint64(1),
		float32(1.5),
		struct{ X int }{1},
		[]string{"a"},
		map[string]string{"a": "b"},
		map[string]any{"nested": []any{math.NaN()}},
		[]any{map[string]any{"inf": math.Inf(-1)}},
	}
	for i, v := range invalid {
		if err := delta.ValidateValue(v); err == nil {
			t.Fatalf("invalid case %d (%#v) accepted", i, v)
		}
		if _, err := delta.MarshalValue(v); err == nil {
			t.Fatalf("MarshalValue accepted invalid case %d (%#v)", i, v)
		}
	}
}

func TestOpTupleWireFormatRoundTrip(t *testing.T) {
	cases := []struct {
		name string
		op   delta.Op
		want string
	}{
		{
			name: "root replace",
			op:   delta.ReplaceRoot(map[string]any{"ok": true}),
			want: `["r",{"ok":true}]`,
		},
		{
			name: "path replace",
			op:   delta.Replace([]string{"a", "b"}, int64(7)),
			want: `["r",["a","b"],7]`,
		},
		{
			name: "delete",
			op:   delta.Delete([]string{"a", "old"}),
			want: `["d",["a","old"]]`,
		},
		{
			name: "append text",
			op:   delta.AppendText([]string{"msg", "text"}, " world"),
			want: `["a",["msg","text"]," world"]`,
		},
		{
			name: "splice array with items",
			op:   delta.SpliceArray([]string{"items"}, 2, 1, "x", int64(9)),
			want: `["s",["items"],2,1,"x",9]`,
		},
		{
			name: "splice array delete only",
			op:   delta.SpliceArray([]string{"items"}, 0, 3),
			want: `["s",["items"],0,3]`,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			raw, err := json.Marshal(tc.op)
			if err != nil {
				t.Fatalf("Marshal: %v", err)
			}
			if string(raw) != tc.want {
				t.Fatalf("got wire %s, want %s", raw, tc.want)
			}
			var decoded delta.Op
			if err := json.Unmarshal(raw, &decoded); err != nil {
				t.Fatalf("Unmarshal: %v", err)
			}
			raw2, err := json.Marshal(decoded)
			if err != nil {
				t.Fatalf("re-Marshal: %v", err)
			}
			if string(raw2) != tc.want {
				t.Fatalf("round-trip mismatch: got %s, want %s", raw2, tc.want)
			}
		})
	}
}

func TestSnapshotImmutabilityAndCoW(t *testing.T) {
	input := map[string]any{
		"keep": map[string]any{"x": int64(1)},
		"edit": map[string]any{"text": "hi", "items": []any{"a", "b"}},
	}
	snap1, err := delta.NewSnapshot(input)
	if err != nil {
		t.Fatalf("NewSnapshot: %v", err)
	}
	snap1.Seal()

	// Mutating original input after NewSnapshot must not affect snap1.
	input["keep"].(map[string]any)["x"] = int64(999)
	if err := snap1.Verify(); err != nil {
		t.Fatalf("Verify after external input mutation: %v", err)
	}
	gotVal := snap1.Value().(map[string]any)
	gotVal["keep"].(map[string]any)["x"] = int64(888)
	if v, ok := snap1.Get("keep", "x"); !ok || v != int64(1) {
		t.Fatalf("snap1 mutated through Value() copy: got %v, ok=%v", v, ok)
	}

	d := snap1.Draft()
	if err := d.AppendText([]string{"edit", "text"}, "!"); err != nil {
		t.Fatalf("AppendText: %v", err)
	}
	if err := d.SpliceArray([]string{"edit", "items"}, 0, 1, "z"); err != nil {
		t.Fatalf("SpliceArray: %v", err)
	}
	snap2, ops, err := d.Commit()
	if err != nil {
		t.Fatalf("Commit: %v", err)
	}
	if len(ops) != 2 {
		t.Fatalf("expected 2 ops, got %d", len(ops))
	}
	if err := snap1.Verify(); err != nil {
		t.Fatalf("snap1 integrity broken after draft commit: %v", err)
	}
	if err := snap2.Verify(); err != nil {
		t.Fatalf("snap2 integrity failed: %v", err)
	}

	v1, _ := snap1.Get("edit", "text")
	v2, _ := snap2.Get("edit", "text")
	if v1 != "hi" || v2 != "hi!" {
		t.Fatalf("CoW mismatch: v1=%v v2=%v", v1, v2)
	}
	arr1, _ := snap1.Get("edit", "items")
	arr2, _ := snap2.Get("edit", "items")
	if !delta.Equal(arr1, []any{"a", "b"}) || !delta.Equal(arr2, []any{"z", "b"}) {
		t.Fatalf("CoW array mismatch: arr1=%v arr2=%v", arr1, arr2)
	}
}

func TestPendingOpsCoalescingRules(t *testing.T) {
	t.Run("rule 1 adjacent appends", func(t *testing.T) {
		q := delta.NewPendingOps(0)
		if err := q.Push([]delta.Op{
			delta.AppendText([]string{"msg", "text"}, "hel"),
			delta.AppendText([]string{"msg", "text"}, "lo"),
			delta.Replace([]string{"other"}, int64(1)),
			delta.AppendText([]string{"msg", "text"}, " world"),
		}, nil); err != nil {
			t.Fatal(err)
		}
		ops, overflow := q.Drain()
		if overflow {
			t.Fatal("unexpected overflow")
		}
		if len(ops) != 2 {
			t.Fatalf("expected 2 coalesced ops, got %d: %#v", len(ops), ops)
		}
		if ops[0].Kind != delta.OpAppendText || ops[0].Suffix != "hello world" {
			t.Fatalf("unexpected op[0]: %#v", ops[0])
		}
	})

	t.Run("rule 2 subtree overwrite pruning", func(t *testing.T) {
		q := delta.NewPendingOps(0)
		if err := q.Push([]delta.Op{
			delta.Replace([]string{"a", "b", "c"}, int64(1)),
			delta.AppendText([]string{"a", "b", "text"}, "abc"),
			delta.Replace([]string{"keep"}, true),
			delta.Replace([]string{"a"}, map[string]any{"fresh": true}),
		}, nil); err != nil {
			t.Fatal(err)
		}
		ops, overflow := q.Drain()
		if overflow {
			t.Fatal("unexpected overflow")
		}
		if len(ops) != 2 {
			t.Fatalf("expected 2 ops after pruning a/*, got %d: %#v", len(ops), ops)
		}
		if ops[0].Path[0] != "keep" || ops[1].Path[0] != "a" {
			t.Fatalf("unexpected remaining ops: %#v", ops)
		}
	})

	t.Run("rule 3 create plus append inplace merge", func(t *testing.T) {
		q := delta.NewPendingOps(0)
		if err := q.Push([]delta.Op{
			delta.Replace([]string{"stream"}, "a"),
			delta.AppendText([]string{"stream"}, "b"),
			delta.AppendText([]string{"stream"}, "c"),
		}, nil); err != nil {
			t.Fatal(err)
		}
		ops, overflow := q.Drain()
		if overflow {
			t.Fatal("unexpected overflow")
		}
		if len(ops) != 1 || ops[0].Kind != delta.OpReplace || ops[0].Value != "abc" {
			t.Fatalf("expected single [r, [stream], abc], got %#v", ops)
		}
	})

	t.Run("rule 4 overflow root replace cap over 10000 ops", func(t *testing.T) {
		q := delta.NewPendingOps(0)
		initBuckets := make(map[string]any, 100)
		for b := range 100 {
			initBuckets[fmt.Sprintf("b_%d", b)] = map[string]any{}
		}
		snap, err := delta.NewSnapshot(initBuckets)
		if err != nil {
			t.Fatal(err)
		}
		d := snap.Draft()
		for i := range 15_000 {
			bucket := fmt.Sprintf("b_%d", i%100)
			key := fmt.Sprintf("k_%d", i)
			if err := d.Set([]string{bucket, key}, int64(i)); err != nil {
				t.Fatal(err)
			}
			next, batch, err := d.Commit()
			if err != nil {
				t.Fatal(err)
			}
			snap = next
			if err := q.PushSnapshot(batch, snap); err != nil {
				t.Fatal(err)
			}
		}
		if !q.Overflowed() {
			t.Fatal("expected overflow after 15,000 distinct ops")
		}
		if q.Len() != 1 {
			t.Fatalf("expected O(1) Len()==1 on overflow, got %d", q.Len())
		}
		ops, overflow := q.Drain()
		if !overflow || len(ops) != 1 {
			t.Fatalf("expected single root replace on drain, got len=%d overflow=%v", len(ops), overflow)
		}
		if ops[0].Kind != delta.OpReplace || len(ops[0].Path) != 0 {
			t.Fatalf("expected root replace, got %#v", ops[0])
		}
		if !delta.Equal(ops[0].Value, snap.Value()) {
			t.Fatal("drained root replace does not equal latest snapshot")
		}
	})
}

func TestPendingOpsProperty50000Steps(t *testing.T) {
	rng := rand.New(rand.NewPCG(0x5EED1234, 0xCAFEBABE))

	initial := map[string]any{
		"meta": map[string]any{
			"title": "init",
			"count": int64(0),
			"sub": map[string]any{
				"log":   "",
				"notes": map[string]any{},
			},
		},
		"messages": []any{
			map[string]any{"id": int64(0), "text": "hello"},
			map[string]any{"id": int64(1), "text": "world"},
		},
		"tags": []any{"go", "chord"},
	}

	directSnap, err := delta.NewSnapshot(initial)
	if err != nil {
		t.Fatal(err)
	}
	foldedSnap, err := delta.NewSnapshot(initial)
	if err != nil {
		t.Fatal(err)
	}

	pending := delta.NewPendingOps(delta.DefaultMaxPendingOps)
	var nextMsgID int64 = 2

	const totalSteps = 50_000
	stepsSinceDrain := 0
	nextDrainAt := 1 + rng.IntN(40)

	for step := range totalSteps {
		d := directSnap.Draft()
		choice := rng.IntN(100)

		switch {
		case choice < 25:
			// Streaming text append on nested map or inside array message element.
			msgsAny, _ := d.Value().(map[string]any)["messages"]
			msgs := msgsAny.([]any)
			if len(msgs) > 0 && rng.IntN(2) == 0 {
				idx := rng.IntN(len(msgs))
				path := []string{"messages", fmt.Sprintf("%d", idx), "text"}
				err = d.AppendText(path, fmt.Sprintf("_%d", step%17))
			} else {
				err = d.AppendText([]string{"meta", "sub", "log"}, fmt.Sprintf("x%d", step%10))
			}

		case choice < 45:
			// Array sliding-window tail append + trim on messages or tags.
			msgsAny, _ := d.Value().(map[string]any)["messages"]
			msgs := msgsAny.([]any)
			if rng.IntN(2) == 0 || len(msgs) < 5 {
				newMsg := map[string]any{
					"id":   nextMsgID,
					"text": fmt.Sprintf("m%d", nextMsgID),
				}
				nextMsgID++
				err = d.SpliceArray([]string{"messages"}, len(msgs), 0, newMsg)
				if err == nil && len(msgs)+1 > 30 {
					err = d.SpliceArray([]string{"messages"}, 0, len(msgs)+1-20)
				}
			} else {
				trim := 1 + rng.IntN(min(3, len(msgs)))
				err = d.SpliceArray([]string{"messages"}, 0, trim)
			}

		case choice < 65:
			// Create/overwrite nested field (triggers Rule 2 & sets up Rule 3).
			key := fmt.Sprintf("n_%d", rng.IntN(12))
			switch rng.IntN(3) {
			case 0:
				err = d.Set([]string{"meta", "sub", "notes", key}, fmt.Sprintf("s%d", step))
			case 1:
				err = d.Set([]string{"meta", "sub", "notes", key}, map[string]any{
					"v":    int64(step),
					"flag": step%2 == 0,
				})
			default:
				err = d.Set([]string{"meta", "count"}, float64(step)*0.5)
			}

		case choice < 80:
			// Delete nested note field (including occasional absent key).
			key := fmt.Sprintf("n_%d", rng.IntN(15))
			err = d.Delete([]string{"meta", "sub", "notes", key})

		case choice < 95:
			// Append to a freshly set or existing note string, or splice tags.
			key := fmt.Sprintf("n_%d", rng.IntN(6))
			if err = d.Set([]string{"meta", "sub", "notes", key}, "seed"); err == nil {
				if rng.IntN(2) == 0 {
					err = d.AppendText([]string{"meta", "sub", "notes", key}, "_tail")
				}
			}

		default:
			// Occasional subtree replace on meta.sub or tags.
			if rng.IntN(2) == 0 {
				err = d.Set([]string{"meta", "sub"}, map[string]any{
					"log":   fmt.Sprintf("reset_%d", step),
					"notes": map[string]any{"k": "v"},
				})
			} else {
				err = d.Set([]string{"tags"}, []any{"a", "b", fmt.Sprintf("t%d", step)})
			}
		}

		if err != nil {
			t.Fatalf("step %d draft mutation failed: %v", step, err)
		}

		nextDirect, batch, err := d.Commit()
		if err != nil {
			t.Fatalf("step %d Commit: %v", step, err)
		}
		directSnap = nextDirect

		if err := pending.PushSnapshot(batch, directSnap); err != nil {
			t.Fatalf("step %d PushSnapshot: %v", step, err)
		}

		stepsSinceDrain++
		if stepsSinceDrain >= nextDrainAt || step == totalSteps-1 {
			prevFolded := foldedSnap
			drained, _ := pending.Drain()
			foldedSnap, err = foldedSnap.Apply(drained...)
			if err != nil {
				t.Fatalf("step %d foldedSnap.Apply: %v", step, err)
			}
			if !reflect.DeepEqual(directSnap.Value(), foldedSnap.Value()) {
				t.Fatalf("step %d deep equality mismatch:\ndirect: %#v\nfolded: %#v", step, directSnap.Value(), foldedSnap.Value())
			}
			if !delta.Equal(directSnap.Value(), foldedSnap.Value()) {
				t.Fatalf("step %d delta.Equal mismatch", step)
			}
			if step%97 == 0 && len(drained) > 0 {
				wire, err := json.Marshal(drained)
				if err != nil {
					t.Fatalf("step %d json.Marshal drained: %v", step, err)
				}
				var decoded []delta.Op
				if err := json.Unmarshal(wire, &decoded); err != nil {
					t.Fatalf("step %d json.Unmarshal drained: %v", step, err)
				}
				wireSnap, err := prevFolded.Apply(decoded...)
				if err != nil {
					t.Fatalf("step %d prevFolded.Apply(decoded): %v", step, err)
				}
				if !delta.Equal(directSnap.Value(), wireSnap.Value()) {
					t.Fatalf("step %d wire round-trip mismatch", step)
				}
			}
			stepsSinceDrain = 0
			// Occasionally build larger coalesced batches to hit varied batch shapes.
			if rng.IntN(20) == 0 {
				nextDrainAt = 200 + rng.IntN(500)
			} else {
				nextDrainAt = 1 + rng.IntN(40)
			}
		}
	}
}

func TestPendingOpsOverflowZeroGrowthAllocs(t *testing.T) {
	q := delta.NewPendingOps(100)
	snap, err := delta.NewSnapshot(map[string]any{"v": int64(0)})
	if err != nil {
		t.Fatal(err)
	}
	for i := range 101 {
		op := delta.Replace([]string{fmt.Sprintf("k_%d", i)}, int64(i))
		if err := q.PushSnapshot([]delta.Op{op}, snap); err != nil {
			t.Fatal(err)
		}
	}
	if !q.Overflowed() {
		t.Fatal("expected overflow after 101 ops")
	}
	batch := []delta.Op{delta.Replace([]string{"extra"}, int64(1))}
	allocs := testing.AllocsPerRun(1000, func() {
		if err := q.PushSnapshot(batch, snap); err != nil {
			t.Fatal(err)
		}
	})
	if allocs != 0 {
		t.Fatalf("expected 0 allocations per push after overflow, got %.2f", allocs)
	}
}

func TestPendingOpsSpliceCoalescingInvariants(t *testing.T) {
	initial := map[string]any{
		"arr": []any{
			map[string]any{"x": "a"},
			map[string]any{"x": "b"},
		},
	}
	ops := []delta.Op{
		delta.AppendText([]string{"arr", "0", "x"}, "1"),
		delta.SpliceArray([]string{"arr"}, 0, 0, map[string]any{"x": "new"}),
		delta.Replace([]string{"arr", "0", "x"}, "replaced"),
	}

	direct, err := delta.Apply(initial, ops...)
	if err != nil {
		t.Fatal(err)
	}
	q := delta.NewPendingOps(0)
	if err := q.Push(ops, direct); err != nil {
		t.Fatal(err)
	}
	drained, overflow := q.Drain()
	if overflow {
		t.Fatal("unexpected overflow")
	}
	folded, err := delta.Apply(initial, drained...)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(direct, folded) {
		t.Fatalf("splice invariant mismatch: direct=%#v folded=%#v", direct, folded)
	}
}
