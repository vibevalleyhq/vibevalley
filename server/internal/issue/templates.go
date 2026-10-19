package issue

import (
	"cmp"
	"context"
	"regexp"
	"slices"
	"strings"
	"unicode/utf8"

	"vibevalley/internal/protocol"
	"vibevalley/pkg/x/str"
)

const (
	recentTitles = 5
	// A title longer than this is a long instruction, not one to send again.
	recentTitleLength = 60
)

func (d *dispatch) Templates(name string) (protocol.ProjectTemplates, error) {
	stack, ok := d.projects.Stack(name)
	if !ok {
		return protocol.ProjectTemplates{}, protocol.Missing{What: "项目 " + name}
	}
	all, err := d.issues.List()
	if err != nil {
		return protocol.ProjectTemplates{}, err
	}
	return protocol.ProjectTemplates{Project: name, Stack: stack, Recent: sentTitles(all, name), Kinds: filledKinds(protocol.TemplateCatalog(), stack)}, nil
}

// Only a queued todo starts here, under the queue's lock; without room it keeps its place (start would queue it anew).
func (d *dispatch) DispatchQueued(ctx context.Context, id string) (protocol.Dispatched, error) {
	d.trying.Lock()
	defer d.trying.Unlock()
	issue, err := d.issues.Get(id)
	if err != nil {
		return protocol.Dispatched{}, err
	}
	if issue.Status != protocol.IssueStatusTodo || issue.QueuedAt == nil || issue.Graph != nil || issue.Task != nil || protocol.IsForManager(issue) {
		return protocol.Dispatched{}, protocol.Refused{Reason: "只有排着队的待办能从这里开工"}
	}
	_, agent, project, err := d.ready(id)
	if err != nil {
		return protocol.Dispatched{}, err
	}
	if full := d.run.NoRoom(agent.Runtime, project); full != "" {
		why := full + "：还在排队，有空地就自动开工"
		return protocol.Dispatched{Queued: &why}, nil
	}
	return d.start(ctx, id, "", nil)
}

// The owner's own issues sent out in the project, newest first, each title once.
func sentTitles(all []protocol.Issue, project string) []string {
	mine := slices.DeleteFunc(slices.Clone(all), func(i protocol.Issue) bool {
		return i.Project == nil || *i.Project != project || len(i.Sessions) == 0 || i.Graph != nil || i.Task != nil || i.Parent != nil ||
			i.Schedule != nil || protocol.IsForManager(i)
	})
	slices.SortStableFunc(mine, func(a, b protocol.Issue) int { return cmp.Compare(b.CreatedAt, a.CreatedAt) })
	out := []string{}
	for _, i := range mine {
		title := strings.Join(strings.Fields(i.Title), " ")
		if title == "" || utf8.RuneCountInString(title) > recentTitleLength || slices.Contains(out, title) {
			continue
		}
		if out = append(out, title); len(out) == recentTitles {
			break
		}
	}
	return out
}

func filledKinds(kinds []protocol.TemplateKind, stack protocol.ProjectStack) []protocol.TemplateKind {
	for i := range kinds {
		for j := range kinds[i].Templates {
			kinds[i].Templates[j] = filledTemplate(kinds[i].Templates[j], stack)
		}
	}
	return kinds
}

var commandHoles = regexp.MustCompile(`\s?\{(test|lint|build)\}\s?`)

// A known command goes in as code, spaced from the words around it; an unknown one is a plain word, unspaced as Chinese is.
func filledTemplate(s protocol.IssueTemplate, stack protocol.ProjectStack) protocol.IssueTemplate {
	commands := map[string]string{"test": stack.Test, "lint": stack.Lint, "build": stack.Build}
	words := map[string]string{"test": "测试", "lint": "代码检查", "build": "构建"}
	s.Done = commandHoles.ReplaceAllStringFunc(s.Done, func(hole string) string {
		name := commandHoles.FindStringSubmatch(hole)[1]
		if cmd := commands[name]; cmd != "" {
			return strings.Replace(hole, "{"+name+"}", "`"+cmd+"`", 1)
		}
		return words[name]
	})
	s.Text = s.Title + "\n做到什么程度算完：" + s.Done
	s.Blank = firstBlank(s.Text)
	return s
}

func firstBlank(text string) *protocol.TemplateBlank {
	start := strings.Index(text, "〔")
	if start < 0 {
		return nil
	}
	end := strings.Index(text[start:], "〕")
	if end < 0 {
		return nil
	}
	end += start + len("〕")
	return &protocol.TemplateBlank{Start: int64(str.Units(text[:start])), End: int64(str.Units(text[:end]))}
}
