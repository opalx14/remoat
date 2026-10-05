# Remoat MCP

Standalone MCP bridge for interacting with Antigravity through Chrome DevTools Protocol (CDP).

This directory is intentionally isolated from the Remoat application source:

- no imports from `../src/**`
- no changes to the root `package.json`
- no dependency on Telegram bot internals
- no dependency on Remoat database/session code
- safe to keep while syncing the fork with upstream Remoat

## Architecture

```text
Antigravity / local MCP client
        |
      stdio
        |
        v
   Remoat MCP
        |
       CDP
        v
  Antigravity IDE

ChatGPT Web
        |
      HTTPS
        |
        v
https://remoat.promptmarketcap.net/mcp
        |
  Cloudflare Tunnel
        |
        v
http://127.0.0.1:7680/mcp
        |
  OAuth-protected Remoat MCP
        |
       CDP
        v
  Antigravity IDE
```

## Runtime

Bun is the primary runtime.

```bash
cd /Users/opalx14/GitHub/remoat/mcp
bun install
```

## Local stdio MCP

Use this for Antigravity or another MCP client running on the same Mac:

```bash
bun run start:stdio
```

Example MCP client config:

```json
{
  "mcpServers": {
    "remoat-antigravity": {
      "command": "bun",
      "args": [
        "/Users/opalx14/GitHub/remoat/mcp/src/index.ts"
      ]
    }
  }
}
```

## ChatGPT Web / remote MCP

Remote mode uses Streamable HTTP + OAuth 2.1 style discovery/PKCE + Cloudflare Tunnel.

Configured endpoints:

```text
Local MCP : http://127.0.0.1:7680/mcp
Public MCP: https://remoat.promptmarketcap.net/mcp
Authorize : https://remoat.promptmarketcap.net/authorize
Health    : https://remoat.promptmarketcap.net/healthz
```

Start both the HTTP server and tunnel:

```bash
cd /Users/opalx14/GitHub/remoat/mcp
bash scripts/start.command --no-wait
```

Run without `--no-wait` when launching interactively and you want the terminal window to stay open.

Stop both:

```bash
bash scripts/stop.command
```

Logs:

```bash
tail -f /tmp/remoat-mcp.log
tail -f /tmp/remoat-mcp-cloudflared.log
```

### Secrets

Remote configuration is stored in:

```text
mcp/.env.local
```

This file is ignored by Git. It contains the owner password used only on the OAuth approval page.

Do not copy that password into source code or Cloudflare configuration.

The launcher prints the owner password locally when it starts. It can also be inspected locally with:

```bash
grep '^REMOAT_MCP_OWNER_PASSWORD=' .env.local
```

OAuth client/token state is stored outside the repository under:

```text
~/.remoat-mcp/oauth-state.json
```

The state file is written with user-only permissions.

## Connect from ChatGPT

In a ChatGPT workspace/account that supports custom MCP apps:

1. Enable Developer Mode / custom apps.
2. Create a custom MCP app.
3. Use this endpoint:

   ```text
   https://remoat.promptmarketcap.net/mcp
   ```

4. Choose OAuth when ChatGPT discovers the server authentication metadata.
5. When the Remoat approval page opens, paste the owner password from `.env.local`.
6. Let ChatGPT scan the tools.
7. Test first with `antigravity_status` or `list_antigravity_targets` before using write actions.

The MCP server publishes standard discovery endpoints under `/.well-known/` and supports dynamic client registration, authorization code + PKCE, access tokens, and refresh tokens.

## Remote smoke test

With the HTTP server and Cloudflare tunnel running:

```bash
bun run check:remote
```

The smoke test verifies:

- dynamic OAuth client registration
- owner approval page
- PKCE authorization code exchange
- access token issuance
- refresh token issuance
- remote MCP `initialize`
- remote MCP `tools/list`
- Antigravity status when the execution environment permits the final read-only tool call

The test never calls `send_prompt`.

## Antigravity requirement

Antigravity must run with a Chrome DevTools remote-debugging port. The bridge scans:

```text
9222, 9223, 9333, 9444, 9555, 9666
```

The existing Remoat launcher already starts Antigravity in this mode.

## MCP tools

### `antigravity_status`

