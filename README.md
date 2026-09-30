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
| `rubato` | `orchestrate` | A phased workflow where agents design and build while the user reviews at fixed checkpoints, acting as tech lead rather than author. Four phases: discovery (Q&A and recon), whiteboard (iterated design, presented as a pitch and the questions it survived), plan (staged into ordered, verifiable units), and build (implement, review, cleanup, and a final report against what was approved). |
| `rubato` | `commit-flow` | Reviews the working-tree diffs and proposes a group of logical commits with descriptions. Designed to ensure LLM code organization is tracked by a human. |


