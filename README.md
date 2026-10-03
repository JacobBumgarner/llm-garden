# llm-garden
A public repo of skills, agent files, instructions, and other preferences I have
for building software with LLMs.

The skills follow the [Agent Skills spec](https://agentskills.io/specification)
and install into both Claude Code and pi.

## Skills

| Plugin | Skill | Details |
| --- | --- | --- |
| `rubato` | `orchestrate` | A phased workflow where agents design and build while the user reviews at fixed checkpoints, acting as tech lead rather than author. Four phases: discovery (Q&A and recon), whiteboard (iterated design, presented as a pitch and the questions it survived), plan (staged into ordered, verifiable units), and build (implement, review, cleanup, and a final report against what was approved). |
| `rubato` | `commit-flow` | Reviews the working-tree diffs and proposes a group of logical commits with descriptions. Designed to ensure LLM code organization is tracked by a human. |

## Install

### Claude Code

```
/plugin marketplace add JacobBumgarner/llm-garden
/plugin install rubato@llm-garden
```

Update with `/plugin marketplace update llm-garden`.

### pi

```
pi install git:github.com/JacobBumgarner/llm-garden
```

Update with `pi update --extensions`.

