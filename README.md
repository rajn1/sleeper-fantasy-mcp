# Sleeper Fantasy Football MCP

A local, read-only Model Context Protocol server that gives ChatGPT desktop and Codex fresh context from Sleeper fantasy-football leagues.

The server is designed for questions such as:

- Is this dynasty roster ready to contend?
- Which players should I cut before the draft?
- How does a proposed trade affect both teams?
- Who owns each future rookie pick?
- What trades and waiver moves happened recently?
- How do all rosters in the league compare?

It uses Sleeper's public API. No Sleeper password, API key, session cookie, or account token is required.

## Capabilities

The MCP server can retrieve:

- Sleeper account identity and current NFL state
- Leagues for a selected season
- League settings, scoring, lineup slots, records, and owners
- Your roster or every roster, with player IDs resolved to names
- Starters, bench, reserve, taxi squad, and keepers
- Future draft-pick ownership and traded picks
- Focused context for evaluating a proposed trade
- Completed trades, waivers, and free-agent transactions
- Weekly matchups and lineups
- Live or completed draft boards
- Trending additions and drops
- Player-name search

## Important limitation

Sleeper's documented public API does not expose the private inbox containing unaccepted incoming or outgoing trade proposals. Paste or screenshot the offer itself; the MCP can then pull the live league rules, both rosters, records, and draft-pick inventories needed to analyze it.

This project cannot send, accept, reject, or cancel trades. It deliberately avoids unofficial authenticated endpoints and Sleeper session tokens.

## Requirements

- macOS, Linux, or Windows with a compatible MCP host
- Node.js 20 or newer
- npm
- A Sleeper username
- ChatGPT desktop, Codex CLI, or another STDIO-capable MCP client

## Quick start

Clone or download the repository, then run:

```bash
cd /path/to/sleeper-fantasy-mcp
chmod +x scripts/*.sh
./scripts/setup-mac.sh YOUR_SLEEPER_USERNAME
```

The setup helper:

1. Checks Node.js and npm.
2. Installs dependencies.
3. Runs local syntax and unit tests.
4. Verifies the Sleeper username.
5. Lists the current-season leagues it finds.
6. Prints the exact local MCP command and environment variable.

A Sleeper username can change. The setup output also shows the stable Sleeper user ID, which can be supplied through `SLEEPER_USER_ID` instead.

## Connect to ChatGPT desktop

Open **Settings → MCP servers → Add server** and enter:

- **Name:** `Sleeper`
- **Transport:** `STDIO`
- **Command:** the absolute Node path printed by the setup script
- **Arguments:** the absolute `src/index.js` path printed by the setup script
- **Environment:** `SLEEPER_USERNAME=YOUR_SLEEPER_USERNAME`

Save the server and restart ChatGPT desktop. Type `/mcp` in the composer to verify that the server and its tools are available.

Use absolute paths. A macOS desktop application does not always inherit the same shell `PATH` as Terminal.

## Connect to Codex

The setup script prints a command tailored to the current machine. You can also run:

```bash
./scripts/add-to-codex.sh YOUR_SLEEPER_USERNAME
```

The equivalent manual command is:

```bash
codex mcp add sleeper \
  --env SLEEPER_USERNAME=YOUR_SLEEPER_USERNAME \
  -- /absolute/path/to/node /absolute/path/to/sleeper-fantasy-mcp/src/index.js

codex mcp list
```

Codex stores local MCP configuration under `~/.codex/config.toml`. Do not commit that file to this repository.

## Test with MCP Inspector

After installing dependencies:

```bash
SLEEPER_USERNAME=YOUR_SLEEPER_USERNAME npm run inspect
```

The Inspector launches a local client that can list and invoke each tool directly.

## Example prompts

> Use Sleeper to list all of my 2026 leagues and identify which are dynasty, keeper, or redraft.

> Pull my roster and league settings for SHADynasty. Assess whether the roster is ready to contend this season.

> In my DFB league, compare every roster and identify the three weakest players on my team.

> Pull trade context for my team and the other owner's team, then assess this proposal: [paste offer].

> Show the most recent completed trades in this league and explain which teams improved most.

> Pull the current draft board and identify my biggest roster needs before my next pick.

## Tool reference

