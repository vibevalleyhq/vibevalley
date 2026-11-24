# diagram: Engineering & Technical Diagrams

`diagram` captures semantically strict engineering diagrams—architecture topologies, sequence diagrams, entity-relationship (ER) schemas, state machines, and data-flow graphs. Stored as a directory in `storage/` (`<storage>/artifact/<id>/`), the canonical graph lives in `structure/diagram.json` and/or declarative Mermaid source `structure/diagram.mmd`, with optional icons or vector exports in `asset/`.

## Directory Layout

```text
<storage>/artifact/<id>/
├── manifest.json             # id, artifactType: "diagram", title, diagramKind, entry
├── structure/
│   ├── diagram.json          # Typed nodes, boundary groups, directed edges, layout hints
│   └── diagram.mmd           # Optional Mermaid source (ideal for sequence, ER, state graphs)
└── asset/
    └── custom-icon.svg       # Optional node icons or exports via asset/<name>
```

Example `manifest.json`:
```json
{
  "id": "art_diag_01",
  "artifactType": "diagram",
  "title": "Artifact Storage & Realtime Collab Topology",
  "diagramKind": "architecture",
  "entry": "structure/diagram.json"
}
```

## Multi-Human & Multi-Agent Collaboration Rules

1. **Semantic CRDT sync (`artifact_collab`)**: `structure/diagram.json` keys nodes, groups, and edges by stable IDs; `structure/diagram.mmd` merges via text CRDT. Multiple humans and agents can document distinct boundaries concurrently without clobbering sibling subgraphs or resetting node IDs.
2. **Origin-tracked architecture evolution (`artifact_change`)**: Every node, boundary, and edge mutation carries its `origin` for design-review replay, undo-by-origin, and alternative topology forks; freeze approved architecture cuts with `artifact_version`.
3. **Review suggestions (`artifact_suggestion`)**: Propose tracked suggestions with rationale before altering human-approved system boundaries, ownership arrows, or state transitions.
4. **Live presence awareness**: Check which group or node collaborators are currently focusing on before modifying connected edges.

## Engineering Diagram Rules

- **Semantics over decoration**: Unlike freeform `whiteboard` boards, `diagram` enforces exact dependency direction, explicit trust/module boundaries, and labeled edges (protocol, event, or payload).
- **One abstraction level per diagram**: Keep topology, request sequence, ER schema, and state machine cleanly separated instead of cramming every concern onto one graph.

Further references: `artifact_type_read({ type: "diagram", reference: "format" | "craft" })`.
