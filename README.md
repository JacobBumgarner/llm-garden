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
| `subagent` | A tool for subagent deployment by the main agent. Subagents can run in the foreground or background and can be paused, resumed, and steered. A `brief` name on `start`, such as `orchestration/critic`, appends a bundled or user brief from `briefs/` to the delegate's system prompt, for standing instructions the task should not repeat. `/subagents` (or `Option+a`) shows an overlay of subagents. |
| `rename` | Renames the session based on conversation context, a supplied sentence, or a supplied hyphenated name. |
| `editor-border` | Paints the session title and a running-subagent badge on the editor top border. |
| `stash` | `ctrl+s` stashes the editor text so you can send a new message, change settings, etc. |
| `focus-mode` | Collapses tool calls in the transcript into one-line summaries. Allows for easier viewing of summarized agent activity. |
| `footer` | My custom footer for pi. |
| `final-marker` | Draws a full-width rule above the assistant message that ends a turn, so the final answer stands out from intermediate narration between tool calls. |
| `aside` | `Option+/` (or `/aside`) shows and hides a side panel over the conversation, holding a second agent with its own context and the main agent's tools. It sees what the main agent has done, can read the repo, run commands, and use MCP tools such as web search, and leaves the main session untouched. `/aside new` starts a fresh side agent and keeps the old session on disk. Its conversation is saved as a pi session under `~/.pi/agent/aside-sessions/` and reopens with the main session. |

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
| `dotfiles/cmux/sidebars/agents.js` | `~/.config/cmux/sidebars/agents.js` |
| `dotfiles/pi/extensions/cmux-needs-input.ts` | `~/.pi/agent/extensions/cmux-needs-input.ts` |
| `dotfiles/lazygit/config.yml` | `~/.config/lazygit/config.yml` |
| `dotfiles/git/delta.gitconfig` | `~/.config/git/delta.gitconfig` |

### New mac

```
brew bundle --file dotfiles/Brewfile   # lazygit, delta, gh, ripgrep, tmux, tuicr, ghostty, cmux
sh dotfiles/install.sh                 # copy configs into place, add the delta include to ~/.gitconfig
```

`install.sh` copies one way, repo to live. It refuses to overwrite a live file
that differs from the repo copy, so merge or move the existing file first. To
keep a live edit, copy it back into `dotfiles/` by hand before committing.

`~/.gitconfig` itself isn't tracked (it holds name and email). The script adds
an `include.path` pointing at `delta.gitconfig` instead.

`pi` installs separately, see the pi section above.

