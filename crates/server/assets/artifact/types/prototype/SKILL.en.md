# prototype: Runnable Interactive Web Prototype

`prototype` builds clickable, sandbox-runnable HTML/CSS/JS web prototypes for flow validation, micro-interactions, and interactive product demos. Stored as a directory in `storage/` (`<storage>/artifact/<id>/`), markup lives in `structure/index.html`, styling in `structure/styles.css`, logic in `structure/app.js`, and media in `asset/`.

## Directory Layout

```text
<storage>/artifact/<id>/
├── manifest.json             # id, artifactType: "prototype", title, entry: "structure/index.html"
├── structure/
│   ├── index.html            # Semantic HTML shell loading ./styles.css and ./app.js
│   ├── styles.css            # Styles & CSS variables (inherits optional designSystemId tokens)
│   ├── app.js                # Zero-build ES Module state machine and DOM event handlers
│   └── data.json             # Optional mock fixtures decoupled from UI logic
└── asset/
    └── demo-cover.png        # Local media referenced via relative path asset/<name>
```

Example `manifest.json`:
```json
{
  "id": "art_proto_01",
  "artifactType": "prototype",
  "title": "Fast Approval Flow Prototype",
  "entry": "structure/index.html",
  "designSystemId": null,
  "viewport": { "width": 1280, "height": 800 }
}
```

## Multi-Human & Multi-Agent Collaboration Rules

1. **Separated-file CRDT sync (`artifact_collab`)**: Keeping markup (`index.html`), styling (`styles.css`), interaction (`app.js`), and fixtures (`data.json`) in separate files lets humans and agents iterate concurrently while `artifact_collab` merges edits cleanly. Never rewrite untouched files.
2. **Origin-tracked iterations (`artifact_change`)**: Every code or copy edit records its `origin` for replay, undo-by-origin, and A/B interaction forks; freeze usability-test builds with `artifact_version`.
3. **Review suggestions (`artifact_suggestion`)**: Submit tracked suggestions when altering human-authored copy, interaction states, or visual styles.
4. **Live presence awareness**: Check which file collaborators currently edit (`styles.css` vs `app.js`) and avoid colliding on the same function or rule block.

## Sandbox & Runtime Rules

- **Zero-build runnable**: Write standard HTML5, modern CSS, and browser-native ES Modules so the prototype runs immediately with no bundler step.
- **Strict sandbox hygiene**: Reference local files via relative paths (`./styles.css`, `./app.js`, `asset/...`); avoid external network calls, `<meta http-equiv="refresh">`, `<base href>`, nested `<iframe>`, and native form posts (handle submits in `app.js`).

Further references: `artifact_type_read({ type: "prototype", reference: "format" | "craft" })`.
