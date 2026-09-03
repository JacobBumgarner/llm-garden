# llm-garden
A public repo of skills, agent files, instructions, and other preferences I have
for building software with LLMs.

## Claude Code skills

This repo doubles as a [Claude Code plugin
marketplace](https://code.claude.com/docs/en/plugin-marketplaces) (`llm-garden`).
Install once per machine, then pull updates with a single command.

### Install

```
/plugin marketplace add JacobBumgarner/llm-garden
/plugin install plan-session@llm-garden
```

After install, the `plan-session` skill is available in every project on that
machine. Start it with `/plan-session` or by asking to plan something.

### Update

```
/plugin marketplace update llm-garden
```

Installed plugins pick up the new commit (or run `/plugin update
plan-session@llm-garden` to force one plugin).

### Marketplace

| Plugin | Contents | Details |
| --- | --- | --- |
| `plan-session` | `skill` | Runs a structured planning session to create a self-contained implementation plan. Requires multiple iterations with new agents to converge on a plan. Creates a staged build plan for downstream agents. |


