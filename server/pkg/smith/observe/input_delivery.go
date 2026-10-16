package observe

// Input delivery state (observe/input-delivery.ts).

// InputDrop ends ownership without changing any earlier request or response.
// Attempts is the number of attempts the drop settled; later attempts can take ownership again.
type InputDrop struct {
	Attempts int `json:"attempts"`
	// "turn_interrupted" | "runtime_exited" | "runtime_refused"
	Reason string `json:"reason"`
}

// deliveryState: only attempts after the latest withdrawal or drop can own the input again.
func deliveryState(attempts []InputAttempt, drop *InputDrop) (state, reason string) {
	withdrawn := -1
	for i := len(attempts) - 1; i >= 0; i-- {
		if attempts[i].Request.Request.Kind == "withdraw" && attempts[i].State == "accepted" {
			withdrawn = i
			break
		}
	}
	cut := withdrawn
	if drop != nil && drop.Attempts-1 > cut {
		cut = drop.Attempts - 1
	}
	var delivery []InputAttempt
	if cut+1 < len(attempts) {
		for _, attempt := range attempts[cut+1:] {
			if attempt.Request.Request.Kind != "withdraw" {
				delivery = append(delivery, attempt)
			}
		}
	}
	for _, attempt := range delivery {
		if attempt.State == "accepted" {
			return "accepted", ""
		}
	}
	if len(delivery) > 0 {
		return delivery[len(delivery)-1].State, ""
	}
	if drop != nil && withdrawn < drop.Attempts {
		return "dropped", drop.Reason
	}
	if withdrawn == -1 {
		return "pending", ""
	}
	return "withdrawn", ""
}

// withDeliveryState is an observed input's new control state; old drop reasons never survive a retry.
func withDeliveryState(input ConversationInput, attempts []InputAttempt, drop *InputDrop) ConversationInput {
	next := input
	next.Reason = ""
	if drop != nil {
		next.Turn = nil
	}
	next.Attempts = attempts
	next.State, next.Reason = deliveryState(attempts, drop)
	return next
}

// awaitsEcho reports whether the stream has established that this input waits for a native echo.
func awaitsEcho(input ConversationInput, inputs *OrderedMap[ConversationInput]) bool {
	if input.Turn != nil && input.Turn.State == "queued" && input.State != "dropped" && input.State != "withdrawn" && input.State != "rejected" {
		return true
	}
	if input.Turn != nil && input.Turn.State == "active" {
		return false
	}
	if len(input.Observations) > 0 || input.State == "rejected" || input.State == "withdrawn" || input.State == "dropped" {
		return false
	}
	for _, attempt := range input.Attempts {
		if attempt.Request.Request.Kind == "prompt" && attempt.State != "rejected" {
			return false
		}
	}
	found := false
	inputs.All(func(_ string, known ConversationInput) bool {
		if len(known.Observations) > 0 {
			found = true
			return false
		}
		return true
	})
	return found
}
