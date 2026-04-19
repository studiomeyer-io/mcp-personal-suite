# StudioMeyer Open Source Ecosystem

`mcp-personal-suite` is part of a family of Claude / MCP tools maintained by
[StudioMeyer](https://studiomeyer.io). Each project is self-contained; they
just happen to compose well.

## Related open-source projects

- **[local-memory-mcp](https://github.com/studiomeyer-io/local-memory-mcp)** —
  Persistent local memory for Claude, Cursor, Codex. SQLite + FTS5 + knowledge
  graph, stdio-only, zero cloud. Pairs with Personal Suite for full local agent
  context plus actions.
- **[mcp-video](https://github.com/studiomeyer-io/mcp-video)** — Cinema-grade
  video production MCP server. ffmpeg + Playwright, 8 consolidated tools.
- **[agent-fleet](https://github.com/studiomeyer-io/agent-fleet)** — Multi-agent
  orchestration for Claude Code CLI. 7 agents, MCP tool integration.
- **[ai-shield](https://github.com/studiomeyer-io/ai-shield)** — LLM security
  for TypeScript. Prompt injection detection, PII, cost control.
- **[darwin-agents](https://github.com/studiomeyer-io/darwin-agents)** —
  Self-evolving agent framework. A/B testing of prompts, multi-model critics.
- **[email-mcp](https://github.com/studiomeyer-io/email-mcp)** — Standalone
  email MCP (the ancestor of Personal Suite's email module).
- **[mcp-server-searxng](https://github.com/studiomeyer-io/mcp-server-searxng)**
  — Standalone SearXNG search MCP.

## How Personal Suite connects

Personal Suite *is* the actions layer: email, calendar, messaging, search,
image generation. It handles *doing things*. `local-memory-mcp` handles
*remembering things across sessions*. Install both, wire both into your MCP
client, and the assistant gets durable memory plus the ability to act on it.

## Discussion

- Issues: [github.com/studiomeyer-io/mcp-personal-suite/issues](https://github.com/studiomeyer-io/mcp-personal-suite/issues)
- Discussions: [github.com/studiomeyer-io/mcp-personal-suite/discussions](https://github.com/studiomeyer-io/mcp-personal-suite/discussions)
- Website: [studiomeyer.io](https://studiomeyer.io)
