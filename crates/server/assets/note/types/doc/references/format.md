# Doc JSON Format (`structure/doc.json`)

`structure/doc.json` stores a serialized `DocDocument`:

```json
{
  "version": 1,
  "blocks": [
    {
      "id": "b1",
      "type": "heading",
      "level": 1,
      "text": "Architecture Overview",
      "children": []
    },
    {
      "id": "b2",
      "type": "prose",
      "text": "See [[note:note_01]] and #42 for context."
    }
  ]
}
```

Supported 24 `BlockKind` primitives (`type` discriminator):
- **Basic**: `prose`, `heading`, `list`, `todo`, `quote`, `divider`
- **Structure & Writing**: `toggle`, `callout`, `code`, `table`, `bookmark`, `toc`, `math`, `columns`, `pageBreak`
- **Data & VibeValley**: `kpi`, `chart`, `diagram`, `compare`, `media`, `preview`, `baseEmbed`, `issueCard`, `issueList`
