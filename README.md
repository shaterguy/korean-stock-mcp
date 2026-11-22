# korean-stock-mcp

Read-only local MCP service for the PlayMCP Korean-stock interface. It exposes 16 compatible tools backed by public, no-secret Naver Finance and OpenDART sources. The Termux service binds to 127.0.0.1:17846, serves Streamable HTTP at /mcp, and reports readiness at /health.

## Install and verify

Requires Node.js 24.x. After cloning, run npm ci and npm run check; use npm run start:local to start the loopback MCP server. Installed node_modules/ dependencies are intentionally excluded from Git and are restored reproducibly from package-lock.json.
