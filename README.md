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
/plugin install orchestrate@llm-garden
```

After install, the `orchestrate` skill is available in every project on that
machine. Start it with `/orchestrate` or by asking to plan something.

### Update

```
/plugin marketplace update llm-garden
```

Installed plugins pick up the new commit (or run `/plugin update
orchestrate@llm-garden` to force one plugin).

### Marketplace

| Plugin | Contents | Details |
| --- | --- | --- |
| `orchestrate` | `skill` | Central-agent workflow across three gated groups: discovery (Q&A plus viability spikes), plan (draft, multi-model review, finalize), and build (delegate staged implementation and cleanup to subagents). Produces a self-contained, staged plan. |
| `commit-flow` | `skill` | Reviews the working-tree diffs and proposes a group of logical commits with descriptions. Designed to ensure LLM code organization is tracked by a human. |


