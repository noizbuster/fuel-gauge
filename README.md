# Fuel Gauge

Fuel Gauge is an interactive terminal dashboard for monitoring AI coding-service quotas across multiple providers from one place.

## Supported sources

- GitHub Copilot
- Codex
- Antigravity
- Claude Code
- Kiro
- Cursor
- Oh My Pi
- OpenCode
- FuelGauge API-key sources

## Requirements

- A terminal with TTY support for the interactive dashboard

## Install

```sh
npm install --global fuel-gauge
```

Both installed commands launch the same dashboard:

```sh
fuel-gauge
fgg
```

Fuel Gauge discovers compatible local credentials automatically. Use the **Auth** tab to import, add, remove, or reauthenticate accounts supported by each source.

## Usage

Run Fuel Gauge in an interactive terminal:

```sh
fuel-gauge
```

When stdin or stdout is not a TTY, Fuel Gauge prints one cached, token-free snapshot without performing network requests or starting authentication flows:

```sh
fuel-gauge | cat
```

Clear cached accounts while preserving settings:

```sh
fuel-gauge --clear-cache
```

The next interactive launch imports compatible local accounts again.

## Keys

| Key | Action |
| --- | --- |
| `Tab` / `Shift+Tab` | Switch tabs |
| `j` / `k` or arrow keys | Move selection |
| `Enter` | Open or confirm the selection |
| `Esc` | Close an overlay or cancel authentication |
| `r` | Refresh the selected source |
| `R` | Refresh all sources sequentially |
| `a` | Open account management |
| `h` | Manage account visibility |
| `x` / `X` | Hide the selected account / show all accounts |
| `s` | Open settings |
| `?` | Open help |
| `q` | Quit |

## Credentials and privacy

Credentials are stored in private local files. UI state and non-interactive snapshots use token-free account summaries; credential values are not rendered or logged. Provider requests are made directly from the local process.

## Development

```sh
npm install
npm run typecheck
npm run lint
npm test
npm run build
```

Run the built CLI end-to-end tests with:

```sh
npm run build
npm run test:dist
```

## License

MIT
