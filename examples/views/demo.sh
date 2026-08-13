#!/usr/bin/env bash
#
# demo.sh — set up a SCRATCH bundle you can try the bundle-views UI on.
#
# It creates a throwaway bundle, seeds a small roadmap, applies the View convention + registry docs,
# promotes the View blobs via the BUILT CLI, then prints the exact commands to launch the UI and to
# drive live updates from a second terminal. It does NOT launch the UI itself (that is a foreground
# server) — it prints the command for you to run.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
CLI="$REPO/packages/cli/dist/superbee.mjs"

if [ ! -f "$CLI" ]; then
  echo "The built CLI is missing: $CLI" >&2
  echo "Build it first from the repo root:  npm run build" >&2
  exit 1
fi

SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/superbee-views-demo.XXXXXX")"
BUNDLE="$SCRATCH/bundle"

echo "Seeding scratch bundle: $BUNDLE"

node "$CLI" init --create-only --recipe work-tracking --dir "$BUNDLE" >/dev/null
node "$CLI" recipe add roadmap --dir "$BUNDLE" >/dev/null
node "$CLI" new Roadmap roadmap --title "Demo roadmap" --dir "$BUNDLE" >/dev/null
node "$CLI" new "Roadmap Item" first-party-views --title "Try the first-party Views" \
  --status active --sequence 1 --description "A small self-contained roadmap for this demo." \
  --dir "$BUNDLE" >/dev/null
node "$CLI" new Task open-the-view --title "Open the Roadmap View" --status todo \
  --dir "$BUNDLE" >/dev/null
node "$CLI" link add roadmap roadmap-items/first-party-views --text contains --dir "$BUNDLE" >/dev/null
node "$CLI" link add roadmap-items/first-party-views tasks/open-the-view --text contains --dir "$BUNDLE" >/dev/null

# Install the bundle-native authoring reference with the convention, then the registry docs and
# view blobs. .md keys route through the doc engine; other keys are opaque blobs.
node "$CLI" promote "$HERE/references/view-authoring-v0.md" --doc-key references/view-authoring-v0.md --dir "$BUNDLE" >/dev/null
node "$CLI" promote "$HERE/conventions/view.md"          --doc-key conventions/view.md            --dir "$BUNDLE" >/dev/null
node "$CLI" promote "$HERE/views-registry/pulse.md"      --doc-key views-registry/pulse.md        --dir "$BUNDLE" >/dev/null
node "$CLI" promote "$HERE/views-registry/roadmap.md"    --doc-key views-registry/roadmap.md      --dir "$BUNDLE" >/dev/null
node "$CLI" promote "$HERE/views-registry/about.md"      --doc-key views-registry/about.md        --dir "$BUNDLE" >/dev/null
node "$CLI" promote "$HERE/pulse.html"                   --doc-key views/pulse.html               --dir "$BUNDLE" >/dev/null
node "$CLI" promote "$HERE/roadmap.html"                 --doc-key views/roadmap.html             --dir "$BUNDLE" >/dev/null
node "$CLI" promote "$HERE/about.html"                   --doc-key views/about.html               --dir "$BUNDLE" >/dev/null

# Discover a 'todo' task id to demo a live status change.
TASK_ID="$(node "$CLI" list --type Task --dir "$BUNDLE" --json \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);const t=(j.docs||[]).find(d=>d.status==="todo");process.stdout.write(t?t.id:"")})')"
[ -n "$TASK_ID" ] || TASK_ID="tasks/<some-todo-task>"

echo
echo "Seeded 3 views (pulse, roadmap, about) + the View convention and authoring reference."
echo "──────────────────────────────────────────────────────────────────────────"
echo "1) Launch the UI (foreground; it prints a tokenized http://127.0.0.1:PORT URL to open):"
echo
echo "   node $CLI ui --dir $BUNDLE --open"
echo
echo "   The landing is the LAUNCHER (the ui command's one surface), grouped into 'Dashboards'"
echo "   (access: bundle-read) and 'Documents' (access: none): click 'Pulse — activity feed' or"
echo "   'Roadmap' to open a data view in a sandboxed iframe — Roadmap is the one that exercises"
echo "   the bridge's \`edges\` request, expanding an item to see its contained tasks and rollup"
echo "   bar. 'About this bundle' is a content view: same iframe, zero bridge access."
echo
echo "2) In a SECOND terminal, drive live updates against the SAME scratch bundle:"
echo
echo "   # move a task to done — watch a Roadmap item's rollup bar shift, and the row land fresh"
echo "   # in Pulse's feed (~1s):"
echo "   node $CLI doc update $TASK_ID --status done --dir $BUNDLE"
echo
echo "   # edit a view's HTML and save — watch the iframe HOT-RELOAD with the new bytes:"
echo "   printf '\\n<!-- edited %s -->\\n' \"\$(date)\" >> $BUNDLE/views/pulse.html"
echo
echo "   # add a brand-new doc — watch it appear at the top of the Pulse feed:"
echo "   node $CLI new Task tasks/demo-live --title 'Live demo task' --status todo --dir $BUNDLE"
echo "──────────────────────────────────────────────────────────────────────────"
echo "Scratch bundle (safe to delete): $SCRATCH"
