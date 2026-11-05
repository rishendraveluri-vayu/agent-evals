#!/bin/sh
# The API container's start-up step. It runs as root only long enough to make the three folders
# the API writes usable by the API's own user, node (uid 1000), then runs the server as node.
#
# Those folders (trial files, labels, prompt versions) are mounted from your clone, so they belong
# to your user on the host. Where that user is not uid 1000 (a second account, a cloud VM, a CI
# runner), the API could not write them. For each folder, when node does not own it or cannot
# write it, this gives that one folder, never anything inside it, to node, keeps its group (yours),
# and makes it writable by that group with the setgid bit, so everything the API creates inside
# belongs to your group. With umask 002, what the API writes stays group-writable, so you can
# delete it without sudo. On a host where you are uid 1000, nothing changes.
set -u

APP_UID=$(id -u node)
APP_GID=$(id -g node)

say() { printf 'api start-up: %s\n' "$*"; }

# Started as another user (docker run --user): nothing can be changed, so just run the server.
if [ "$(id -u)" != 0 ]; then
  say "started as uid $(id -u), not root, so the folders are left as they are"
  exec "$@"
fi

# The same paths the API uses: compose sets all three; a relative RUNS_DIR is from the working directory.
groups=""
for dir in "${RUNS_DIR:-runs}" "${LABELS_DIR:-/repo/labels}" "${CONFIGS_DIR:-/repo/configs}/prompts"; do
  if [ ! -d "$dir" ] && ! mkdir -p "$dir"; then
    say "could not create $dir, so the API cannot write there; its health check will say so"
    continue
  fi
  owner=$(stat -c %u "$dir")
  group=$(stat -c %g "$dir")
  case "$(stat -c %A "$dir")" in ?rwx*) owner_can=yes ;; *) owner_can=no ;; esac
  if [ "$owner" != "$APP_UID" ] || [ "$owner_can" = no ]; then
    # A folder made by root (Docker makes a missing mount source that way) gets node's group too.
    if [ "$group" = 0 ]; then target="$APP_UID:$APP_GID"; else target="$APP_UID"; fi
    if chown "$target" "$dir" && chmod u+rwx,g+rwxs "$dir"; then
      say "$dir belonged to uid $owner; it now belongs to uid $APP_UID (the API's user), writable by its group $(stat -c %g "$dir") too. Only the folder changed, nothing inside it."
    else
      say "could not give $dir to uid $APP_UID, so the API cannot write there; its health check will say so"
    fi
  fi
  # The server also joins each folder's group, so it can append to a group-writable file of yours
  # already there (a labels file in your clone). Never root's group.
  g=$(stat -c %g "$dir")
  case ",$groups," in
    *",$g,"*) ;;
    *) if [ "$g" != 0 ]; then groups="${groups:+$groups,}$g"; fi ;;
  esac
done

umask 0002
export HOME=/home/node
if [ -n "$groups" ]; then
  exec setpriv --reuid="$APP_UID" --regid="$APP_GID" --groups="$groups" --no-new-privs -- "$@"
fi
exec setpriv --reuid="$APP_UID" --regid="$APP_GID" --clear-groups --no-new-privs -- "$@"
