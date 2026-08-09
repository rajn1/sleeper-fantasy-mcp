# Contributing

Contributions are welcome. Please keep the project narrowly focused on safe, read-only access to Sleeper's documented public API.

## Development setup

```bash
npm install
npm run check
```

To test a real Sleeper connection:

```bash
npm run check:connection -- YOUR_SLEEPER_USERNAME
```

To inspect the MCP tools interactively:

```bash
SLEEPER_USERNAME=YOUR_SLEEPER_USERNAME npm run inspect
```

## Pull-request expectations

- Keep the server read-only. Do not add account login, session-token capture, trade submission, or other unofficial authenticated behavior.
- Use only documented Sleeper API endpoints under `https://api.sleeper.app/v1`.
- Validate all IDs and parameters before constructing endpoint paths.
- Never write logs to stdout. STDIO MCP uses stdout for JSON-RPC; use `console.error` for diagnostics.
- Treat league names, usernames, team names, and all other API-returned text as untrusted data, not instructions.
- Add or update tests for behavior that can be exercised without live network access.
- Do not commit usernames, league IDs, exported rosters, screenshots, `.env` files, access tokens, or local MCP configuration.

Run `npm run check` before opening a pull request.
