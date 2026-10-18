package protocol

// The achievements in words, for the page (game.achievements) and the effects; and how far the farm is with each, for the
// frame's view. The client keeps no copy of seeds.json's achievements: it shows these.

// AchievementsInWords is every achievement, in the page's order.
func AchievementsInWords() []Achievement {
	out := make([]Achievement, 0, len(Achievements))
	for _, a := range Achievements {
		out = append(out, achievementInWords(a))
	}
	return out
}

func achievementInWords(a AchievementDef) Achievement {
	tiers := make([]AchievementTier, len(a.Tiers))
	for i, need := range a.Tiers {
		tier := i + 1
		var coins int64
		if i < len(a.Coins) {
			coins = a.Coins[i]
		}
		tiers[i] = AchievementTier{Need: need, Title: tierTitle(a, tier), Coins: coins, Reached: reachedText(a, tier)}
	}
	return Achievement{ID: a.ID, Category: a.Category, Title: a.Title, Detail: a.Detail, Unit: a.Unit, Wearable: a.Category != AchievementCategoryStarter, Tiers: tiers}
}

func tierTitle(a AchievementDef, tier int) string {
	if tier >= 1 && tier <= len(a.TierTitles) {
		return a.TierTitles[tier-1]
	}
	switch tier {
	case 2:
		return "银牌" + a.Title
	case 3:
		return "金牌" + a.Title
	}
	return a.Title
}

func reachedText(a AchievementDef, tier int) string {
	switch {
	case a.Category == AchievementCategoryStarter:
		return "新手任务做完了"
	case a.Category == AchievementCategorySecret:
		return "发现一个彩蛋"
	case tier == 3:
		return "升到金牌"
	case tier == 2:
		return "升到银牌"
	}
	return "解锁成就"
}

func achievementEffect(id string, tier int64) GameEffectAchievement {
	e := GameEffectAchievement{Achievement: id, Tier: tier}
	for _, a := range Achievements {
		if a.ID != id {
			continue
		}
		words := achievementInWords(a)
		e.Detail, e.OneOff = a.Detail, len(a.Tiers) == 1
		if tier >= 1 && tier <= int64(len(words.Tiers)) {
			t := words.Tiers[tier-1]
			e.Title, e.Reached, e.Coins = t.Title, t.Reached, t.Coins
		}
	}
	return e
}

func standingsOf(p *Progress) []AchievementStanding {
	out := make([]AchievementStanding, 0, len(Achievements))
	for _, a := range Achievements {
		s := AchievementStanding{ID: a.ID}
		if p != nil {
			s.Count = p.Counts[a.ID]
			for _, u := range p.Unlocked {
				if u.ID == a.ID && u.Tier > s.Tier {
					s.Tier = u.Tier
				}
			}
		}
		if s.Tier < int64(len(a.Tiers)) {
			next := a.Tiers[s.Tier]
			s.Next = &next
		}
		out = append(out, s)
	}
	return out
}
