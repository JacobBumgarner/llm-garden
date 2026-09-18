# llm-garden
A public repo of skills, agent files, instructions, and other preferences I have
for building software with LLMs.

This repo doubles as a [Claude Code plugin
marketplace](https://code.claude.com/docs/en/plugin-marketplaces) (`llm-garden`) and a collection of agent prompts.


## Claude Code marketplace

### Install

```
/plugin marketplace add JacobBumgarner/llm-garden
/plugin install rubato@llm-garden
```

### Update

```
/plugin marketplace update llm-garden
```

### Marketplace

| Plugin | Skill | Details |
| --- | --- | --- |
| `rubato` | `orchestrate` | A three-stage development workflow that a centralized agent drives. The three stages are: discovery (Q&A plus viability spikes), plan (draft, multi-model review, finalize; produces a planning `.md` file), and build (delegate staged implementation and review/cleanup to subagents). |
| `rubato` | `commit-flow` | Reviews the working-tree diffs and proposes a group of logical commits with descriptions. Designed to ensure LLM code organization is tracked by a human. |


