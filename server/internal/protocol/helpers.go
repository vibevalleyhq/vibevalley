package protocol

// The JavaScript string and number semantics here are what the golden data holds the rules to.

import (
	"fmt"
	"math"
	"math/big"
	"slices"
	"strconv"
	"strings"
	"time"
	"unicode/utf16"
)

// coreSpaceClass is JavaScript's \s (WhiteSpace and LineTerminator), as the inside of a Go regexp class; Go's \s is
// ASCII only and has no \v.
const coreSpaceClass = `\t\n\v\f\r \x{a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}`

// coreIsSpace is whether r is whitespace to JavaScript's trim and \s.
func coreIsSpace(r rune) bool {
	switch r {
	case '\t', '\n', '\v', '\f', '\r', ' ', 0xa0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff:
		return true
	}
	return r >= 0x2000 && r <= 0x200a
}

func coreTrim(s string) string      { return strings.TrimFunc(s, coreIsSpace) }
func coreTrimStart(s string) string { return strings.TrimLeftFunc(s, coreIsSpace) }
func coreTrimEnd(s string) string   { return strings.TrimRightFunc(s, coreIsSpace) }

// coreUnits is a string's JavaScript length: UTF-16 code units.
func coreUnits(s string) int {
	n := 0
	for _, r := range s {
		if r > 0xFFFF {
			n += 2
		} else {
			n++
		}
	}
	return n
}

// coreSlice is JavaScript's s.slice(start, end) over UTF-16 units: negative counts from the end. A surrogate pair
// cut in half becomes U+FFFD.
func coreSlice(s string, start, end int) string {
	units := utf16.Encode([]rune(s))
	n := len(units)
	clamp := func(i int) int {
		if i < 0 {
			i += n
		}
		return min(max(i, 0), n)
	}
	from, to := clamp(start), clamp(end)
	if from >= to {
		return ""
	}
	return string(utf16.Decode(units[from:to]))
}

// coreLower is JavaScript's toLowerCase where it differs from Go's: İ lowers to i and a combining dot.
func coreLower(s string) string {
	return strings.ToLower(strings.ReplaceAll(s, "İ", "i̇"))
}

// coreRound is JavaScript's Math.round: halves go up.
func coreRound(x float64) float64 {
	r := math.Floor(x)
	if x-r >= 0.5 {
		r++
	}
	return r
}

// coreNumber is JavaScript's String(x) for a number.
func coreNumber(x float64) string {
	switch {
	case math.IsNaN(x):
		return "NaN"
	case x == 0:
		return "0"
	case math.IsInf(x, 1):
		return "Infinity"
	case math.IsInf(x, -1):
		return "-Infinity"
	case x < 0:
		return "-" + coreNumber(-x)
	}
	e := strconv.FormatFloat(x, 'e', -1, 64)
	mantissa, exp, _ := strings.Cut(e, "e")
	digits := strings.Replace(mantissa, ".", "", 1)
	power, _ := strconv.Atoi(exp)
	k, n := len(digits), power+1
	switch {
	case k <= n && n <= 21:
		return digits + strings.Repeat("0", n-k)
	case 0 < n && n <= 21:
		return digits[:n] + "." + digits[n:]
	case -6 < n && n <= 0:
		return "0." + strings.Repeat("0", -n) + digits
	}
	sign := "+"
	if n-1 < 0 {
		sign = "-"
	}
	tail := ""
	if k > 1 {
		tail = "." + digits[1:]
	}
	return digits[:1] + tail + "e" + sign + strconv.Itoa(coreAbs(n-1))
}

func coreAbs(n int) int {
	if n < 0 {
		return -n
	}
	return n
}

