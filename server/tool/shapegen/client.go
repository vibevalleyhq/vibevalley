package main

import (
	"fmt"
	"strings"
)

// goClient writes the Go Client's methods (one per Handlers method, over HTTP, as Mount reads them) and taggedError, which
// turns an answered error back into its type.
func (s *shapes) goClient(b *strings.Builder) {
	b.WriteString("\n// taggedError decodes body as the API error its tag names; nil for a tag that is none.\nfunc taggedError(tag string, body []byte) error {\n\tswitch tag {\n")
	for _, d := range s.decls {
		if d.status == "" {
			continue
		}
		fmt.Fprintf(b, "\tcase %q:\n\t\tvar e %s\n\t\tif json.Unmarshal(body, &e) != nil {\n\t\t\treturn nil\n\t\t}\n\t\treturn e\n", d.name, d.name)
	}
	b.WriteString("\t}\n\treturn nil\n}\n")
	for _, r := range s.routes {
		var sig, query []string
		path := fmt.Sprintf("%q", r.path)
		body := "nil"
		for _, p := range r.params {
			t := s.text(p.typ)
			sig = append(sig, p.name+" "+t)
			switch {
			case p.source == paramBody:
				body = "body"
			case p.source == paramQuery:
				v := "*" + p.name
				if t == "*int64" {
					v = "strconv.FormatInt(*" + p.name + ", 10)"
				}
				query = append(query, fmt.Sprintf("\tif %s != nil {\n\t\tq.Set(%q, %s)\n\t}\n", p.name, p.wire, v))
			default:
				v := "string(" + p.name + ")"
				if t == "int64" {
					v = "strconv.FormatInt(" + p.name + ", 10)"
				} else if t == "string" {
					v = p.name
				}
				path = strings.Replace(path, "{"+p.wire+"}", `"+url.PathEscape(`+v+`)+"`, 1)
			}
		}
		path = strings.TrimSuffix(strings.ReplaceAll(path, `+""`, ""), `+""`)
		q := "nil"
		pre := ""
		if len(query) > 0 {
			q = "q"
			pre = "\tq := url.Values{}\n" + strings.Join(query, "")
		}
		params := strings.Join(append([]string{"ctx context.Context"}, sig...), ", ")
		if r.result == nil {
			fmt.Fprintf(b, "\nfunc (c *Client) %s(%s) error {\n%s\treturn c.call(ctx, %q, %s, %s, %s, nil)\n}\n", r.goName, params, pre, r.method, path, q, body)
			continue
		}
		res := s.text(r.result)
		fmt.Fprintf(b, "\nfunc (c *Client) %s(%s) (%s, error) {\n%s\tvar out %s\n\terr := c.call(ctx, %q, %s, %s, %s, &out)\n\treturn out, err\n}\n", r.goName, params, res, pre, res, r.method, path, q, body)
	}
}
