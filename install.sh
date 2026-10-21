#!/usr/bin/env bash
# Install the Software Factory plugin for Claude Code, with the plugins it
# depends on, and set it up in a Git repository.
#
#   bash <(curl -fsSL https://raw.githubusercontent.com/Petrit-Halabaku/software-factory/main/install.sh)
#   ./install.sh [--repo PATH] [--headless | --install-only]
#
# Installs at user scope into the Claude Code profile in use (CLAUDE_CONFIG_DIR,
# or ~/.claude). Safe to run again: whatever is already there is kept.
# FACTORY_PLUGIN_DIR=<path to plugins/factory> uses a local copy of the plugin
# instead of installing it (for development).

set -euo pipefail

MARKETPLACES=(
  "claude-plugins-official anthropics/claude-plugins-official"
  "karpathy-skills forrestchang/andrej-karpathy-skills"
  "understand-anything Lum1104/Understand-Anything"
  "software-factory Petrit-Halabaku/software-factory"
)
FACTORY="factory@software-factory"
DEPENDENCIES=(
  "superpowers@claude-plugins-official"
  "feature-dev@claude-plugins-official"
  "frontend-design@claude-plugins-official"
  "claude-code-setup@claude-plugins-official"
  "andrej-karpathy-skills@karpathy-skills"
  "understand-anything@understand-anything"
)

usage() {
  cat <<'EOF'
Usage: install.sh [--repo PATH] [--headless | --install-only]

  --repo PATH      repository to set the factory up in (default: the current directory)
  --headless       write the house rules without an interactive Claude Code session
  --install-only   install the plugins and stop; run /factory init yourself later
EOF
}

if [ -t 1 ]; then
  say() { printf '\033[1m==>\033[0m %s\n' "$*"; }
else
  say() { printf '==> %s\n' "$*"; }
fi
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

repo=""
mode="interactive"
while [ $# -gt 0 ]; do
  case "$1" in
    --repo) repo="${2:?--repo needs a path}"; shift 2 ;;
    --headless) mode="headless"; shift ;;
    --install-only) mode="none"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; die "unknown option: $1" ;;
  esac
done

# --- 1. Tools ---------------------------------------------------------------

command -v claude >/dev/null || die "Claude Code (claude) is not on PATH"
command -v git >/dev/null || die "git is not on PATH"
command -v node >/dev/null || die "Node.js 20 or later is required"
[ "$(node -p 'process.versions.node.split(".")[0]')" -ge 20 ] || die "Node.js 20 or later is required (found $(node -v))"

repo_root=""
if [ "$mode" != "none" ]; then
  target="${repo:-$PWD}"
  repo_root=$(git -C "$target" rev-parse --show-toplevel 2>/dev/null) ||
    die "$target is not inside a Git repository (use --repo PATH, or --install-only)"
fi

dev_dir="${FACTORY_PLUGIN_DIR:-}"
if [ -n "$dev_dir" ]; then
  dev_dir=$(cd "$dev_dir" && pwd)
  [ -f "$dev_dir/bin/fac.mjs" ] || die "FACTORY_PLUGIN_DIR=$dev_dir has no bin/fac.mjs"
  say "development mode: using the plugin in $dev_dir"
fi

# Prints "<state> <installPath>" for one plugin id, where state is missing,
# disabled or ok. Only user-scope installs and installs scoped to this
# repository count: the list also reports other projects' installs.
plugin_state() {
  claude plugin list --json | REPO_ROOT="$repo_root" node -e '
    let s = "";
    process.stdin.on("data", (d) => (s += d)).on("end", () => {
      const id = process.argv[1];
      const here = JSON.parse(s).filter((p) => p.id === id && (!p.projectPath || p.projectPath === process.env.REPO_ROOT));
      const on = here.find((p) => p.enabled);
      console.log(on ? `ok ${on.installPath}` : here.length ? "disabled -" : "missing -");
    });' "$1"
}

ensure_plugin() {
  local id="$1" state path
  read -r state path <<<"$(plugin_state "$id")"
  case "$state" in
    missing) say "installing $id"; claude plugin install "$id" ;;
    disabled) say "enabling $id"; claude plugin enable "$id" ;;
    ok) say "$id is installed" ;;
  esac
}

# --- 2. Marketplaces --------------------------------------------------------

