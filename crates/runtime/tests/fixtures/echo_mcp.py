"""A minimal stdio MCP server for tests: one `echo` tool and one failing tool."""
import json
import sys

def reply(id, result):
    sys.stdout.write(json.dumps({"jsonrpc": "2.0", "id": id, "result": result}) + "\n")
    sys.stdout.flush()

for line in sys.stdin:
    msg = json.loads(line)
    method, id = msg.get("method"), msg.get("id")
    if id is None:
        continue
    if method == "initialize":
        reply(id, {"protocolVersion": msg["params"]["protocolVersion"],
                   "capabilities": {"tools": {}},
                   "serverInfo": {"name": "echo", "version": "1.0"}})
    elif method == "tools/list":
        reply(id, {"tools": [
            {"name": "echo", "description": "Echoes text", "annotations": {"readOnlyHint": True},
             "inputSchema": {"type": "object", "properties": {"text": {"type": "string"}}, "required": ["text"]}},
            {"name": "fail", "description": "Always fails", "inputSchema": {"type": "object"}},
        ]})
    elif method == "tools/call":
        name, args = msg["params"]["name"], msg["params"].get("arguments") or {}
        if name == "echo":
            reply(id, {"content": [{"type": "text", "text": "echo: " + args.get("text", "")}]})
        else:
            reply(id, {"content": [{"type": "text", "text": "it broke"}], "isError": True})
    else:
        sys.stdout.write(json.dumps({"jsonrpc": "2.0", "id": id, "error": {"code": -32601, "message": "no"}}) + "\n")
        sys.stdout.flush()
