package runtime

import (
	"math"

	"vibevalley/pkg/smith/oar"
	"vibevalley/pkg/x/ptr"
)

// Rate prices a usage delta in the farm's currency; cache tokens are included in input by smith.
type Rate struct {
	price     Price
	cnyPerUSD float64
}

func (p Price) InCNY(cnyPerUSD float64) Rate { return Rate{price: p, cnyPerUSD: cnyPerUSD} }

func (r Rate) Charge(tokens oar.TokenTotals) float64 {
	read, write := float64(ptr.Value(tokens.CacheRead)), float64(ptr.Value(tokens.CacheWrite))
	p := r.price
	return (math.Max(0, float64(tokens.Input)-read-write)*p.Input + float64(tokens.Output)*p.Output + read*p.CacheRead + write*p.CacheWrite) / 1_000_000 * r.cnyPerUSD
}

func (r *Service) Quote(id, model string) *Rate {
	price := r.Price(id, model)
	if price == nil {
		return nil
	}
	rate := price.InCNY(r.cnyPerUsd)
	return &rate
}
