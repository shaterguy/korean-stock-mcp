# korean-stock-mcp

WORK-A compatibility skeleton for the PlayMCP Korean-stock interface. It is read-only and uses only public no-secret Naver Finance endpoints plus the existing public OpenDART MCP. The current WORK-A tree is intentionally not registered as a permanent TMCP service; registration/service/GitHub preservation are reserved for the post-MID_REVIEW work.

## Install and verify

Requires Node.js 24.x. After cloning, run npm ci and npm run check; use npm run start:local to start the loopback MCP server. Installed node_modules/ dependencies are intentionally excluded from Git and are restored reproducibly from package-lock.json.
