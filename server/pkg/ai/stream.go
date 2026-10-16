package ai

// The stream never fails: a request that went wrong ends in an `error` event, its message StopReason error; cancelling the context stops the request
// and closes the channel (no done or error follows).

import "context"

type ApiProvider struct {
	API    string
	Stream func(ctx context.Context, model Model, c Context, options StreamOptions) <-chan AssistantMessageEvent
}

func defaultProviders() []ApiProvider { return []ApiProvider{OpenAICompletions, AnthropicMessages} }

type providersKey struct{}

// A later one wins for its api.
func WithProviders(ctx context.Context, extra ...ApiProvider) context.Context {
	providers := map[string]ApiProvider{}
	for _, p := range append(defaultProviders(), extra...) {
		providers[p.API] = p
	}
	return context.WithValue(ctx, providersKey{}, providers)
}

func ProvidersOf(ctx context.Context) map[string]ApiProvider {
	if providers, ok := ctx.Value(providersKey{}).(map[string]ApiProvider); ok {
		return providers
	}
	providers := map[string]ApiProvider{}
	for _, p := range defaultProviders() {
		providers[p.API] = p
	}
	return providers
}

// The channel is closed after done or error, or when ctx ends.
func Stream(ctx context.Context, model Model, c Context, options StreamOptions) <-chan AssistantMessageEvent {
	provider, ok := ProvidersOf(ctx)[model.API]
	if !ok {
		return FromEvents(ctx, NewAnswer(model, "").Error(StopError, "没有能回答 "+model.API+" 的 provider", RawUsage{}))
	}
	return provider.Stream(ctx, model, c, options)
}

func Complete(ctx context.Context, model Model, c Context, options StreamOptions) AssistantMessage {
	var last *AssistantMessage
	for e := range Stream(ctx, model, c, options) {
		if m, ok := e.Final(); ok {
			last = &m
		}
	}
	if last != nil {
		return *last
	}
	m := NewAnswer(model, "").Partial()
	m.StopReason = StopError
	m.ErrorMessage = "没有回答"
	return m
}

func FromEvents(ctx context.Context, events []AssistantMessageEvent) <-chan AssistantMessageEvent {
	out := make(chan AssistantMessageEvent)
	go func() {
		defer close(out)
		for _, e := range events {
			if !send(ctx, out, e) {
				return
			}
		}
	}()
	return out
}

func send(ctx context.Context, out chan<- AssistantMessageEvent, e AssistantMessageEvent) bool {
	if ctx.Err() != nil {
		return false
	}
	select {
	case out <- e:
		return true
	case <-ctx.Done():
		return false
	}
}
