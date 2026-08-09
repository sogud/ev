#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$ROOT_DIR"

VERSION_INPUT=patch
DRY_RUN=0
NO_PUSH=0
ASSUME_YES=0

usage() {
  cat <<'EOF'
Usage: bun run release [patch|minor|major|X.Y.Z] [options]

Options:
  --dry-run  Print the planned release without changing files or Git state
  --no-push  Create the release commit and tag locally without pushing
  --yes      Skip the final confirmation prompt
  --help     Show this help
EOF
}

for argument in "$@"; do
  case "$argument" in
    patch|minor|major) VERSION_INPUT=$argument ;;
    --dry-run) DRY_RUN=1 ;;
    --no-push) NO_PUSH=1 ;;
    --yes) ASSUME_YES=1 ;;
    --help|-h)
      usage
      exit 0
      ;;
    [0-9]*.[0-9]*.[0-9]*) VERSION_INPUT=$argument ;;
    *)
      echo "Unknown argument: $argument" >&2
      usage >&2
      exit 2
      ;;
  esac
done

CURRENT_VERSION=$(bun -e "console.log(JSON.parse(await Bun.file('package.json').text()).version)")
if [[ ! $CURRENT_VERSION =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Automatic bumps require a stable X.Y.Z root version; found $CURRENT_VERSION" >&2
  exit 1
fi

IFS=. read -r MAJOR MINOR PATCH <<<"$CURRENT_VERSION"
case "$VERSION_INPUT" in
  patch) VERSION="$MAJOR.$MINOR.$((PATCH + 1))" ;;
  minor) VERSION="$MAJOR.$((MINOR + 1)).0" ;;
  major) VERSION="$((MAJOR + 1)).0.0" ;;
  *) VERSION=$VERSION_INPUT ;;
esac

if [[ ! $VERSION =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]]; then
  echo "Invalid release version: $VERSION" >&2
  exit 1
fi

TAG="v$VERSION"
echo "Release plan: $CURRENT_VERSION -> $VERSION ($TAG)"

if ((DRY_RUN)); then
  if [[ -n $(git status --porcelain) ]]; then
    echo "Warning: the working tree is currently dirty; a real release would stop."
  fi
  echo "Would synchronize all workspace package versions, run bun run verify, create an annotated tag,"
  if ((NO_PUSH)); then
    echo "and keep the release commit and tag local."
  else
    echo "and atomically push master plus $TAG to origin."
  fi
  exit 0
fi

if [[ -n $(git status --porcelain) ]]; then
  echo "Release aborted: the working tree must be clean." >&2
  exit 1
fi

BRANCH=$(git branch --show-current)
if [[ $BRANCH != master ]]; then
  echo "Release aborted: expected branch master, found ${BRANCH:-detached HEAD}." >&2
  exit 1
fi

git fetch origin master --tags
read -r LOCAL_ONLY REMOTE_ONLY < <(git rev-list --left-right --count HEAD...origin/master)
if ((LOCAL_ONLY != 0 || REMOTE_ONLY != 0)); then
  echo "Release aborted: master must match origin/master (local=$LOCAL_ONLY, remote=$REMOTE_ONLY)." >&2
  exit 1
fi
if git rev-parse --verify --quiet "refs/tags/$TAG" >/dev/null; then
  echo "Release aborted: tag $TAG already exists." >&2
  exit 1
fi

RESTORE_ON_EXIT=1
restore_versions() {
  if ((RESTORE_ON_EXIT)); then
    git restore --staged package.json apps/desktop/package.json apps/browser-extension/package.json apps/cli/package.json packages/browser-host/package.json packages/contracts/package.json packages/design-tokens/package.json bun.lock 2>/dev/null || true
    git restore package.json apps/desktop/package.json apps/browser-extension/package.json apps/cli/package.json packages/browser-host/package.json packages/contracts/package.json packages/design-tokens/package.json bun.lock 2>/dev/null || true
  fi
}
trap restore_versions EXIT INT TERM

bun scripts/set-release-version.ts "$VERSION"
bun install
bun run release:check --tag="$TAG"
bun run verify
git diff --check

printf '\nRelease changes:\n'
git diff -- package.json apps/desktop/package.json apps/browser-extension/package.json bun.lock

if ((ASSUME_YES == 0)); then
  read -r -p "Create release $TAG? [y/N] " CONFIRM
  if [[ ! $CONFIRM =~ ^[Yy]$ ]]; then
    echo "Release cancelled."
    exit 1
  fi
fi

git add package.json apps/desktop/package.json apps/browser-extension/package.json apps/cli/package.json packages/browser-host/package.json packages/contracts/package.json packages/design-tokens/package.json bun.lock
if git diff --cached --quiet; then
  echo "Package versions already match $VERSION; creating a tag without a release commit."
else
  git commit -m "chore(release): $TAG"
fi
git tag -a "$TAG" -m "EV $VERSION"
RESTORE_ON_EXIT=0

if ((NO_PUSH)); then
  echo "Created local release $TAG. Push it with:"
  echo "  git push --atomic origin master refs/tags/$TAG"
else
  git push --atomic origin master "refs/tags/$TAG"
  echo "Released $TAG. GitHub Actions will build and publish the artifacts."
fi
