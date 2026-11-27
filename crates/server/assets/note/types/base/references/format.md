# Base JSON Format (`structure/base.json`)

```json
{
  "version": 1,
  "sheets": [
    {
      "id": "sheet_1",
      "name": "Tasks",
      "columns": [
        { "id": "col_title", "name": "Title", "kind": "text" },
        {
          "id": "col_agent",
          "name": "Run Agent",
          "kind": "agentAction",
          "agentConfig": {
            "promptTemplate": "Investigate: {{Title}}",
            "spawnIssueRepo": null,
            "targetColumnId": "col_title"
          }
        }
      ],
      "rows": [],
      "views": [
        { "id": "view_table", "name": "All Rows", "kind": "table" }
      ]
    }
  ]
}
```
