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

## pi extensions

Extensions I've created to enhance `pi` to my workflow preferences.

| Extension | Details |
| --- | --- |
| `ask` | A tool to let the agent ask the user questions in a structured manner. Includes multi-select, code previews, and open input. |
| `subagent` | A tool for subagent deployment by the main agent. Subagents can run in the foreground or background and can be paused, resumed, and steered. `/subagents` (or `Option+a`) shows an overlay of subagents. |
| `rename` | Renames the session based on conversation context, a supplied sentence, or a supplied hyphenated name. |
| `session-title` | Adds the session title and a running-subagent badge to the editor top border. |
| `stash` | `ctrl+s` stashes the editor text so you can send a new message, change settings, etc. |
| `focus-mode` | Collapses tool calls in the transcript into one-line summaries. Allows for easier viewing of summarized agent activity. |
| `footer` | My custom footer for pi. |
| `final-marker` | Draws a full-width rule above the assistant message that ends a turn, so the final answer stands out from intermediate narration between tool calls. |

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

## Dotfiles

| File | Lives at |
| --- | --- |
| `dotfiles/ghostty/config` | `~/.config/ghostty/config` |
| `dotfiles/cmux/cmux.json` | `~/.config/cmux/cmux.json` |

Symlink them into place with `dotfiles/link.sh`.

