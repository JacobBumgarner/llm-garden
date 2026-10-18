#!/bin/sh
# Copy dotfiles from this repo into their live config locations.
# Refuses to overwrite a live file that differs from the repo copy.
set -eu
DIR=$(cd "$(dirname "$0")" && pwd)

install_file() {
  repo_file=$1
  live_file=$2
  if [ -e "$live_file" ] && ! cmp -s "$repo_file" "$live_file"; then
    echo "refusing: $live_file differs from $repo_file (merge or move it first)" >&2
    exit 1
  fi
  mkdir -p "$(dirname "$live_file")"
  rm -f "$live_file"
  cp "$repo_file" "$live_file"
  echo "installed $live_file"
}

install_file "$DIR/ghostty/config" "$HOME/.config/ghostty/config"
install_file "$DIR/cmux/cmux.json" "$HOME/.config/cmux/cmux.json"
install_file "$DIR/cmux/sidebars/agents.js" "$HOME/.config/cmux/sidebars/agents.js"
install_file "$DIR/pi/extensions/cmux-needs-input.ts" "$HOME/.pi/agent/extensions/cmux-needs-input.ts"
install_file "$DIR/lazygit/config.yml" "$HOME/.config/lazygit/config.yml"
install_file "$DIR/git/delta.gitconfig" "$HOME/.config/git/delta.gitconfig"

# Pull the delta settings into git without tracking ~/.gitconfig itself
# (it holds name and email).
if ! git config --global --get-all include.path 2>/dev/null | grep -qx '~/.config/git/delta.gitconfig'; then
  git config --global --add include.path '~/.config/git/delta.gitconfig'
  echo "added include.path to ~/.gitconfig"
fi