added=$(claude plugin marketplace list --json | node -e '
  let s = "";
  process.stdin.on("data", (d) => (s += d)).on("end", () => { for (const m of JSON.parse(s)) console.log(m.name); });')
for entry in "${MARKETPLACES[@]}"; do
  name="${entry%% *}"
  source="${entry#* }"
  if [ -n "$dev_dir" ] && [ "$name" = "software-factory" ]; then continue; fi
  if printf '%s\n' "$added" | grep -qx "$name"; then
    say "marketplace $name is already added"
  else
    say "adding marketplace $name ($source)"
    claude plugin marketplace add "$source"
  fi
done

# --- 3. Plugins -------------------------------------------------------------

if [ -z "$dev_dir" ]; then
  read -r state _ <<<"$(plugin_state "$FACTORY")"
  if [ "$state" = "ok" ]; then
    say "updating $FACTORY"
    claude plugin marketplace update software-factory >/dev/null || say "could not refresh the software-factory marketplace; keeping the installed version"
    claude plugin update "$FACTORY" || say "could not update $FACTORY; keeping the installed version"
  else
    ensure_plugin "$FACTORY"
  fi
fi
for id in "${DEPENDENCIES[@]}"; do ensure_plugin "$id"; done

if [ -n "$dev_dir" ]; then
  plugin_root="$dev_dir"
else
  read -r state plugin_root <<<"$(plugin_state "$FACTORY")"
  [ "$state" = "ok" ] || die "$FACTORY did not install; see the output above"
fi
fac() { node "$plugin_root/bin/fac.mjs" "$@"; }

# The factory's own check: every plugin it needs, and every skill its agents
# preload, in the installed versions.
check=$(cd "${repo_root:-$PWD}" && fac plugins) || true
commands=$(printf '%s' "$check" | node -e '
  let s = "";
  process.stdin.on("data", (d) => (s += d)).on("end", () => {
    const r = JSON.parse(s);
    for (const p of r.problems ?? []) console.error(`problem: ${p}`);
    for (const a of r.actions ?? []) console.log(a.command);
    if ((r.problems ?? []).length) process.exitCode = 1;
  });') || die "the plugin check reported problems no install can fix"
while IFS= read -r cmd; do
  [ -n "$cmd" ] || continue
  say "plugin check: $cmd"
  # The check prints only "claude plugin install|enable|update ..." commands.
  read -r -a words <<<"$cmd"
  "${words[@]}"
done <<<"$commands"
say "all plugins the factory needs are installed"

if [ "$mode" = "none" ]; then
  say "done. In a repository, run /factory init in Claude Code (after /reload-plugins in an open session)."
  exit 0
fi

# --- 4. Set the repository up -----------------------------------------------

cd "$repo_root"
say "setting the factory up in $repo_root"
init=$(fac init) || { printf '%s\n' "$init"; die "fac init failed"; }
fill=$(printf '%s' "$init" | node -e '
  let s = "";
  process.stdin.on("data", (d) => (s += d)).on("end", () => {
    const r = JSON.parse(s);
    if (r.addedPatterns.length) console.error(`  .git/info/exclude: added ${r.addedPatterns.join(", ")}`);
    for (const f of r.created) console.error(`  created ${f}`);
    console.log(r.fill.length);
  });')

if [ "$fill" = "0" ]; then
  say "factory/house-rules.md is already written"
else
  # A project skill also called "factory" (an older local install) shadows
  # the short name; the plugin's full name always works.
  slash="/factory init"
  [ -f "$repo_root/.claude/skills/factory/SKILL.md" ] && slash="/factory:factory init"
  plugin_flag=()
  [ -n "$dev_dir" ] && plugin_flag=(--plugin-dir "$dev_dir")

  if [ "$mode" = "interactive" ] && [ -t 0 ] && [ -t 1 ]; then
    say "starting Claude Code to write factory/house-rules.md (it may ask you about protected paths)"
    exec claude ${plugin_flag[@]+"${plugin_flag[@]}"} "$slash"
  fi
  [ "$mode" = "interactive" ] && say "no terminal to talk to; writing the house rules headless"
  say "Claude Code is writing factory/house-rules.md from the repository"
  claude -p "$slash" ${plugin_flag[@]+"${plugin_flag[@]}"} --allowedTools "Bash Read Edit Write Glob Grep"
fi

if pf=$(fac preflight); then
  printf '%s' "$pf" | node -e '
    let s = "";
    process.stdin.on("data", (d) => (s += d)).on("end", () => {
      for (const w of JSON.parse(s).warnings ?? []) console.log(`  warning: ${w}`);
    });'
  say "done. factory/house-rules.md is ready; review it (and anything marked UNCONFIRMED), then run /factory <feature request> in Claude Code."
else
  printf '%s\n' "$pf"
  die "the factory is installed, but the preflight above still fails"
fi
