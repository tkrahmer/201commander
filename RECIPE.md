# 201Commander

A file browser for Herdr that opens on the active space's main folder. Edit files in place, jump to Finder, and mirror the folder onto an SSH server with the same structure: compare files, view a diff, upload or download with one click. The UI is in English and German.

![201Commander](preview.png)

**What you see:**
- It works as a pane (`pane.split {mod: "201commander"}`, ⌘⇧E with the bundled `keys.json`), as a side panel block, or as a window (`mod.open 201commander`; `mod.json` sets `overlay: {kind: "window", key: "201commander", width: 0.62, height: 0.82}`).
- Header (40px, `chrome` background): the title "201Commander", the root path (shortened with `~`) and icon buttons. From left to right: parent folder, pick a folder, main folder / pin (crosshair in `accent` while on the space's main folder, pin in `blocked` while pinned), reload, open in Finder, SSH (green when connected, red on error), an EN/DE language toggle, and × (only in a window).
- SSH bar, toggled by the SSH button: inputs for the host (`user@host[:port]`) and the remote path, a Connect button, a status dot, the counters `≠ n` (differs), `↑ n` (local only) and `↓ n` (server only), re-compare, and "Upload all".
- Tree (28px rows): chevron, folder/file icon, name, git mark (A/M/D/U) and compare badge (`≠` in `blocked`, `↑` in `ansi2`, `↓` in `ansi4`). Server-only entries are dimmed. The selected row shows its actions: Finder, terminal here, diff, get the server version, upload.
- At 760px or wider, the tree sits on the left (240–360px) with the editor or diff on the right, and long lines scroll. Narrower, one view shows at a time with a back arrow, and the editor soft-wraps.
- Editor: Herdr's `Editor` with syntax colors from the theme and a dirty dot. Toolbar: save, Finder, open with the default app, copy path, diff, upload.
- Diff: a unified diff, local (−) against server (+), in virtualized 20px rows, with upload and "take the server version".
- Footer: a confirm bar before any overwrite, a progress line with a spinner, or the last message.

**How it behaves:**
- Root: the git top level of the first terminal in the active space, else that terminal's folder, else `space.folder`. This is the folder Herdr names the space after. It changes with the space.
- Moving the root by hand (↑, double-click a folder, pick a folder) lasts until the space changes. The pin button goes back to the main folder.
- ⌘S saves through `writeTextFile` with the original text as `expected`. If the file changed on disk, a conflict bar offers Reload or Overwrite.
- SSH mappings live in shared state under `201commander.ssh` as `{localRoot: {host, remote}}`. Subfolders inherit the mapping, and recent hosts are kept in `201commander.hosts`. Opening a mapped folder reconnects automatically.
- Compare: one md5 listing per open folder, both local and remote (`md5sum`, else `md5 -q`). It runs on connect, when a folder is expanded, after a save, and after a transfer.
- Overwrites (an upload over `≠`, a download over a local file, bulk upload) ask first in the footer.
- Language: German when macOS's first language (`defaults read -g AppleLanguages`, else `$LANG`) is German, otherwise English. The EN/DE toggle stores an override in shared `201commander.lang`, and the mod commands `201commander.lang-de` / `lang-en` set it too. Every string goes through `L(de, en)`.

**Built from:** one mod, `201commander`: `main.js`, `mod.json` (`focusable`, window overlay) and Lucide-style `icons/*.svg`.
- `herdr` API: `exec` (running `sh`, `tar`, `diff`, `open`, `pbcopy`, `git` and `defaults`), `hc` (everything that talks SSH), `readTextFile`, `writeTextFile`, `watchFolder`, `pickFolder`, `shared`/`setShared`, `nextCommand` (`201commander.save`, `focus`) and `run("terminal.open")`.
- Everything that talks SSH runs through `hc(["exec", "--timeout", s, "--", ...])` in herdr-core, falling back to `exec`. On macOS the app itself can lack Local Network access (`host.local` fails with "No route to host"), and herdr-core has it.
- SSH runs with `BatchMode=yes` and a ControlMaster socket at `~/.ssh/herdr-201commander-%C` with `ControlPersist=300`.
- Uploads: a file goes as `ssh host 'mkdir -p dir && cat > file' < local`. A folder goes as `tar | ssh tar -x`, without `.git` and `.DS_Store`. Downloads use the reverse.
- The optional `keys.json` binds ⌘⇧E to `pane.split` with the mod, and ⌘S inside the mod to `201commander.save`.

**Watch out:**
- SSH needs key or agent authentication. There is no password prompt (BatchMode).
- Remote paths are single-quoted for the remote shell, except a leading `~/`, which becomes `"$HOME"/'…'` so that `~/site` works.
- The class name can't start with a digit, so the module exports `class Commander` while the mod is named `201commander`.
- `EditorState.soft_wrap` is fixed when the state is created. Crossing 760px rebuilds the editor, keeping the text and the selection.
- A view that holds the editor needs `h_full()` inside the body's `h_flex`, or it lays out at zero height.
- Text files only, up to 1 MiB (the `readTextFile` limit). Binary files open in the default app.
- Finder, Open and Copy path are macOS only (`open`, `pbcopy`).
- Spaces on another Herdr machine are read-only, and SSH is turned off there.
- Compare covers only the folders that are open, up to 1,000 entries each.

**Done when:**
- `herdr-app check mods/201commander` passes.
- The pane opens on the space's repository root.
- Clicking a file shows it with the full height, and typing then ⌘S writes it.
- Finder reveals the file.
- Connecting to a host with a mirrored folder shows the `≠/↑/↓` badges.
- The diff shows the change, and after an upload the file compares as equal.
