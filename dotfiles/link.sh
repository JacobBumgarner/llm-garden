#!/bin/sh
# (Re)link dotfiles in this repo to their live config locations.
# Refuses to clobber a live file that differs from the repo copy.
set -eu
DIR=$(cd "$(dirname "$0")" && pwd)

link() {
  repo_file=$1
  live_file=$2
  if [ -f "$live_file" ] && ! cmp -s "$repo_file" "$live_file"; then
    echo "refusing: $live_file differs from $repo_file (merge or move it first)" >&2
    exit 1
  fi
  rm -f "$live_file"
  ln -s "$repo_file" "$live_file"
  echo "linked $live_file -> $repo_file"
}

link "$DIR/ghostty/config" "$HOME/.config/ghostty/config"
link "$DIR/cmux/cmux.json" "$HOME/.config/cmux/cmux.json"