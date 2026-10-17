package manager

import (
	"testing"

	"vibevalley/internal/testkit"
)

func TestSituationDelta(t *testing.T) {
	before := "【农场现状】\n项目：demo\n可以派的帮工：\n- 老周\n- 小吴\n- 阿郑\n各频道和地里的帮工：\n#田头\n  （没有帮工）\n#clock-in\n  （没有帮工）\n你正在回话的频道：#田头"
	for _, c := range []struct {
		name, now, want string
	}{
		{"unchanged", before, ""},
		{"a line added", "【农场现状】\n项目：demo\n可以派的帮工：\n- 老周\n- 小吴\n- 阿郑\n各频道和地里的帮工：\n#田头\n  （没有帮工）\n#clock-in\n- w1 在 clock-in\n你正在回话的频道：#田头",
			"【农场变了】\n#clock-in\n+ - w1 在 clock-in\n−   （没有帮工）"},
		{"a line gone", "【农场现状】\n项目：demo\n可以派的帮工：\n- 老周\n- 阿郑\n各频道和地里的帮工：\n#田头\n  （没有帮工）\n#clock-in\n  （没有帮工）\n你正在回话的频道：#田头",
			"【农场变了】\n可以派的帮工：\n− - 小吴"},
		{"most of it changed", "【农场现状】\n项目：notes\n可以派的帮工：\n- 老吴\n各频道和地里的帮工：\n#田头\n- w2\n你正在回话的频道：#clock-in",
			"【农场现状】\n项目：notes\n可以派的帮工：\n- 老吴\n各频道和地里的帮工：\n#田头\n- w2\n你正在回话的频道：#clock-in"},
	} {
		testkit.Eq(t, situationDelta(before, c.now), c.want, c.name)
	}
}
