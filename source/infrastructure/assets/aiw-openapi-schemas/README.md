These OpenAPI specs are **starter** schemas used by AIW Phase 1 to provision a per-tenant MCP gateway automatically.

- They are intentionally minimal (MVP endpoints only).
- They are uploaded into the GAAB deployments bucket at deploy time under:
  - `mcp/schemas/openApiSchema/<uuid>.yaml`
- The platform SSM parameter `ToolConnectionMcpSchemaUris` points at these keys so `tenant-provision-subscriber` can deploy the gateway without any manual UI “upload schema” step.

If you need more endpoints, extend these specs (or replace them with vendor-full specs) and redeploy `DeploymentPlatformStack`.

| File suffix | Integration |
|-------------|-------------|
| …0101 | Gmail |
| …0102 | Google Drive |
| …0103 | Dropbox |
| …0104 | Figma |
| …0105 | Discord (post message; typically used via AIW custom MCP + bot token) |
| …0106 | GitHub (read/commit/PR subset; AIW custom MCP + fine-grained PAT) |
| …0107 | Jira Cloud (read/search/comment; AIW custom MCP + API token) |
| …0108 | Slack (post message; AIW custom MCP + bot token) |

