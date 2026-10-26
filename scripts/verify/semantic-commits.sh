#!/usr/bin/env bash
# Run the organizer on a clone of a repo and print what it did.
# Usage: semantic-commits.sh <repo> <head> <base> [lint command]
set -u

if [ $# -lt 3 ]; then
	echo "usage: $0 <repo> <head> <base> [lint command]" >&2
	exit 2
fi

root=$(cd "$(dirname "$0")/../.." && pwd)
repo=$(cd "$1" && pwd)
head=$2
base=$3
lint=${4:-}

tmp=$(mktemp -d)
clone="$tmp/clone"
git clone --quiet "$repo" "$clone" || exit 1
cd "$clone" || exit 1
git checkout --quiet -b verify "$head" || exit 1

echo "== before"
git log --oneline "$base"..

task="$clone
$base
$root/plugins/rubato/skills/code-review/scripts/semantic_commits.py"
if [ -n "$lint" ]; then
	task="$task
$lint"
fi

pi -p --append-system-prompt "$root/plugins/subagent/briefs/orchestration/organizer.md" "$task"

gitdir=$(git rev-parse --absolute-git-dir)
echo "== after"
git log --oneline "$base"..

echo "== build.log"
cat "$gitdir/code-review/verify/build.log" 2>/dev/null

echo "== PR body draft"
cat "$gitdir/code-review/verify/pr-body.md" 2>/dev/null

backup=$(git for-each-ref --sort=-creatordate --format='%(refname)' refs/backup/code-review/verify | head -n 1)
if [ -n "$backup" ] && [ "$(git rev-parse "$backup^{tree}")" = "$(git rev-parse 'verify^{tree}')" ]; then
	echo "tree identical: yes"
else
	echo "tree identical: no"
fi
echo "clone: $clone"