// coreFixed is JavaScript's x.toFixed(digits): the exact value rounded, halves away from zero.
func coreFixed(x float64, digits int) string {
	if math.IsNaN(x) {
		return "NaN"
	}
	if math.Abs(x) >= 1e21 {
		return coreNumber(x)
	}
	sign := ""
	if x < 0 {
		sign, x = "-", -x
	}
	scaled := new(big.Float).SetPrec(512).SetFloat64(x)
	scaled.Mul(scaled, new(big.Float).SetPrec(512).SetInt(new(big.Int).Exp(big.NewInt(10), big.NewInt(int64(digits)), nil)))
	whole, _ := scaled.Int(nil)
	rest := new(big.Float).SetPrec(512).Sub(scaled, new(big.Float).SetPrec(512).SetInt(whole))
	if rest.Cmp(big.NewFloat(0.5)) >= 0 {
		whole.Add(whole, big.NewInt(1))
	}
	text := whole.String()
	if digits == 0 {
		return sign + text
	}
	if len(text) <= digits {
		text = strings.Repeat("0", digits-len(text)+1) + text
	}
	return sign + text[:len(text)-digits] + "." + text[len(text)-digits:]
}

func wan(n int64) string {
	if n >= 10_000 {
		digits := 1
		if n >= 100_000 {
			digits = 0
		}
		return coreFixed(float64(n)/10_000, digits) + " 万"
	}
	return strconv.FormatInt(n, 10)
}

func Yuan(cny float64) string {
	if cny > 0 && cny < 0.01 {
		return "不到 ¥0.01"
	}
	return "¥" + coreFixed(cny, 2)
}

func SpentText(spent Spent) string {
	tokens := wan(spent.Tokens) + " token"
	if spent.CNY != nil {
		return "约 " + Yuan(*spent.CNY) + " · " + tokens
	}
	return tokens
}

func ConflictTask(base string, files []string) string {
	return fmt.Sprintf("把 %s 合进你的分支时有冲突（%s）。请在你的分支上运行 git merge %s，把冲突解决掉，跑一遍测试，再提交。结论里说清楚每个冲突是怎么取舍的。", base, strings.Join(files, "、"), base)
}

// A nil Value is null: no percentages.
func QuotaLeft(usage AccountUsage) (float64, bool) {
	ok, isOk := usage.Value.(AccountUsageOk)
	if !isOk || len(ok.Windows) == 0 {
		return 0, false
	}
	least := math.Inf(1)
	for _, w := range ok.Windows {
		least = math.Min(least, 100-w.UsedPercent)
	}
	return math.Max(0, least), true
}

const QuotaLow = 15

func coreMoney(b Balance) string {
	symbol := b.Currency + " "
	switch b.Currency {
	case "CNY":
		symbol = "¥"
	case "USD":
		symbol = "$"
	}
	return symbol + coreFixed(b.Amount, 2)
}

func QuotaText(usage AccountUsage) string {
	switch u := usage.Value.(type) {
	case nil:
		return "不报额度"
	case AccountUsageLoginRequired:
		return "没登录"
	case AccountUsageUnavailable:
		return "读不到额度（" + u.Reason + "）"
	case AccountUsageBalance:
		if len(u.Balances) == 0 {
			return u.Provider + " 读不到余额"
		}
		parts := make([]string, len(u.Balances))
		for i, b := range u.Balances {
			parts[i] = coreMoney(b)
		}
		short := ""
		if !u.Available {
			short = "，不够用了"
		}
		return u.Provider + " 余额 " + strings.Join(parts, "、") + short
	case AccountUsageOk:
		if len(u.Windows) == 0 {
			if u.Plan != nil {
				return *u.Plan
			}
			return "有额度"
		}
		parts := make([]string, len(u.Windows))
		for i, w := range u.Windows {
			parts[i] = w.Label + " 剩 " + coreNumber(100-w.UsedPercent) + "%"
		}
		return strings.Join(parts, "，")
	}
	return ""
}

func whenText(at int64) string {
	d := time.UnixMilli(at).In(time.Local)
	return fmt.Sprintf("%d 月 %d 日 %02d:%02d", int(d.Month()), d.Day(), d.Hour(), d.Minute())
}

