# toolscout

A Claude Code mod for sessions with many MCP servers.

- **Compact catalog.** It replaces the long list of deferred tool names with one line per MCP server: tool count and a few sample names. ToolSearch still finds every tool.
- **Routing.** On every message it asks [TypeSafe](https://typesafe.ai)'s Jev model which tool groups the message needs, and adds a short hint to the prompt.
- **Self-calibrating.** At session start it groups tools by server, has Haiku write a definition and test messages for each group, and tunes the definitions and the threshold against Jev. Only groups whose tool names changed are regenerated, at most once a day (also after a failed attempt). App-internal servers (`ccd_*`) stay in the catalog but are not routed.

Prompts, hints and command output are in Italian.

## Install

At the prompt of a terminal session:

```
/plugin install toolscout --marketplace adapt-to-it/toolscout
```

From a shell:

```bash
claude plugin marketplace add adapt-to-it/toolscout
```

```bash
claude plugin install toolscout@adapt-to-it
```

In the desktop app: click + next to the prompt box, then Plugins, Add marketplace with `adapt-to-it/toolscout`, then Add plugin.

## Settings

| Option | What it does |
| --- | --- |
| `typesafe_api_key` | TypeSafe API key, kept in secure storage. Without it toolscout only compacts the catalog. `TYPESAFE_API_KEY` in the environment works too. |
| `server_labels` | Readable names for connectors that appear as UUIDs: `<server id>=<name>`, separated by semicolons. |

Set them when installing, or later with `/plugin configure toolscout@adapt-to-it`.

## Commands

- `/toolscout`: threshold, holdout accuracy, errors per group, tokens used.
- `/toolscout rigenera`: drops the registry and calibrates from scratch.

## Cost

The first calibration sends tens of thousands of short questions to Jev: with about 40 groups, roughly 13 million Jev tokens. Later sessions only re-check groups whose tool names changed. When a refined definition is tried, only the tests relevant to its group are measured again (about 40 instead of every test). Prompts under 20 characters are not classified, and longer ones are cut to 1,000 characters.

## License

MIT