Checks whether an Antigravity workbench is reachable and returns detected workbench targets.

### `list_antigravity_targets`

Lists visible CDP targets. Use this before other tools when several Antigravity windows are open.

Project routing is fail-closed: if more than one Antigravity workbench is open and a project-scoped tool call omits `targetId`, Remoat MCP returns an error instead of picking the first window. Reuse the exact `targetId` returned for the intended project on subsequent calls. An explicit `targetId` that points to a non-Antigravity target is also rejected.

### `run_antigravity_task`

Preferred tool for normal ChatGPT-driven work. Tasks are serialized per Antigravity target using the same high-level semantics as Remoat core: one running task plus up to three pending tasks. Pending tasks stay in the MCP queue and are not injected into Antigravity's native `Queued Messages` UI. When a task reaches the front of the queue it can optionally select a model/mode, captures the current response as a baseline, submits the prompt, waits for generation to start, then waits until the stop control is gone and the response remains stable for multiple polls before returning the final response.

Arguments:

```json
{
  "prompt": "Review the current changes and fix the failing test",
  "workspacePath": "/Users/me/GitHub/my-project",
  "targetId": "optional-cdp-target-id",
  "timeoutSeconds": 600,
  "model": "Gemini 3.8 Flash High",
  "mode": "fast"
}
```

`workspacePath` is the preferred routing key. If that project is not currently open, Remoat MCP launches a new Antigravity window for the exact full path, rescans all configured CDP ports, waits for the matching workbench target, and only then sends the task. It never falls back to another open project. When both `workspacePath` and `targetId` are supplied, the target must match the requested project or the call is refused.

The default timeout is 600 seconds and the allowed range is 10–900 seconds. Queue wait time is reported separately and does not consume the task execution timeout.

### `antigravity_queue_status`

Reports whether the selected target is running an MCP task and how many tasks are pending. The queue depth matches Remoat core semantics: at most three pending requests per target.

### `list_models` / `get_model` / `set_model`

Read and control the model selector from the live Antigravity UI. Current Antigravity builds use a model menu with effort submenus such as `Gemini 3.8 Flash High/Medium/Low`; the MCP adapter supports those nested effort choices and verifies the selection from the model selector label after changing it. Model mutations are serialized through the same per-target task queue.

### `get_mode` / `set_mode`

Compatibility tools for Antigravity builds that expose the older Fast/Planning mode toggle. The current tested Antigravity UI may not expose this toggle; `get_mode` reports `supported: false` in that case and `set_mode` refuses rather than pretending the mode changed.

### `send_prompt`

Fire-and-forget write action. It only submits when both the Remoat MCP target queue and Antigravity generation state are idle. If the target is busy it refuses the injection instead of creating an Antigravity native queued message. Prefer `run_antigravity_task` unless asynchronous behavior is explicitly desired.

The bridge deliberately uses panel/conversation-scoped input selectors and refuses to type when a safe Antigravity composer cannot be identified.

Arguments:

```json
{
  "prompt": "Review the current changes and fix the failing test",
  "workspacePath": "/Users/me/GitHub/my-project",
  "targetId": "optional-cdp-target-id"
}
```

### `get_latest_response`

Reads the latest visible assistant response from the Antigravity panel.

### `stop_generation`

Stops the active Antigravity generation when a stop control is available.

### `screenshot_antigravity`

Returns a PNG screenshot as MCP image content.

## Cloudflare tunnel

The dedicated tunnel is separate from DevSpace:

```text
name: remoat-mcp
hostname: remoat.promptmarketcap.net
origin: http://127.0.0.1:7680
```

Repository configuration:

```text
mcp/config/cloudflared.yml
```

The Cloudflare tunnel credential JSON stays under `~/.cloudflared/` and is never committed to this repository.

## Verification

```bash
bun test
bunx tsc --noEmit
bun run check:remote
```

## Isolation contract

Code under `mcp/` may inspect Antigravity's CDP surface and DOM contract, but it must not import Remoat application modules directly.

If upstream Remoat changes its internal directory layout, this package should continue working unchanged. Changes should only be required when Antigravity itself changes its CDP/DOM behavior or the MCP protocol/authentication requirements change.
