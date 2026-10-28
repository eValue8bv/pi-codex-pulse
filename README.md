<p align="center">
  <a href="https://github.com/eValue8bv/pi-codex-pulse/releases/latest"><img alt="Latest release" src="https://img.shields.io/github/v/release/eValue8bv/pi-codex-pulse?style=flat&amp;logo=github&amp;label=release" /></a>
  <a href="https://github.com/eValue8bv/pi-codex-pulse/actions/workflows/check.yml"><img alt="CI status" src="https://img.shields.io/github/actions/workflow/status/eValue8bv/pi-codex-pulse/check.yml?event=pull_request&amp;style=flat&amp;label=CI&amp;logo=githubactions&amp;logoColor=white" /></a>
  <a href="https://github.com/eValue8bv/pi-codex-pulse"><img alt="GitHub stars" src="https://img.shields.io/github/stars/eValue8bv/pi-codex-pulse?style=flat&amp;logo=github&amp;label=stars" /></a>
  <a href="https://pi.dev"><img alt="Pi 1.4.0 or newer" src="https://img.shields.io/badge/Pi-%E2%89%A51.4.0-8A5CF6?style=flat" /></a>
  <a href="https://nodejs.org/en/download"><img alt="Node.js 22.19.0 or newer" src="https://img.shields.io/badge/Node.js-%E2%89%A522.19.0-5FA04E?style=flat&amp;logo=nodedotjs&amp;logoColor=white" /></a>
  <a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/github/license/eValue8bv/pi-codex-pulse?style=flat" /></a>
</p>

<h1 align="center">Pi Codex Pulse</h1>

<p align="center">
  Track Codex usage, limits, and credits in <a href="https://pi.dev">Pi</a>. Redeem reset credits with confirmation.
</p>

## Quick start

```sh
pi install git:github.com/eValue8bv/pi-codex-pulse
```

In Pi, run `/reload` (or restart), then use:

| Command               | What it does                                                                                    |
| --------------------- | ----------------------------------------------------------------------------------------------- |
| `/codex-usage`        | Show current usage and credits. Read-only.                                                      |
| `/codex-redeem-reset` | [Reset eligible limits](#redeem-a-reset-credit). **Consumes a credit after two confirmations.** |

Requires **Pi 1.4.0+**, **Node.js 22.19+**, and a Codex subscription login through Pi (`/login`) or [Codex CLI](https://github.com/openai/codex) (`codex login`). Redemption requires the Pi login.

## Footer

Select an `openai-codex` model to see the footer. It refreshes once per minute and uses your Pi theme.

```text
codex · 70% 5h ↻2h14m (16:30) · 40% 1w ↻3d (Thu 16:30) · 12.5 usage credits · 2 reset credits
```

Read the remaining percentage, time until reset, and local reset time for each limit. Your account determines the available windows and credits. The footer warns when a reset credit expires within eight days.

## Commands

| Command                         | What it does                                                                |
| ------------------------------- | --------------------------------------------------------------------------- |
| `/codex-usage --timeout 30`     | Allow 30 seconds per request or CLI operation.                              |
| `/codex-usage polling off`      | Stop background requests. Run `/codex-usage` to fetch usage.                |
| `/codex-usage polling on`       | Restore background refreshes. This is the default.                          |
| `/codex-usage source auto`      | Use Pi authentication, or CLI if you have no Pi login. This is the default. |
| `/codex-usage source pi`        | Use the Pi OpenAI Codex login.                                              |
| `/codex-usage source codex-cli` | Use the Codex CLI login.                                                    |

The usage timeout accepts 1–120 seconds and defaults to 15 seconds. It applies to each request or CLI operation, so a query with multiple operations can take longer.

## Redeem a reset credit

Use an interactive Pi terminal with a Pi OpenAI Codex subscription login and source mode `auto` or `pi`. To switch from CLI mode, run `/login` and `/codex-usage source pi`. Redemption does not use CLI credentials or change your source preference.

Run `/codex-redeem-reset`. Read the account ID and credit expiry in the prompts, then:

1. Type `y` to continue.
2. Type the displayed four-digit challenge to redeem.

Press Escape or enter a different answer to cancel. The command accepts no arguments or confirmation bypass. It is not an agent tool and cannot run in print, JSON, or RPC mode.

> [!WARNING]
> **An unknown outcome may mean you spent a credit.** A connection failure, timeout, or unexpected server response after submission does not prove failure. The extension does not retry the write. Check `/codex-usage` before another attempt. Each new attempt uses a new request ID.

<details>
<summary>Credit selection and redemption safeguards</summary>

The command selects a usable credit with the earliest known expiry. It selects a credit with unknown expiry if no dated, unexpired credit is available.

Before submission, the command rechecks your account, source, and selected credit. Account changes, session or model changes, and expired or missing credits cancel the attempt. The command does not substitute a different credit after confirmation. Each network request has a 15-second timeout.

After submission, the extension clears old usage snapshots and requests fresh usage, including in manual-only mode. A failed refresh does not undo a successful redemption. The extension blocks overlapping redemption commands in the same session; other sessions and devices can consume credits during your attempt.

</details>

## Reference

<details>
<summary>Usage reports and credits</summary>

Each `/codex-usage` invocation fetches fresh usage. The report includes your plan, authentication source, query time, and available limits. For example:

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

**Usage credits** are your additional usage balance. The footer omits `usage credits: none` and zero reset-credit counts. You can see these values in the detailed report.

**Reset credits** are banked entitlements to reset eligible subscription limits. The report lists known expiration dates. Available limit windows depend on your account; they are not restricted to five hours and one week.

Usage reporting is read-only. The redemption command can consume one banked reset credit after you confirm the account and credit.

</details>

<details>
<summary>Footer refreshes and stale data</summary>

The footer uses model-specific limits when available. CLI results include a `(CLI)` label. Switch to another provider to clear the footer; you can run `/codex-usage` with any provider selected.

Background requests run in the interactive terminal with a Codex model selected and polling enabled. JSON, print, and RPC sessions do not start background polling. In manual-only mode, the footer includes the capture time of your requested snapshot.

Usage snapshots stay in memory. After a failed refresh, the extension retains the last successful snapshot if Pi can identify the same account. The footer marks those values **stale** and shows their age. Switching models or authentication sources clears the snapshot. The extension discards CLI results and results without a stable account identity after a failure.

</details>

<details>
<summary>Preferences and settings file</summary>

Preferences apply to your user account, not the current project. The source and polling commands save them in `~/.pi/agent/codex-pulse.json`, or in `codex-pulse.json` under your custom `PI_CODING_AGENT_DIR`.

Defaults:

```json
{
  "source": "auto",
  "polling": true
}
```

Run `/reload` after editing this file by hand. Invalid settings stop background queries until you fix the file and reload.

</details>

<details>
<summary>Authentication and account selection</summary>

In **auto** mode, Pi Codex Pulse uses your Pi OpenAI Codex login. Without a Pi login, the extension starts a temporary Codex CLI app-server process.

**A failed Pi request does not switch to CLI.** Pi and Codex CLI can use different accounts. The CLI account API does not expose enough identity information to prove that they match. Choose `/codex-usage source codex-cli` to use that login instead. An API-key-only CLI login cannot read subscription limits.

In **pi** mode, the extension uses Pi authentication without CLI fallback. In **codex-cli** mode, it uses the CLI login without Pi authentication.

The extension redacts common credential patterns from errors. Review diagnostic output before sharing it.

</details>

This is an unofficial integration with ChatGPT and Codex. Upstream changes can affect compatibility.

## Troubleshooting

| Problem                | Try this                                                                                                                                                    |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No usage available     | Run `/login` in Pi and choose the OpenAI Codex subscription login. For CLI, run `codex login` with a ChatGPT account, then `/codex-usage source codex-cli`. |
| Codex CLI cannot start | Check that `codex --version` works in the terminal where you launch Pi.                                                                                     |
| Requests time out      | Run `/codex-usage --timeout 30`.                                                                                                                            |
| No footer              | Select an `openai-codex` model. You can run `/codex-usage` with another provider selected.                                                                  |

## Uninstall

```sh
pi remove git:github.com/eValue8bv/pi-codex-pulse
```

## License

[MIT](LICENSE). Copyright (c) 2026 eValue8 B.V.
