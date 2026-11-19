"""Report wire events to a test-side socket while a tool request is outstanding."""
import json
import os
import socket
import sys


def reply(source, result):
    print(json.dumps({"jsonrpc": "2.0", "id": source["id"], "result": result}), flush=True)


with socket.create_connection(("127.0.0.1", int(os.environ["MCP_TEST_PORT"]))) as events:
    events.sendall(f"{os.getpid()}\n".encode())
    for line in sys.stdin:
        msg = json.loads(line)
        method = msg.get("method")
        if method == "initialize":
            reply(msg, {"protocolVersion": msg["params"]["protocolVersion"],
                        "capabilities": {"tools": {}}, "serverInfo": {"name": "cancellable", "version": "1"}})
        elif method == "tools/list":
            reply(msg, {"tools": [{"name": "wait", "inputSchema": {"type": "object"}}]})
        elif method == "tools/call":
            if msg["params"].get("arguments", {}).get("ping"):
                reply(msg, {"content": [{"type": "text", "text": "pong"}]})
            else:
                events.sendall(f"begin:{msg['id']}\n".encode())
        elif method == "notifications/cancelled":
            events.sendall(f"cancel:{msg['params']['requestId']}\n".encode())