| Tool | Purpose |
| --- | --- |
| `sleeper_account` | Resolve the configured Sleeper account and current NFL state. |
| `sleeper_list_leagues` | List leagues for a season and identify the user's roster ID. |
| `sleeper_league_overview` | Fetch rules, scoring, teams, records, drafts, and pick ownership. |
| `sleeper_my_roster` | Fetch the user's roster, lineup groups, and draft picks. |
| `sleeper_all_rosters` | Fetch every roster for league-wide comparison. |
| `sleeper_trade_context` | Fetch focused roster, rule, record, and pick context for selected teams. |
| `sleeper_transactions` | Fetch trades, waivers, and free-agent moves by week range. |
| `sleeper_matchups` | Fetch one week's matchups, starters, bench, and points. |
| `sleeper_draft_board` | Fetch draft settings, order, picks, and traded slots. |
| `sleeper_search_players` | Resolve player names to Sleeper player records. |
| `sleeper_trending_players` | Fetch frequently added or dropped players. |

## Configuration

| Environment variable | Required | Description |
| --- | --- | --- |
| `SLEEPER_USERNAME` | Yes, unless using `SLEEPER_USER_ID` | Sleeper username used to locate the account. |
| `SLEEPER_USER_ID` | Optional | Stable user ID; takes precedence over the username. |
| `SLEEPER_DEFAULT_SEASON` | Optional | Four-digit season used when a tool does not provide one. |
| `SLEEPER_CACHE_DIR` | Optional | Override the local directory for the public player cache. |

## Freshness and caching

League settings, rosters, transactions, matchups, drafts, and picks are requested from Sleeper when a tool is called. There is no background synchronization process.

Sleeper's full NFL player directory is much larger, so it is cached for 24 hours at:

```text
~/.cache/sleeper-fantasy-mcp/players-nfl.json
```

Delete that file to force a refresh on the next player-dependent request.

## Privacy and security

- The server is read-only.
- It sends network requests only to `https://api.sleeper.app/v1`.
- It does not collect a Sleeper password or authenticated account token.
- The only local data it writes is Sleeper's public NFL player directory cache.
- League names, usernames, team names, and all other Sleeper-returned text are treated as untrusted data rather than model instructions.
- Raw Sleeper metadata objects are not forwarded unless a known field is required for a feature.

Review [SECURITY.md](SECURITY.md) before expanding the server's permissions or endpoints.

## Development

Install dependencies and run all local checks:

```bash
npm install
npm run check
```

The first `npm install` creates `package-lock.json`. Review and commit that lockfile so subsequent local and CI installs resolve the same dependency graph.

Run only the live connection check:

```bash
npm run check:connection -- YOUR_SLEEPER_USERNAME
```

Start the STDIO server manually:

```bash
SLEEPER_USERNAME=YOUR_SLEEPER_USERNAME npm start
```

The process will appear to wait. That is expected: an STDIO MCP server listens for JSON-RPC requests from its host. Stop it with `Ctrl+C`.

Never use `console.log` in the server process. STDOUT is the MCP protocol channel; diagnostics belong on STDERR through `console.error`.

## Project structure

```text
.
├── .github/                 # CI and dependency updates
├── scripts/                 # Setup, Codex registration, and connection check
├── src/
│   ├── index.js             # MCP server and tool definitions
│   └── sleeper-client.js    # Sleeper API client and response shaping
├── test/                    # Offline unit tests
├── CONTRIBUTING.md
├── SECURITY.md
├── LICENSE
└── README.md
```

## Troubleshooting

### `No Sleeper account is configured`

Add `SLEEPER_USERNAME` or `SLEEPER_USER_ID` to the MCP server environment, then restart the host.

### ChatGPT or Codex cannot find `node`

Run:

```bash
which node
```

Use that complete path as the MCP command.

### The server starts and appears to hang

That is normal when started manually. It is waiting for an MCP client on stdin.

### A renamed Sleeper username no longer resolves

Update `SLEEPER_USERNAME`, or use the stable `SLEEPER_USER_ID` printed by the connection check.

### Player information appears stale

Delete the cached player file:

```bash
rm ~/.cache/sleeper-fantasy-mcp/players-nfl.json
```

The next player-dependent request will download a new copy.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Changes should preserve the read-only security boundary and use only documented public Sleeper endpoints.

## License

MIT. See [LICENSE](LICENSE).

## Disclaimer

This is an independent project and is not affiliated with, endorsed by, or sponsored by Sleeper.
