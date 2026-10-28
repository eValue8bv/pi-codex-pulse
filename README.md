# Pi Codex Pulse

Codex subscription usage and remaining limits in [Pi](https://pi.dev).

```text
codex · 70% 5h ↻2h14m (16:30) · 40% 1w ↻3d (Thu 16:30) · 12.5 usage credits · 2 reset credits
```

## Installation

```sh
pi install git:github.com/eValue8bv/pi-codex-pulse
```

Restart Pi or run `/reload` to load the extension.

### Requirements

- Node.js 22.19 or newer.
- Pi 1.4.0 or newer.
- A Codex subscription login in Pi (`/login`) or [Codex CLI](https://github.com/openai/codex) (`codex login`).

## Features

- Fresh usage reports with `/codex-usage`.
- A compact footer that refreshes every minute while you use a Codex model.
- Manual-only mode and user-level authentication-source preferences.
- Account-checked stale snapshots when a refresh fails.
- Remaining and used percentages, reset countdowns, and local reset times.
- Model-specific limits when your account provides them.
- Usage-credit balances and reset-credit counts.
- Warnings for reset credits that expire within eight days.
- Reset-credit redemption through Pi authentication with two-step confirmation.
- Colours from your active Pi theme.

Usage reporting is read-only. `/codex-redeem-reset` can consume one banked reset credit after you confirm the account and credit.

## Usage

```text
/codex-usage
```

The report includes your plan, authentication source, query time, and available limits:

```text
>_ OpenAI Codex Usage
Checked: ...
Source: Pi auth (direct)
Plan: Pro
Reset credits: 2

Codex:
  5h limit: [██████████████░░░░░░] 70% left, 30% used; resets ...
  1w limit: [████████░░░░░░░░░░░░] 40% left, 60% used; resets ...
  Usage credits: 12.5
```

Each `/codex-usage` invocation fetches fresh usage. To allow more time for a request:

```text
/codex-usage --timeout 30
```

The timeout accepts 1-120 seconds and defaults to 15 seconds. It applies to each request or Codex CLI operation, so a query with multiple operations can take longer.

### Footer

The footer appears when you select an `openai-codex` model and clears when you switch to another provider. It refreshes once per minute and uses model-specific limits when available. CLI results include a `(CLI)` label.

If a refresh fails, the footer keeps the last successful snapshot only when Pi can still identify the same account. It marks those values **stale** and shows their age. Switching models or authentication sources clears the snapshot. CLI results and results without a stable account identity are not retained after failure.

Each limit shows the remaining percentage, window duration, and reset time. Reset times use your local timezone. Your account determines the available windows; they are not restricted to five hours and one week.

### Credits

**Usage credits** are your additional usage balance.

**Reset credits** are banked entitlements to reset eligible subscription limits. The report lists known expiration dates, and the footer warns when a credit expires within eight days.

### Redeem a reset credit

Use an interactive Pi terminal with a Pi OpenAI Codex subscription login:

```text
/codex-redeem-reset
```

The command selects a usable credit with the earliest known expiry. It uses a credit with unknown expiry only when no dated, unexpired credit is available. Read the Pi account ID and credit expiry in the confirmation prompts:

1. Type `y` to continue.
2. Type the displayed four-digit challenge to redeem.

Press Escape or enter a different answer to cancel. The command accepts no arguments or confirmation bypass. It is not an agent tool and does not work in print, JSON, or RPC mode.

Redemption requires Pi authentication in `auto` or `pi` source mode. It does not use CLI credentials or change your source preference. If you selected CLI, use `/login` and `/codex-usage source pi` before redeeming.

Before submission, the command checks the account, source, and selected credit again. Account changes, session/model changes, or an expired or missing credit cancel the attempt. The command does not substitute a different credit after confirmation. Each network request has a 15-second timeout.

**An unknown outcome can mean that a credit was consumed.** A connection failure, timeout, or unexpected server response after submission does not prove failure. The extension does not retry the write. Check `/codex-usage` before attempting another redemption; a new attempt uses a new request ID.

After submission, the extension clears old usage snapshots and requests fresh usage, including in manual-only mode. A failed refresh does not undo a successful redemption. The extension blocks overlapping redemption commands in the same session; other sessions and devices can still consume credits.

## Preferences

Disable background requests and query usage only when you need it:

```text
/codex-usage polling off
/codex-usage
```

Enable automatic refreshes again:

```text
/codex-usage polling on
```

Choose which login supplies usage:

```text
/codex-usage source auto
/codex-usage source pi
/codex-usage source codex-cli
```

Preferences apply to your user account, not the current project. The commands save them in `~/.pi/agent/codex-pulse.json` (or your custom `PI_CODING_AGENT_DIR`):

```json
{
  "source": "auto",
  "polling": true
}
```

Run `/reload` after editing this file by hand. Invalid settings stop background queries until you fix the file and reload. In manual-only mode, a requested footer snapshot includes its capture time. JSON, print, and RPC sessions do not start background polling.

## Authentication

In **auto** mode, Pi Codex Pulse uses your Pi OpenAI Codex login. If no Pi login is configured, it uses a temporary Codex CLI app-server process.

**A failed Pi request does not switch to CLI.** Pi and Codex CLI can use different accounts, and the CLI account API does not expose enough identity information to prove that they match. Choose `source codex-cli` explicitly to use that login instead. An API-key-only CLI login cannot read subscription limits.

In **pi** mode, the extension uses only Pi authentication. In **codex-cli** mode, it uses only the CLI login.

Usage snapshots stay in memory. Background requests run only in the interactive terminal while a Codex model is selected and polling is enabled. The extension redacts common credential patterns from errors; review diagnostic output before sharing it.

This is an unofficial integration with ChatGPT and Codex. Upstream changes can affect compatibility.

## Troubleshooting

**No usage available:** Run `/login` in Pi and choose the OpenAI Codex subscription login. To use CLI instead, run `codex login` with a ChatGPT account, then `/codex-usage source codex-cli`.

**Codex CLI cannot start:** Check that `codex --version` works in the terminal where you launch Pi.

**Requests time out:** Try `/codex-usage --timeout 30`.

**No footer:** Select an `openai-codex` model. You can still run `/codex-usage` while another provider is selected.

## Uninstall

```sh
pi remove git:github.com/eValue8bv/pi-codex-pulse
```

## License

[MIT](LICENSE). Copyright (c) 2026 eValue8 B.V.
