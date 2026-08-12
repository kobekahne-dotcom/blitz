#!/usr/bin/env bash
# Deploy BLITZ to GitHub Pages, and PROVE it landed.
#
#   bash scripts/deploy.sh
#
# The site is served from the gh-pages branch, which holds the built
# output only. This builds, mirrors dist/ into a gh-pages worktree,
# pushes, then waits for the live page to actually serve the new bundle
# and hash-compares it against the local file. A push is not a deploy;
# the hash match is the deploy.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WT="${TMPDIR:-/tmp}/blitzpages"
URL="https://kobekahne-dotcom.github.io/blitz"

cd "$ROOT"
echo "==> build"
npm run build

echo "==> gh-pages worktree"
git fetch origin gh-pages --quiet
if [ -d "$WT/.git" ] || [ -f "$WT/.git" ]; then
  git -C "$WT" fetch origin gh-pages --quiet
  git -C "$WT" reset --hard origin/gh-pages --quiet
else
  rm -rf "$WT"
  git worktree add "$WT" gh-pages
fi

echo "==> mirror dist/ (never copy a .git into the worktree)"
find "$WT" -maxdepth 1 -mindepth 1 ! -name '.git' -exec rm -rf {} +
tar -C "$ROOT/dist" --exclude=.git -cf - . | tar -C "$WT" -xf -

BUNDLE="$(cd "$WT" && ls assets/index-*.js | head -1)"
echo "==> bundle: $BUNDLE"

cd "$WT"
if git diff --quiet && git diff --cached --quiet && [ -z "$(git status --porcelain)" ]; then
  echo "==> nothing changed; already deployed"
  exit 0
fi
git add -A
git commit -q -m "deploy: ${1:-update}"
git push -q origin gh-pages
echo "==> pushed"

echo "==> waiting for the live page to serve it"
for i in $(seq 1 25); do
  LIVE="$(curl -s "$URL/?cb=$RANDOM" | grep -o 'assets/index-[A-Za-z0-9_-]*\.js' || true)"
  if [ "$LIVE" = "$BUNDLE" ]; then
    A="$(curl -s "$URL/$BUNDLE" | tr -d '\r' | sha256sum | cut -d' ' -f1)"
    B="$(tr -d '\r' < "$ROOT/dist/$BUNDLE" | sha256sum | cut -d' ' -f1)"
    if [ "$A" = "$B" ]; then echo "==> LIVE and byte-identical ($BUNDLE)"; exit 0; fi
    echo "!! live bundle differs from the local build"; exit 1
  fi
  printf '    %s/25 still serving %s\n' "$i" "${LIVE:-nothing}"
  sleep 12
done
echo "!! timed out waiting for GitHub Pages"; exit 1