func MoneyStop(info *RuntimeInfo) string {
	if info == nil {
		return ""
	}
	switch u := info.Usage.Value.(type) {
	case AccountUsageOk:
		for _, w := range u.Windows {
			if w.UsedPercent < 100 {
				continue
			}
			resets := ""
			if w.ResetsAt != nil && *w.ResetsAt != 0 {
				resets = "，" + whenText(*w.ResetsAt) + "重置"
			}
			return RuntimeLabel(info.ID) + " 的额度用完了（" + w.Label + "）" + resets + "，到时候再派"
		}
	case AccountUsageBalance:
		if len(u.Balances) > 0 {
			empty := true
			for _, b := range u.Balances {
				if b.Amount > 0 {
					empty = false
				}
			}
			if !u.Available || empty {
				return u.Provider + " 的余额用完了，充值以后再派"
			}
		}
	}
	budget, spent := 0.0, 0.0
	if info.Settings.DailyBudget != nil {
		budget = *info.Settings.DailyBudget
	}
	if info.SpentToday != nil {
		spent = *info.SpentToday
	}
	if budget > 0 && spent >= budget {
		return "今天已经花了 " + Yuan(spent) + "，到了每日预算 " + Yuan(budget) + "（在 Runtime 页面可以改）"
	}
	return ""
}

type AgentIssue struct {
	Field string `json:"field"`
	Level string `json:"level"`
	Text  string `json:"text"`
}

// Mirrors the checks oar makes when a session opens.
func AgentIssues(agent AgentProfile, runtime *RuntimeInfo) []AgentIssue {
	issues := []AgentIssue{}
	add := func(field, level, text string) {
		issues = append(issues, AgentIssue{Field: field, Level: level, Text: text})
	}
	facts := FactsOf(agent.Runtime)
	if runtime == nil {
		add("runtime", "error", "不认识的 runtime："+agent.Runtime)
	} else if _, ok := runtime.Installation.Value.(InstallationAvailable); !ok {
		add("runtime", "error", "这台机器上找不到这个 runtime")
	} else if !runtime.Settings.Enabled {
		add("runtime", "error", "这个 runtime 在 Runtime 页面里被停用了")
	}
	if broke := MoneyStop(runtime); broke != "" {
		add("runtime", "error", broke)
	}

	promptOption := ""
	switch agent.PersonaMode {
	case PersonaModeAppend:
		promptOption = "appendSystemPrompt"
	case PersonaModeReplace:
		promptOption = "systemPrompt"
	}
	if coreTrim(agent.Persona) != "" && promptOption != "" && facts.Refused[promptOption] != "" {
		add("persona", "error", facts.Refused[promptOption]+"。把人设改成「写进工单开头」。")
	}
	if agent.Effort != "" && facts.Refused["effort"] != "" {
		add("effort", "error", facts.Refused["effort"])
	}
	if len(agent.Env) > 0 && facts.Refused["env"] != "" {
		add("env", "error", facts.Refused["env"])
	}
	if len(agent.MCPServers) > 0 && facts.Refused["mcpServers"] != "" {
		add("mcpServers", "error", facts.Refused["mcpServers"])
	}
	if len(agent.DisallowedTools) > 0 && facts.Refused["disallowedTools"] != "" {
		add("disallowedTools", "error", facts.Refused["disallowedTools"])
	}
	if runtime != nil && runtime.Models != nil && agent.Model != "" {
		var model *ModelEntry
		for i := range runtime.Models {
			if runtime.Models[i].ID == agent.Model {
				model = &runtime.Models[i]
				break
			}
		}
		if model == nil {
			add("model", "warn", runtime.ID+" 的模型列表里没有 "+agent.Model)
		} else if agent.Effort != "" && len(model.EffortLevels) > 0 && !slices.Contains(model.EffortLevels, agent.Effort) {
			add("effort", "error", model.Name+" 没有 "+agent.Effort+" 这一档，可选："+strings.Join(model.EffortLevels, "、"))
		}
	} else if runtime != nil && runtime.Models != nil && agent.Effort != "" {
		// No model named: the runtime's default one (its settings', else the one it says it uses) must take the effort.
		var model *ModelEntry
		for i := range runtime.Models {
			if (runtime.Settings.DefaultModel != "" && runtime.Models[i].ID == runtime.Settings.DefaultModel) ||
				(runtime.Settings.DefaultModel == "" && runtime.Models[i].IsDefault) {
				model = &runtime.Models[i]
				break
			}
		}
		if model != nil && len(model.EffortLevels) > 0 && !slices.Contains(model.EffortLevels, agent.Effort) {
			add("effort", "error", runtime.ID+" 默认用的 "+model.Name+" 没有 "+agent.Effort+" 这一档，可选："+strings.Join(model.EffortLevels, "、"))
		}
	}
	return issues
}
