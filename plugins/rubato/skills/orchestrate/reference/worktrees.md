# Worktrees

A worktree is for parallel work only: a second plan, or independent stages of
one plan, building at the same time. One plan building alone uses the repo's
own checkout. A worktree costs a second environment, a second set of ignored
files, and `--active` style flags on every command, and `pi` sessions are keyed
to the directory they start in, so a worktree is a separate pi context.

## Setup

Create it inside the repo at `.agents/worktrees/{plan-name}/`, which
`.gitignore` covers, with `git worktree add .agents/worktrees/{plan-name}
{branch}`. Then give it an environment, such as `uv sync` there, and copy in
any ignored local files its Verify needs, such as `scripts/`. One plan to one
branch to one working tree, and parallel plans never share one. A later stage
group's worktree takes the group suffix, `.agents/worktrees/{plan-name}-g2/`.

## Pruning after merge

Run every step from a shell in the repo's main checkout, never from inside the
worktree, because removing the directory under a shell kills that shell.

1. `git worktree list` to see what exists.
2. Copy out of the worktree anything untracked or ignored that should
   survive: local `scripts/`, a `.env`. Git will not carry them over, and
   `git worktree remove` deletes them. Plan files live outside the repo and
   are not affected.
3. In the main checkout, `git status --short`. If it shows uncommitted
   changes, stop and have the user commit or stash them first. `git pull` with
   autostash will reapply them onto the merged tree, and when the merge moved
   files, the reapply conflicts and leaves markers in the working tree.
4. `git fetch -p && git pull --ff-only`.
5. `git worktree remove .agents/worktrees/{plan-name}`, with `--force` when it
   still holds untracked files, then `git worktree prune`.
6. `git branch -d {branch}`. The merge usually deletes the remote branch, and
   `git branch -a | grep {plan-name}` shows whether one remains. If so,
   `git push origin --delete {branch}`.
7. `git worktree list` shows the main checkout alone, and the suite passes
   there.

A rebase in the main checkout fails with "untracked working tree files would be
overwritten" when a replayed commit adds a file that now exists untracked, for
example a file the branch first tracked and later untracked. Move the
directory aside for the rebase and move it back after.
