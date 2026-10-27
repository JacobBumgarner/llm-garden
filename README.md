# llm-garden
A public repo of skills, agent prompts, `pi` extensions, and other preferences I
have for building software with LLMs.

Skills follow the [Agent Skills spec](https://agentskills.io/specification)
and install into both `pi` and Claude Code.

These days I am exclusively using the `pi` harness for development work.

### Contents

- [pi extensions](#pi-extensions)
- [Skills](#skills)
- [Installation](#installation)
  - [pi](#pi)
  - [Claude Code](#claude-code)
- [Configs](#configs)
  - [Dotfiles](#dotfiles)
  - [New Mac setup](#new-mac-setup)

## pi extensions

Extensions I've vibe-coded to adapt `pi` to my workflow preferences.

| Extension | Details |
| --- | --- |
| `ask` | A tool to let the agent ask the user questions in a structured manner. Includes multi-select, code previews, and open input. |
| `subagent` | A tool for subagent deployment by the main agent. Subagents can run in the foreground or background and can be paused, resumed, and steered. A `brief` name on `start`, such as `orchestration/critic`, appends a bundled or user brief from `briefs/` to the delegate's system prompt, for standing instructions the task should not repeat. `/subagents` (or `Option+a`) shows an overlay of subagents. |
| `rename` | Renames the session based on conversation context, a supplied sentence, or a supplied hyphenated name. |
| `editor-border` | Paints the session title and a running-subagent badge on the editor top border. |
| `stash` | `ctrl+s` stashes the editor text so you can send a new message, change settings, etc. |
| `focus-mode` | Collapses tool calls in the transcript into one-line summaries. Allows for easier viewing of summarized agent activity. |
| `footer` | My custom footer for pi. |
| `breath` | A one-cell box-breathing pacer in the footer status area. `/breath` toggles it, `/breath <theme role \| #rrggbb>` colors it. Disable the extension if you don't want it. |
| `final-marker` | Draws a full-width rule above the assistant message that ends a turn, so the final answer stands out from intermediate narration between tool calls. |
| `clean-copy` | Cleans fullscreen mouse selections before they reach the clipboard: strips the transcript gutter and restores the agent's own line breaks by finding the selection in the session's message text, so a sentence pi wrapped across rows copies as one line. |
| `aside` | `Option+/` (or `/aside`) shows and hides a side panel over the conversation, holding a second agent with its own context and the main agent's tools. It sees what the main agent has done, can read the repo, run commands, and use MCP tools such as web search, and leaves the main session untouched. `/aside new`, or `/new` typed in the panel, starts a fresh side agent and keeps the old session on disk. `/resume` in the panel lists this main session's earlier asides and reopens the one picked, with the feed resuming where that aside left off. `/model [filter]` switches the side agent's model. Typing `/` in the panel offers these commands, and `@` completes paths. Its conversation is saved as a pi session under `~/.pi/agent/aside-sessions/` and reopens with the main session. |


## Skills

These two skills are the primary way I develop software with LLMs. 

New work, features, fixes, etc. start with me invoking the `/orchestrate`
command. The orchestration skill guides the user and agents through a dev
lifecycle until the work is complete. I review agent code with `/code-review`,
which is a built-in step of the orchestration review. 

I am still experimenting with creating software with LLMs. I'm finding an
inverse correlation with acceleration of work and my sense of connectedness and
grounding to the underlying codebase. I'm interested in taking advantage of the
acclerative capabilities of LLMs, but am not comfortable with losing touch of
the design, code, and organization. These skills represent my ever-evolving
experimentation with this new technology. There are many other workflows around,
but this one is mine :) 

| Plugin | Skill | Details |
| --- | --- | --- |
| `rubato` | `orchestrate` | A phased development wrkflow where agents design and build while the user reviews at fixed checkpoints. Aims to place the dev into a "tech lead" position rather than author. Four phases: discovery (Q&A and recon), whiteboard (iterated design, presented as a pitch and the questions it survived), plan (staged into ordered, verifiable units), and build (implement, review, cleanup, and a final report against what was approved). |
| `rubato` | `code-review` | Rewrites a branch of agent stage commits into a series of semantic commits a person can review, checks that the final code is unchanged, then takes the user's `tuicr` review and records what to fix. |


## Installation

### pi

```
pi install git:github.com/JacobBumgarner/llm-garden
```

Update with `pi update --extensions`.

### Claude Code

```
/plugin marketplace add JacobBumgarner/llm-garden
/plugin install rubato@llm-garden
```

Update with `/plugin marketplace update llm-garden`.

## Configs

Below are a list of configs and an installation script to ensure these
extensions can be easily migrated to a new computer.

### Dotfiles

| File | Location |
| --- | --- |
| `dotfiles/ghostty/config` | `~/.config/ghostty/config` |
| `dotfiles/cmux/cmux.json` | `~/.config/cmux/cmux.json` |
| `dotfiles/cmux/sidebars/agents.js` | `~/.config/cmux/sidebars/agents.js` |
| `dotfiles/pi/extensions/cmux-needs-input.ts` | `~/.pi/agent/extensions/cmux-needs-input.ts` |
| `dotfiles/lazygit/config.yml` | `~/.config/lazygit/config.yml` |
| `dotfiles/git/delta.gitconfig` | `~/.config/git/delta.gitconfig` |

### New Mac setup

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

