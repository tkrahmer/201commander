// 201Commander: a file browser + editor for the active space's main folder (or a pinned one),
// with "Show in Finder" and an SSH mirror: map the local folder onto a remote folder
// with the same structure, compare files (md5), diff, upload and download.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState, InputState, Input, Scrollbar, v_virtual_list } from "gpui-base";
import { spaces, panes, focused, exec, hc, readTextFile, writeTextFile, watchFolder, theme, settings, pickFolder, shared, setShared, notify, props, closeOverlay, nextCommand, run, home, checking } from "herdr";

const M = "mods/201commander/icons/";
const LANG = { ts: "js", tsx: "js", mts: "js", cts: "js", jsx: "js", mjs: "js", cjs: "js", toml: "yaml", yml: "yaml", jsonc: "json", svelte: "html", vue: "html", twig: "html", htm: "html", php: "php", sh: "bash", zsh: "bash" };
const PER_FOLDER = 500, TOTAL = 5000;
const SSH_KEY = "201commander.ssh", HOSTS_KEY = "201commander.hosts";
const LANG_KEY = "201commander.lang";
const RETRO_KEY = "201commander.retro";

// Retro look: the CGA blue of the classic DOS file commanders, in the IBM VGA pixel font
// that Herdr ships with its Herdr 98 layout.
const DOS_FONT = "PxPlus IBM VGA 8x16";
const DOS = {
  background: "#0000aa", surface: "#0000aa", canvas: "#0000aa", popover: "#0000aa", chrome: "#00aaaa",
  raised: "#000080", hover: "#0000d8", selected: "#00aaaa", selection: "#00aaaa", border: "#55ffff", input: "#55ffff",
  foreground: "#55ffff", muted: "#55ffff", dim: "#00aaaa", accent: "#ffffff", accent_foreground: "#000000",
  solid: "#00aaaa", solid_foreground: "#000000", working: "#ffff55", blocked: "#ffff55", done: "#55ff55",
  idle: "#55ffff", unknown: "#aaaaaa", ansi0: "#000000", ansi1: "#ff5555", ansi2: "#55ff55", ansi3: "#ffff55",
  ansi4: "#ff55ff", ansi5: "#ffffff", ansi6: "#55ffff", ansi7: "#aaaaaa", white: "#ffffff", yellow: "#ffff55", black: "#000000",
};
// On the cyan selection bar everything is drawn black.
const DOS_BAR = { ...DOS, muted: "#000000", dim: "#000000", foreground: "#000000", ansi2: "#000000", ansi4: "#000000", blocked: "#000000", accent: "#000000", hover: "#55ffff" };

// UI language: German when macOS (or $LANG) is German, else English; the header's DE/EN
// button overrides it for every copy (shared LANG_KEY).
let UI_DE = false;
const L = (de, en) => (UI_DE ? de : en);
async function detectGerman() {
  const r = await exec("defaults", ["read", "-g", "AppleLanguages"]).catch(() => null);
  let first = r?.code === 0 ? r.stdout.replace(/[()\s"]/g, "").split(",")[0] : "";
  if (!first) {
    const e = await exec("sh", ["-c", 'printf %s "${LC_ALL:-${LC_MESSAGES:-$LANG}}"']).catch(() => null);
    first = e?.stdout ?? "";
  }
  return first.toLowerCase().startsWith("de");
}

// ---------- helpers ----------
const q = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";
// Quotes a remote path, keeping a leading ~ for the remote shell to expand.
const rq = (p) => (p === "~" ? '"$HOME"' : p.startsWith("~/") ? '"$HOME"/' + q(p.slice(2)) : q(p));
const join = (a, b) => (b ? `${a.replace(/\/$/, "")}/${b}` : a);
const dirname = (p) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
const basename = (p) => p.split("/").pop();
const tilde = (p) => (p && p.startsWith(home()) ? "~" + p.slice(home().length) : p ?? "");
const untab = (text) => text.replace(/[^\t]*\t/g, (s) => s.slice(0, -1).padEnd((s.length - 1) - (s.length - 1) % 4 + 4));
const validHost = (h) => /^[A-Za-z0-9_.@\-\[\]]+(:\d+)?$/.test(h) && !h.startsWith("-");

function sshArgs(spec) {
  let host = spec.trim(), port = null;
  const m = /^(.*?):(\d+)$/.exec(host);
  if (m) { host = m[1]; port = m[2]; }
  return ["-o", "BatchMode=yes", "-o", "ConnectTimeout=8", "-o", "ServerAliveInterval=15",
    "-o", "ControlMaster=auto", "-o", `ControlPath=${home()}/.ssh/herdr-201commander-%C`, "-o", "ControlPersist=300",
    ...(port ? ["-p", port] : []), host];
}
// macOS keeps the app itself out of the local network unless allowed (host.local → "No route to
// host"); herdr-core has that access, so everything that talks SSH runs through `hc exec`.
async function net(cmd, args, timeout = 60000) {
  try {
    const r = await hc(["exec", "--timeout", String(Math.min(600, Math.ceil(timeout / 1000))), "--", cmd, ...args]);
    if (r.code === 0 || !/^error|unrecognized|unexpected argument/i.test(r.stderr ?? "")) return r;
  } catch {}
  return exec(cmd, args, { timeout });
}
const ssh = (spec, command, timeout = 60000) => net("ssh", [...sshArgs(spec), command], timeout);

function location() {
  const space = spaces().find((s) => s.active), f = focused();
  const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on };
}

// Lists a folder: kind\0name\0 pairs (dirs and files, .git skipped).
const LIST = 'n=0; for p in "$1"/* "$1"/.[!.]* "$1"/..?*; do [ -e "$p" ] || [ -L "$p" ] || continue; name=${p##*/}; [ "$name" = .git ] && continue; if [ -d "$p" ]; then kind=d; else kind=f; fi; printf "%s\\0%s\\0" "$kind" "$name"; n=$((n+1)); [ "$n" -gt 500 ] && break; done; test -d "$1"';
// Lists a folder with md5 per file: kind\0name\0hash\0 triples. Exit 3: no such folder.
const HASH = 'cd "$1" 2>/dev/null || exit 3; if command -v md5sum >/dev/null 2>&1; then h() { md5sum < "$1" | cut -c1-32; }; else h() { md5 -q "$1"; }; fi; n=0; for p in * .[!.]* ..?*; do [ -e "$p" ] || continue; [ "$p" = .git ] && continue; [ "$p" = .DS_Store ] && continue; if [ -d "$p" ]; then printf "d\\0%s\\0-\\0" "$p"; else printf "f\\0%s\\0%s\\0" "$p" "$(h "$p" 2>/dev/null)"; fi; n=$((n+1)); [ "$n" -gt 1000 ] && break; done; exit 0';

async function listFolder(path, on) {
  const r = await exec("sh", ["-c", LIST, "201commander", path], { on });
  if (r.code !== 0) throw new Error(r.stderr || L("Ordner kann nicht gelesen werden", "Cannot read this folder"));
  const f = r.stdout.split("\0"), out = [];
  for (let i = 0; i + 1 < f.length; i += 2) out.push({ name: f[i + 1], dir: f[i] === "d" });
  return out.sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
}

function parseHash(stdout) {
  const f = stdout.split("\0"), out = new Map();
  for (let i = 0; i + 2 < f.length; i += 3) out.set(f[i + 1], { dir: f[i] === "d", hash: f[i + 2] });
  return out;
}

function diffRows(text) {
  let old = 0, next = 0;
  return text.split("\n").filter((l, i) => !(i < 2 && (l.startsWith("---") || l.startsWith("+++")))).map((line) => {
    const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
    if (m) { old = +m[1]; next = +m[2]; return { kind: "@", text: line }; }
    const k = line[0];
    if (k === "-") return { kind: k, number: old++, text: untab(line.slice(1)) || " " };
    if (k === "+") return { kind: k, number: next++, text: untab(line.slice(1)) || " " };
    if (k === " ") { old++; return { kind: k, number: next++, text: untab(line.slice(1)) || " " }; }
    return { kind: "", text: line || " " };
  });
}

// ---------- the view ----------
export default class Commander extends View {
  init(_props, cx) {
    this.handle = cx.focus_handle();
    this.pinned = null; this.gitRoots = new Map(); this.pendingRoots = [];
    this.entries = new Map(); this.folders = new Set(); this.marks = {};
    this.cmp = new Map(); this.remoteOnly = new Map();
    this.view = "tree"; this.width = 0; this.conn = { state: "idle" };
    this.hostInput = InputState.new({ placeholder: "user@server.de oder host:2222" });
    this.remoteInput = InputState.new({ placeholder: "/var/www/projekt" });
    this.hostInput.on("submit", (_e, cx) => this.connect(cx));
    this.remoteInput.on("submit", (_e, cx) => this.connect(cx));
    if (checking()) return;
    cx.spawn(async (cx) => { this.autoDe = await detectGerman(); cx.notify(); });
    this.refresh(cx);
    cx.timer.every(10000, (cx) => this.refresh(cx));
    cx.timer.every(20000, (cx) => { if (this.retroOn()) cx.notify(); });
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (c === "save") this.save(cx);
        else if (/^f([1-9]|10)$/.test(c)) this.fkey(Number(c.slice(1)), cx);
        else if (c === "retro") this.toggleRetro(cx);
        else if (c === "lang-de" || c === "lang-en") setShared(LANG_KEY, c.slice(5));
        else if (c === "focus") this.handle.focus();
        cx.notify();
      }
    });
  }

  // ----- look -----
  retroOn() { return shared(RETRO_KEY) === true; }
  pal() { return this.retroOn() ? DOS : theme(); }
  sz(n) { return this.retroOn() ? 16 : n; }
  toggleRetro(cx) {
    setShared(RETRO_KEY, !this.retroOn());
    if (this.editor && this.file && this.editorRetro !== this.retroOn()) this.makeEditor(null, this.file, true);
    cx.notify();
  }

  // F1–F10 in the retro key bar (and from keys.json: "201commander.f5" …).
  fkey(n, cx) {
    const rel = this.sel ?? (this.view !== "tree" ? (this.view === "diff" ? this.diffFile : this.file) : null);
    const dir = rel ? this.isDir(rel) : false, remote = rel ? this.cmp.get(rel) ?? ((this.remoteOnly.get(dirname(rel)) ?? []).some((e) => e.name === basename(rel)) ? "remote" : null) : null;
    switch (n) {
      case 1: setShared(LANG_KEY, UI_DE ? "en" : "de"); break;
      case 2: if (!this.on) rel ? this.finder(rel, dir) : this.finder("", true); break;
      case 3: if (rel && !dir && this.connected()) this.showDiff(rel, cx); break;
      case 4: if (rel && !dir && remote !== "remote") this.openFile(rel, cx); break;
      case 5: if (rel && remote !== "remote" && this.connected()) this.upload(rel, dir, cx); break;
      case 6: if (rel && (remote === "remote" || remote === "diff") && this.connected()) this.download(rel, dir, cx); break;
      case 7: this.refresh(cx); if (this.connected()) cx.spawn(async (cx) => { await this.compareAll(this.ctx, cx).catch(() => {}); cx.notify(); }); break;
      case 8: { const following = !(this.pinned && this.pinned.space === (spaces().find((s) => s.active)?.id ?? null)); this.setPinned(following ? this.root : null, cx); break; }
      case 9: if (!this.on) this.sshOpen = !this.sshOpen; break;
      case 10: this.toggleRetro(cx); break;
    }
    cx.notify();
  }

  // ----- where we are -----
  // The space's main folder: the repo (else folder) of its first terminal, as Herdr names spaces.
  // A folder picked by hand (pin, ↑, double-click) holds until the space changes.
  target() {
    const sp = spaces().find((s) => s.active)?.id ?? null;
    if (this.pinned && this.pinned.space === sp) return { cwd: this.pinned.path, on: this.pinned.on };
    return this.spaceRoot();
  }
  spaceRoot() {
    const space = spaces().find((s) => s.active);
    if (!space) return { cwd: null, on: null };
    const on = space.machine ?? null, all = panes();
    let cwd = null;
    for (const tab of space.tabs) {
      const p = all.find((x) => x.tab === tab.id && x.terminal && x.cwd);
      if (p) { cwd = p.cwd; break; }
    }
    cwd = cwd || space.folder || null;
    if (!cwd) return { cwd: null, on };
    const k = `${on ?? ""}|${cwd}`;
    if (!this.gitRoots.has(k)) { this.gitRoots.set(k, null); this.pendingRoots.push({ k, cwd, on }); }
    return { cwd: this.gitRoots.get(k), on };
  }
  resolveRoots(cx) {
    if (!this.pendingRoots.length || checking()) return;
    const jobs = this.pendingRoots.splice(0);
    cx.spawn(async (cx) => {
      for (const j of jobs) {
        const r = await exec("git", ["rev-parse", "--show-toplevel"], { cwd: j.cwd, on: j.on }).catch(() => null);
        this.gitRoots.set(j.k, r?.code === 0 && r.stdout.trim() ? r.stdout.trim() : j.cwd);
      }
      this.refresh(cx); cx.notify();
    });
  }
  key() { return JSON.stringify(this.target()); }
  abs(rel) { return join(this.root, rel); }

  cfg() {
    if (!this.root || this.on) return null;
    const all = shared(SSH_KEY) ?? {};
    let best = null;
    for (const [base, v] of Object.entries(all))
      if ((this.root === base || this.root.startsWith(base + "/")) && (!best || base.length > best.base.length)) best = { base, ...v };
    if (!best?.host || !best?.remote) return null;
    return { host: best.host, base: best.base, remote: best.remote.replace(/\/+$/, "") + this.root.slice(best.base.length) };
  }
  remoteOf(rel) { const c = this.cfg(); return c ? join(c.remote, rel) : null; }
  connected() { return this.conn.state === "ok" && this.cfg(); }

  current(ctx) { return this.ctx === ctx && this.key() === ctx.key; }

  refresh(cx) {
    const next = this.key(), { cwd, on } = this.target();
    if (next !== this.ctx?.key) {
      this.watching?.cancel?.(); this.watching = null;
      this.ctx = { key: next };
      this.root = cwd; this.on = on;
      this.entries = new Map(); this.folders = new Set(); this.marks = {};
      this.cmp = new Map(); this.remoteOnly = new Map();
      this.error = null; this.limited = false; this.loading = false; this.sel = null;
      this.conn = { state: "idle" };
      const c = this.cfg();
      this.hostInput.set_value(c?.host ?? ((shared(HOSTS_KEY) ?? [])[0] ?? ""));
      this.remoteInput.set_value(c?.remote ?? "");
      if (c) this.connect(cx, true);
    }
    if (!cwd || this.loading) return;
    const ctx = this.ctx;
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        let used = 0; this.limited = false;
        for (const path of ["", ...this.folders]) {
          const list = await listFolder(this.abs(path), on).catch((e) => { if (!path) throw e; return []; });
          if (!this.current(ctx)) return;
          if (list.length > PER_FOLDER || used + list.length > TOTAL) this.limited = true;
          const cut = list.slice(0, Math.max(0, Math.min(PER_FOLDER, TOTAL - used)));
          used += cut.length; this.entries.set(path, cut);
        }
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on }).catch(() => null);
        const marks = {};
        if (top?.code === 0) {
          const st = await exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"], { cwd, on }).catch(() => null);
          if (st?.code === 0) for (const e of st.stdout.split("\0").filter(Boolean).slice(0, TOTAL)) {
            const xy = e.slice(0, 2);
            marks[`${top.stdout.trim()}/${e.slice(3)}`] = xy === "??" || xy.includes("A") ? "A" : xy.includes("U") ? "U" : xy.includes("D") ? "D" : "M";
          }
        }
        if (!this.current(ctx)) return;
        this.marks = marks; this.error = null;
        this.watch(cx);
      } catch (e) { if (this.current(ctx)) this.error = String(e.message ?? e); }
      finally { if (this.ctx === ctx) this.loading = false; cx.notify(); }
    });
  }

  watch(cx) {
    if (this.on || this.watching) return;
    const ctx = this.ctx, root = this.root;
    cx.spawn(async (cx) => {
      try {
        while (this.ctx === ctx) {
          this.watching = watchFolder(root);
          await this.watching;
          if (this.ctx === ctx) this.refresh(cx);
        }
      } catch { if (this.ctx === ctx) this.watching = null; }
    });
  }

  setPinned(path, cx) {
    this.pinned = path ? { path, on: this.on, space: spaces().find((s) => s.active)?.id ?? null } : null;
    this.closeFile(); this.view = "tree";
    this.refresh(cx); cx.notify();
  }

  toggle(path, cx) {
    if (this.folders.has(path)) {
      for (const f of [...this.folders]) if (f === path || f.startsWith(path + "/")) { this.folders.delete(f); this.entries.delete(f); }
      cx.notify(); return;
    }
    this.folders.add(path);
    const ctx = this.ctx;
    cx.spawn(async (cx) => {
      try {
        const list = await listFolder(this.abs(path), this.on);
        if (this.current(ctx) && this.folders.has(path)) this.entries.set(path, list.slice(0, PER_FOLDER));
        if (this.connected()) await this.compareFolder(path, ctx);
      } catch (e) { if (this.current(ctx)) this.note = { text: String(e.message ?? e), level: "error" }; }
      finally { cx.notify(); }
    });
    cx.notify();
  }

  // ----- files: open, edit, save -----
  closeFile() { this.editor?.release(); this.editor = null; this.file = null; this.fileError = null; this.dirty = false; this.original = null; this.conflict = false; }

  guard(action) {
    if (!this.dirty) return action();
    this.ask(L(`Ungespeicherte Änderungen in ${basename(this.file)} verwerfen?`, `Discard unsaved changes in ${basename(this.file)}?`), L("Verwerfen", "Discard"), action);
  }

  openFile(rel, cx) {
    this.guard(() => {
      this.closeFile(); this.file = rel; this.view = "file";
      const ctx = this.ctx, on = this.on;
      cx.spawn(async (cx) => {
        try {
          const text = await readTextFile(this.abs(rel), { on });
          if (this.file !== rel || !this.current(ctx)) return;
          if (text === null) { this.fileError = L("Datei nicht mehr vorhanden", "This file is no longer available"); return; }
          if (text.includes("\0")) { this.fileError = L("Binärdatei – keine Textansicht. Mit »Öffnen« in der Standard-App öffnen.", "Binary file – no text view. Use “Open” to open it in its default app."); return; }
          this.makeEditor(text, rel);
        } catch { if (this.file === rel) this.fileError = L("Datei kann nicht angezeigt werden (binär, größer als 1 MB oder nicht lesbar).", "Cannot show this file (binary, larger than 1 MB, or unreadable)."); }
        finally { cx.notify(); }
      });
    });
    cx.notify();
  }

  // Narrow (side panel): soft wrap; wide: long lines scroll. `keep` rebuilds with the current text.
  makeEditor(text, rel, keep = false) {
    const t = this.pal(), retro = this.retroOn(), ext = rel.includes(".") ? rel.split(".").pop().toLowerCase() : "txt";
    const old = this.editor, value = keep && old ? old.value() : text, range = keep && old ? old.selected_range() : null;
    const wrap = this.width > 0 && this.width < 760, font = retro ? DOS_FONT : settings().font_family;
    let next;
    try {
      next = EditorState.new({ language: LANG[ext] ?? ext, value, readonly: Boolean(this.on), soft_wrap: wrap,
        ...(font ? { font_family: font } : {}), font_size: retro ? 16 : 12.5,
        syntax: { keyword: t.ansi5, string: t.ansi2, comment: t.dim, function: t.ansi4, type: t.ansi3, number: t.ansi1, constant: t.ansi6 } });
    } catch (e) { this.note = { text: L(`Editor-Fehler: ${e?.message ?? e}`, `Editor error: ${e?.message ?? e}`), level: "error" }; return; }
    // Release the old state only once the new one exists, so a failure keeps the old editor.
    if (!keep) { this.original = text; this.dirty = false; this.conflict = false; }
    this.wrap = wrap; this.editorRetro = retro; this.editor = next;
    old?.release();
    next.on("change", (_e, cx) => {
      if (this.editor !== next) return;
      const d = next.value() !== this.original;
      if (d !== this.dirty) { this.dirty = d; cx.notify(); }
    });
    if (range) { try { next.set_selected_range(range); } catch {} }
  }

  save(cx, force = false) {
    if (!this.editor || !this.file || this.on || this.saving) return;
    const rel = this.file, path = this.abs(rel), text = this.editor.value(), ctx = this.ctx;
    this.saving = true;
    cx.spawn(async (cx) => {
      try {
        const expected = force ? await readTextFile(path) : this.original;
        await writeTextFile(path, text, expected);
        if (this.file === rel) { this.original = text; this.dirty = this.editor.value() !== text; this.conflict = false; }
        this.note = { text: L(`Gespeichert: ${rel}`, `Saved: ${rel}`), level: "ok" };
        if (this.connected() && this.current(ctx)) await this.compareFolder(dirname(rel), ctx);
      } catch (e) {
        this.conflict = true;
        this.note = { text: L("Die Datei wurde inzwischen außerhalb geändert. Neu laden oder überschreiben?", "The file was changed elsewhere. Reload or overwrite?"), level: "error" };
      } finally { this.saving = false; cx.notify(); }
    });
    cx.notify();
  }

  reload(cx) {
    const rel = this.file, ctx = this.ctx;
    cx.spawn(async (cx) => {
      const text = await readTextFile(this.abs(rel)).catch(() => null);
      if (text !== null && this.file === rel && this.current(ctx)) { this.makeEditor(text, rel); this.note = null; }
      cx.notify();
    });
  }

  // ----- Finder & friends -----
  finder(rel, dir) {
    const p = this.abs(rel);
    exec("open", dir ? [p] : ["-R", p]).catch(() => {});
  }
  openDefault(rel) { exec("open", [this.abs(rel)]).catch(() => {}); }
  copyPath(rel, cx) {
    exec("sh", ["-c", 'printf %s "$1" | pbcopy', "x", this.abs(rel)]).catch(() => {});
    this.note = { text: L(`Pfad kopiert: ${tilde(this.abs(rel))}`, `Path copied: ${tilde(this.abs(rel))}`), level: "ok" }; cx.notify();
  }
  terminalHere(relDir) { run("terminal.open", { folder: this.abs(relDir), place: "tab" }); }

  // ----- SSH -----
  connect(cx, quiet = false) {
    if (!this.root || this.on) return;
    const host = this.hostInput.value().trim(), remote = this.remoteInput.value().trim().replace(/\/+$/, "") || "/";
    let base = this.root, rem = remote;
    if (quiet) { const c = this.cfg(); if (!c) return; base = c.base; }
    else {
      if (!validHost(host)) { this.conn = { state: "error", msg: L("Ungültiger Host (Format: user@host oder user@host:port)", "Invalid host (format: user@host or user@host:port)") }; cx.notify(); return; }
      if (!remote.startsWith("/") && !remote.startsWith("~")) { this.conn = { state: "error", msg: L("Remote-Pfad muss absolut sein (/…) oder mit ~ beginnen", "Remote path must be absolute (/…) or start with ~") }; cx.notify(); return; }
      const c = this.cfg();
      // Editing while inside a mapped subfolder updates the mapping's base instead of adding a nested one.
      if (c && c.base !== this.root && c.host === host && c.remote === remote) base = c.base;
      const all = { ...(shared(SSH_KEY) ?? {}) };
      if (base === this.root) all[base] = { host, remote: rem };
      setShared(SSH_KEY, all);
      setShared(HOSTS_KEY, [host, ...((shared(HOSTS_KEY) ?? []).filter((h) => h !== host))].slice(0, 10));
    }
    const ctx = this.ctx, c = this.cfg();
    if (!c) return;
    this.conn = { state: "connecting" };
    cx.spawn(async (cx) => {
      try {
        const r = await ssh(c.host, `cd ${rq(c.remote)} 2>/dev/null && echo ok || echo missing`, 20000);
        if (!this.current(ctx)) return;
        if (r.code !== 0) { this.conn = { state: "error", msg: (r.stderr || L("Verbindung fehlgeschlagen", "Connection failed")).trim().split("\n").pop() }; return; }
        this.conn = { state: "ok", missing: r.stdout.trim() === "missing" };
        await this.compareAll(ctx, cx);
      } catch (e) { if (this.current(ctx)) this.conn = { state: "error", msg: String(e.message ?? e) }; }
      finally { cx.notify(); }
    });
    cx.notify();
  }

  disconnect(cx) {
    const c = this.cfg();
    if (c) { const all = { ...(shared(SSH_KEY) ?? {}) }; delete all[c.base]; setShared(SSH_KEY, all); }
    this.conn = { state: "idle" }; this.cmp = new Map(); this.remoteOnly = new Map();
    cx.notify();
  }

  async compareAll(ctx, cx) {
    this.busy = L("Vergleiche mit Server…", "Comparing with server…"); cx?.notify();
    try { for (const p of ["", ...this.folders]) { if (!this.current(ctx)) return; await this.compareFolder(p, ctx); cx?.notify(); } }
    finally { this.busy = null; }
  }

  async compareFolder(rel, ctx) {
    const c = this.cfg();
    if (!c) return;
    const [l, r] = await Promise.all([
      exec("sh", ["-c", HASH, "x", this.abs(rel)], { timeout: 120000 }),
      ssh(c.host, `sh -c ${q(HASH)} x ${rq(join(c.remote, rel))}`, 120000),
    ]);
    if (!this.current(ctx)) return;
    if (r.code !== 0 && r.code !== 3) throw new Error((r.stderr || L("Vergleich fehlgeschlagen", "Compare failed")).trim());
    const local = parseHash(l.stdout), remote = r.code === 3 ? new Map() : parseHash(r.stdout);
    for (const k of [...this.cmp.keys()]) if (dirname(k) === rel) this.cmp.delete(k);
    for (const [name, e] of local) {
      const o = remote.get(name), p = join(rel, name).replace(/^\//, "");
      this.cmp.set(p, !o ? "local" : e.dir || o.dir ? (e.dir === o.dir ? "same" : "diff") : e.hash === o.hash ? "same" : "diff");
    }
    this.remoteOnly.set(rel, [...remote].filter(([n]) => !local.has(n)).map(([name, e]) => ({ name, dir: e.dir }))
      .sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name)));
  }

  // Runs one transfer with progress, then re-compares the touched folder.
  transfer(label, done, rel, work, cx) {
    const ctx = this.ctx;
    this.busy = label; cx.notify();
    cx.spawn(async (cx) => {
      try {
        const r = await work();
        if (r.code !== 0) throw new Error((r.stderr || `Exit ${r.code}`).trim().split("\n").pop());
        this.note = { text: `✓ ${done}`, level: "ok" };
        if (this.current(ctx)) { await this.compareFolder(dirname(rel), ctx); this.refresh(cx); }
      } catch (e) { this.note = { text: L(`Fehlgeschlagen: ${label.replace("…", "")} – ${e.message ?? e}`, `Failed: ${label.replace("…", "")} – ${e.message ?? e}`), level: "error" }; }
      finally { this.busy = null; cx.notify(); }
    });
  }

  uploadCmd(rel, dir) {
    const c = this.cfg(), args = sshArgs(c.host), remote = join(c.remote, rel);
    if (!dir) return net("sh", ["-c", 'f=$1; shift; exec ssh "$@" < "$f"', "x", this.abs(rel), ...args, `mkdir -p ${rq(dirname(remote) || "/")} && cat > ${rq(remote)}`], 600000);
    const parent = dirname(remote) || "/";
    return net("sh", ["-c", 'd=$1; n=$2; shift 2; COPYFILE_DISABLE=1 tar -C "$d" --exclude .git --exclude .DS_Store -cf - "./$n" | ssh "$@"', "x", dirname(this.abs(rel)), basename(rel), ...args, `mkdir -p ${rq(parent)} && tar -C ${rq(parent)} -xf -`], 600000);
  }

  upload(rel, dir, cx) {
    if (!this.connected()) return;
    const go = () => this.transfer(L(`Lade ${basename(rel)} hoch…`, `Uploading ${basename(rel)}…`), L(`Hochgeladen: ${basename(rel)}`, `Uploaded ${basename(rel)}`), rel, () => this.uploadCmd(rel, dir), cx);
    if (this.cmp.get(rel) === "diff" || (dir && this.cmp.get(rel) === "same")) this.ask(L(`${basename(rel)} auf dem Server überschreiben?`, `Overwrite ${basename(rel)} on the server?`), L("Hochladen", "Upload"), go);
    else go();
  }

  download(rel, dir, cx) {
    if (!this.connected()) return;
    const c = this.cfg(), args = sshArgs(c.host), remote = join(c.remote, rel), local = this.abs(rel);
    const work = () => dir
      ? net("sh", ["-c", 'd=$1; shift; mkdir -p "$d" && ssh "$@" | tar -C "$d" -xf -', "x", dirname(local), ...args, `tar -C ${rq(dirname(remote) || "/")} -cf - ${q("./" + basename(rel))}`], 600000)
      : net("sh", ["-c", 'f=$1; shift; mkdir -p "$(dirname "$f")" && ssh "$@" > "$f.201commander-part" && mv "$f.201commander-part" "$f" || { rm -f "$f.201commander-part"; exit 1; }', "x", local, ...args, `cat ${rq(remote)}`], 600000);
    const go = () => this.transfer(L(`Lade ${basename(rel)} herunter…`, `Downloading ${basename(rel)}…`), L(`Heruntergeladen: ${basename(rel)}`, `Downloaded ${basename(rel)}`), rel, async () => {
      const r = await work();
      if (r.code === 0 && this.file === rel) this.reload(cx);
      return r;
    }, cx);
    if (this.cmp.get(rel) === "diff" || (this.cmp.get(rel) === "same" && dir)) this.ask(L(`Lokale ${basename(rel)} mit der Server-Version überschreiben?`, `Overwrite local ${basename(rel)} with the server version?`), "Herunterladen", go);
    else go();
  }

  uploadAllChanged(cx) {
    const items = [...this.cmp].filter(([p, s]) => s === "diff" || s === "local")
      .filter(([p]) => ![...this.cmp].some(([o, s]) => s === "local" && o !== p && p.startsWith(o + "/")))
      .map(([p]) => ({ p, dir: this.isDir(p) })).filter((i) => !(i.dir && this.cmp.get(i.p) === "diff"));
    if (!items.length) { this.note = { text: L("Keine Unterschiede in den geöffneten Ordnern", "No differences in the open folders"), level: "ok" }; cx.notify(); return; }
    this.ask(L(`${items.length} geänderte/neue Einträge hochladen?`, `Upload ${items.length} changed/new entries?`), L("Alle hochladen", "Upload all"), () => {
      const ctx = this.ctx;
      cx.spawn(async (cx) => {
        let done = 0, failed = 0;
        for (const i of items) {
          this.busy = L(`Hochladen ${done + 1}/${items.length}: ${i.p}`, `Uploading ${done + 1}/${items.length}: ${i.p}`); cx.notify();
          const r = await this.uploadCmd(i.p, i.dir).catch(() => ({ code: 1 }));
          r.code === 0 ? done++ : failed++;
        }
        this.busy = null;
        this.note = { text: (UI_DE ? `${done} hochgeladen${failed ? `, ${failed} fehlgeschlagen` : ""}` : `${done} uploaded${failed ? `, ${failed} failed` : ""}`), level: failed ? "error" : "ok" };
        if (this.current(ctx)) await this.compareAll(ctx, cx);
        cx.notify();
      });
    });
    cx.notify();
  }

  isDir(rel) {
    const parent = dirname(rel), name = basename(rel);
    return Boolean((this.entries.get(parent) ?? []).find((e) => e.name === name)?.dir || (this.remoteOnly.get(parent) ?? []).find((e) => e.name === name)?.dir);
  }

  showDiff(rel, cx) {
    if (!this.connected()) return;
    this.guard(() => {
      const c = this.cfg();
      this.diffFile = rel; this.diff = null; this.diffError = null; this.view = "diff";
      cx.spawn(async (cx) => {
        try {
          const r = await net("sh", ["-c", 'l=$1; shift; t=$(mktemp) || exit 9; trap \'rm -f "$t"\' EXIT; ssh "$@" > "$t" || exit 9; diff -u --label local --label server -- "$l" "$t"', "x", this.abs(rel), ...sshArgs(c.host), `cat ${rq(join(c.remote, rel))}`], 120000);
          if (this.diffFile !== rel) return;
          if (r.code === 0) this.diff = [{ kind: "", text: L("Identisch – keine Unterschiede.", "Identical – no differences.") }];
          else if (r.code === 1) this.diff = diffRows(r.stdout);
          else this.diffError = (r.stderr || L("Diff fehlgeschlagen", "Diff failed")).trim();
        } catch (e) { this.diffError = String(e.message ?? e); }
        finally { cx.notify(); }
      });
    });
    cx.notify();
  }

  // ----- confirm bar -----
  ask(text, yes, action) { this.confirm = { text, yes, action }; }

  // ---------- rendering ----------
  icon(name, t, size = 14, color) { return svg(M + name + ".svg").size(size).flex_none().text_color(color ?? t.muted); }

  btn(id, iconName, tip, onClick, t, opts = {}) {
    const enabled = opts.enabled !== false;
    return div().id(id).h(26).px(opts.label ? 8 : 6).flex().items_center().gap(5).rounded(6).flex_none()
      .when(Boolean(opts.solid), (e) => e.bg(t.solid).text_color(t.solid_foreground))
      .when(!opts.solid, (e) => e.text_color(enabled ? t.muted : t.dim))
      .when(enabled, (e) => e.cursor_pointer().hover((s) => (opts.solid ? s.opacity(0.88) : s.bg(t.hover).text_color(t.foreground))))
      .when(!enabled, (e) => e.opacity(0.45))
      .tooltip(tip)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((e, cx) => { if (enabled) { cx.stop_propagation(); onClick(e, cx); cx.notify(); } })
      .child(svg(M + iconName + ".svg").size(14).flex_none().text_color(opts.solid ? t.solid_foreground : opts.color ?? (enabled ? t.muted : t.dim)))
      .when(Boolean(opts.label), (e) => e.child(div().text_size(this.sz(12)).child(opts.label)));
  }

  badge(status, t) {
    const map = { diff: ["≠", t.blocked, L("Unterschiedlich zum Server", "Differs from the server")], local: ["↑", t.ansi2, L("Nur lokal – noch nicht auf dem Server", "Local only – not on the server yet")], remote: ["↓", t.ansi4, L("Nur auf dem Server", "Only on the server")] };
    const b = map[status];
    if (!b) return null;
    return div().id(`badge-${status}`).w(14).flex_none().text_size(this.sz(12)).font_semibold().text_color(b[1]).child(b[0]);
  }

  rows(prefix, depth, out, t) {
    if (out.length >= TOTAL || depth > 40) return out;
    const conn = this.connected();
    const list = [...(this.entries.get(prefix) ?? []).map((e) => ({ ...e, remote: false })),
      ...(conn ? (this.remoteOnly.get(prefix) ?? []).map((e) => ({ ...e, remote: true })) : [])];
    for (const entry of list) {
      if (out.length >= TOTAL) break;
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      const open = !entry.remote && this.folders.has(path), mark = this.marks[`${this.root}/${path}`];
      const sel = this.sel === path, status = entry.remote ? "remote" : conn ? this.cmp.get(path) : null;
      const active = (this.view === "file" && this.file === path) || (this.view === "diff" && this.diffFile === path);
      if (this.retroOn()) { out.push(this.dosRow(entry, path, depth, open, mark, sel || active, sel, status, t)); if (entry.dir && open) this.rows(path, depth + 1, out, t); continue; }
      out.push(h_flex().id(`row-${entry.remote ? "r" : "l"}-${path}`).h(28).flex_none().pl(6 + depth * 16).pr(4).gap(6).items_center().rounded(6).cursor_pointer()
        .when(sel || active, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover))
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((e, cx) => {
          this.sel = path;
          if (entry.remote) { cx.notify(); return; }
          if (entry.dir) { if (e.click_count === 2) this.setPinned(this.abs(path), cx); else this.toggle(path, cx); }
          else this.openFile(path, cx);
          cx.notify();
        })
        .child(entry.dir && !entry.remote ? this.icon(`chevron-${open ? "down" : "right"}`, t, 12, t.dim) : div().w(12).flex_none())
        .child(this.icon(entry.dir ? (open ? "folder-open" : "folder") : "file", t, 14, entry.remote ? t.dim : entry.dir ? t.accent : t.muted))
        .child(div().flex_1().min_w(0).truncate().text_color(entry.remote ? t.dim : t.foreground).child(entry.name))
        .when(sel, (e) => e.children(this.rowActions(path, entry, status, t)))
        .when(Boolean(mark) && !sel, (e) => e.child(div().w(12).flex_none().text_size(this.sz(11)).text_color(mark === "A" ? t.ansi2 : mark === "D" || mark === "U" ? t.ansi1 : t.blocked).child(mark)))
        .when(Boolean(status) && status !== "same", (e) => e.child(this.badge(status, t))));
      if (entry.dir && open) this.rows(path, depth + 1, out, t);
    }
    return out;
  }

  rowActions(path, entry, status, t) {
    const a = [], conn = this.connected();
    if (entry.remote) {
      a.push(this.btn(`dl-${path}`, "download", L("Vom Server herunterladen", "Download from server"), (_e, cx) => this.download(path, entry.dir, cx), t, { color: t.ansi4 }));
      return a;
    }
    if (!this.on) a.push(this.btn(`fi-${path}`, "finder", L("Im Finder zeigen", "Show in Finder"), () => this.finder(path, false), t));
    if (entry.dir) a.push(this.btn(`te-${path}`, "terminal", L("Terminal hier öffnen", "Open terminal here"), () => this.terminalHere(path), t));
    if (conn) {
      if (!entry.dir && status === "diff") a.push(this.btn(`df-${path}`, "diff", L("Mit Server vergleichen", "Compare with server"), (_e, cx) => this.showDiff(path, cx), t, { color: t.blocked }));
      if (status === "diff" && !entry.dir) a.push(this.btn(`dn-${path}`, "download", L("Server-Version holen", "Get server version"), (_e, cx) => this.download(path, false, cx), t));
      a.push(this.btn(`up-${path}`, "upload", entry.dir ? L("Ordner hochladen", "Upload folder") : L("Hochladen", "Upload"), (_e, cx) => this.upload(path, entry.dir, cx), t, { color: status === "local" || status === "diff" ? t.ansi2 : undefined }));
    }
    return a;
  }

  // ----- retro look -----
  dosRow(entry, path, depth, open, mark, bar, sel, status, t) {
    const b = bar ? DOS_BAR : DOS, nameColor = bar ? DOS.black : entry.remote ? DOS.dim : entry.dir ? DOS.white : DOS.foreground;
    return h_flex().id(`row-${entry.remote ? "r" : "l"}-${path}`).h(20).flex_none().pl(4 + depth * 16).pr(2).gap(8).items_center().cursor_pointer()
      .when(bar, (e) => e.bg(DOS.selected)).when(!bar, (e) => e.hover((s) => s.bg(DOS.hover)))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((e, cx) => {
        this.sel = path;
        if (entry.remote) { cx.notify(); return; }
        if (entry.dir) { if (e.click_count === 2) this.setPinned(this.abs(path), cx); else this.toggle(path, cx); }
        else this.openFile(path, cx);
        cx.notify();
      })
      .child(div().w(10).flex_none().text_color(bar ? DOS.black : DOS.white).child(entry.dir && !entry.remote ? (open ? "▼" : "►") : ""))
      .child(div().flex_1().min_w(0).truncate().text_color(nameColor).child(entry.dir ? entry.name.toUpperCase() : entry.name))
      .when(sel, (e) => e.children(this.rowActions(path, entry, status, b)))
      .when(Boolean(mark) && !sel, (e) => e.child(div().w(10).flex_none().text_color(mark === "A" ? DOS.ansi2 : mark === "D" || mark === "U" ? DOS.ansi1 : DOS.yellow).child(mark)))
      .when(Boolean(status) && status !== "same", (e) => e.child(this.badge(status, b)))
      .when(entry.dir && !sel, (e) => e.child(div().flex_none().text_color(bar ? DOS.black : DOS.white).child(L("►ORDNER◄", "►SUB-DIR◄"))));
  }

  // A double-line frame with its title in the top line, as DOS file commanders drew panels.
  dosFrame(id, title, active, body) {
    return div().id(id).relative().h_full().min_h(0).min_w(0).pt(8).px(4).pb(2)
      .child(div().size_full().border_1().border_color(DOS.border).p(2)
        .child(v_flex().size_full().min_h(0).border_1().border_color(DOS.border).overflow_hidden().child(body)))
      .when(Boolean(title), (e) => e.child(h_flex().absolute().top(0).left(0).right(0).h(16).justify_center()
        .child(div().px(4).bg(active ? DOS.selected : DOS.background).text_color(active ? DOS.black : DOS.white).truncate().child(` ${title} `))));
  }

  dosMenu(overlay) {
    const item = (id, label, tip, onClick, on = true) => div().id(id).px(10).h_full().flex().items_center().flex_none()
      .text_color(on ? DOS.black : "#006666").when(on, (e) => e.cursor_pointer().hover((s) => s.bg(DOS.black).text_color(DOS.foreground)))
      .tooltip(tip).on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { if (on) { cx.stop_propagation(); onClick(cx); cx.notify(); } }).child(label);
    const following = !(this.pinned && this.pinned.space === (spaces().find((s) => s.active)?.id ?? null));
    const now = new Date(), clock = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
    return h_flex().h(22).flex_none().bg(DOS.chrome).text_color(DOS.black).items_center()
      .child(div().px(10).h_full().flex().items_center().bg(DOS.black).text_color(DOS.yellow).flex_none().child("201Commander"))
      .child(item("m-up", L("Hoch", "Up"), L("Übergeordneter Ordner", "Parent folder"), (cx) => this.root && this.setPinned(dirname(this.root) || "/", cx), Boolean(this.root) && !this.on))
      .child(item("m-dir", L("Ordner", "Dir"), L("Ordner wählen…", "Choose folder…"), (cx) => cx.spawn(async (cx) => { const p = await pickFolder({ prompt: L("Öffnen", "Open") }); if (p) this.setPinned(p, cx); })))
      .child(item("m-pin", following ? L("Fixieren", "Pin") : L("Haupt", "Main"), following ? L("Hauptordner des Space – klicken zum Fixieren", "Space main folder – click to pin") : L("Fixiert – klicken für den Hauptordner des Space", "Pinned – click for the space main folder"), (cx) => this.fkey(8, cx)))
      .child(item("m-ssh", this.conn.state === "ok" ? "SSH ✓" : "SSH", L("SSH-Server verbinden / vergleichen", "Connect / compare SSH server"), (cx) => this.fkey(9, cx), !this.on))
      .child(item("m-lang", UI_DE ? "DE" : "EN", L("Sprache umschalten", "Switch language"), (cx) => this.fkey(1, cx)))
      .child(item("m-modern", L("Modern", "Modern"), L("Zurück zum normalen Design", "Back to the normal look"), (cx) => this.toggleRetro(cx)))
      .child(div().flex_1())
      .child(div().px(10).flex_none().child(clock))
      .when(Boolean(overlay), (e) => e.child(item("m-close", "[■]", L("Schließen", "Close"), () => closeOverlay(overlay))));
  }

  dosKeys() {
    const keys = [[1, L("Sprache", "Lang")], [2, "Finder"], [3, "Diff"], [4, L("Bearb.", "Edit")], [5, L("Hoch", "Upload")],
      [6, L("Runter", "Get")], [7, L("Neu", "Reload")], [8, L("Fix", "Pin")], [9, "SSH"], [10, "Modern"]];
    return h_flex().h(20).flex_none().bg(DOS.black).children(keys.map(([n, label]) =>
      h_flex().id(`fk-${n}`).flex_1().min_w(0).h_full().cursor_pointer()
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => { cx.stop_propagation(); this.fkey(n, cx); })
        .child(div().flex_none().pl(n === 1 ? 0 : 6).pr(1).text_color(DOS.white).child(String(n)))
        .child(div().flex_1().min_w(0).truncate().bg(DOS.selected).text_color(DOS.black).hover((s) => s.bg(DOS.foreground)).child(label))));
  }

  dosPrompt() {
    return h_flex().h(20).flex_none().px(2).bg(DOS.black).text_color(DOS.ansi7)
      .child(div().min_w(0).truncate().child(`${tilde(this.root) || "C:\\"}>`))
      .child(div().text_color(DOS.ansi7).frames(["_", " "], 530));
  }

  header(t, overlay) {
    const following = !(this.pinned && this.pinned.space === (spaces().find((s) => s.active)?.id ?? null));
    return h_flex().h(40).flex_none().pl(overlay ? 12 : 10).pr(6).gap(2).items_center().border_b(1).border_color(t.border).bg(t.chrome)
      .child(div().font_semibold().pr(6).child("201Commander"))
      .child(div().flex_1().min_w(0).truncate().text_size(this.sz(12)).text_color(t.dim).child(tilde(this.root) || L("Kein Ordner", "No folder")))
      .child(this.btn("h-up", "up", L("Übergeordneter Ordner", "Parent folder"), (_e, cx) => this.root && this.setPinned(dirname(this.root) || "/", cx), t, { enabled: Boolean(this.root) && !this.on }))
      .child(this.btn("h-pick", "folder-open", L("Ordner wählen…", "Choose folder…"), (_e, cx) => cx.spawn(async (cx) => { const p = await pickFolder({ prompt: L("Öffnen", "Open") }); if (p) this.setPinned(p, cx); }), t))
      .child(this.btn("h-follow", following ? "crosshair" : "pin", following ? L("Hauptordner des Space – klicken zum Fixieren", "Space main folder – click to pin") : L("Fixiert – klicken für den Hauptordner des Space", "Pinned – click for the space main folder"), (_e, cx) => this.setPinned(following ? this.root : null, cx), t, { color: following ? t.accent : t.blocked, enabled: Boolean(this.root || this.pinned) }))
      .child(this.btn("h-refresh", "refresh", L("Neu laden", "Reload"), (_e, cx) => { this.refresh(cx); if (this.connected()) cx.spawn(async (cx) => { await this.compareAll(this.ctx, cx); cx.notify(); }); }, t))
      .child(this.btn("h-finder", "finder", L("Ordner im Finder öffnen", "Open folder in Finder"), () => this.finder("", true), t, { enabled: Boolean(this.root) && !this.on }))
      .child(this.btn("h-ssh", "server", L("SSH-Server verbinden / vergleichen", "Connect / compare SSH server"), (_e, cx) => { this.sshOpen = !this.sshOpen; }, t,
        { color: this.conn.state === "ok" ? t.ansi2 : this.conn.state === "error" ? t.ansi1 : this.sshOpen ? t.foreground : undefined, enabled: !this.on }))
      .child(this.btn("h-retro", "retro", L("Retro-DOS-Design", "Retro DOS look"), (_e, cx) => this.toggleRetro(cx), t))
      .child(div().id("h-lang").h(26).px(6).flex().items_center().rounded(6).flex_none().cursor_pointer().text_size(this.sz(11)).font_semibold().text_color(t.dim)
        .hover((st) => st.bg(t.hover).text_color(t.foreground)).tooltip(L("Sprache: Deutsch – klicken für Englisch", "Language: English – click for German"))
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => { cx.stop_propagation(); setShared(LANG_KEY, UI_DE ? "en" : "de"); cx.notify(); })
        .child(UI_DE ? "DE" : "EN"))
      .when(Boolean(overlay), (e) => e.child(this.btn("h-close", "x", L("Schließen", "Close"), () => closeOverlay(overlay), t)));
  }

  sshBar(t) {
    const c = this.cfg(), st = this.conn.state;
    const field = (id, state, w) => div().id(id).flex_1().min_w(w).h(28).px(8).flex().items_center().rounded(6).border_1().border_color(t.input).bg(t.background).cursor_text()
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).child(Input.new(state).h_full().text_size(this.sz(12)).text_color(t.foreground));
    const counts = { diff: 0, local: 0, remote: 0 };
    for (const s of this.cmp.values()) if (counts[s] !== undefined) counts[s]++;
    for (const l of this.remoteOnly.values()) counts.remote += l.length;
    return v_flex().flex_none().p(8).gap(6).border_b(1).border_color(t.border).bg(t.surface).text_size(this.sz(12))
      .child(h_flex().gap(6).items_center().flex_wrap()
        .child(field("ssh-host", this.hostInput, 150))
        .child(field("ssh-remote", this.remoteInput, 150))
        .child(this.btn("ssh-connect", "server", L("Verbinden und vergleichen", "Connect and compare"), (_e, cx) => this.connect(cx), t, { solid: true, label: st === "ok" ? L("Neu verbinden", "Reconnect") : L("Verbinden", "Connect") }))
        .when(Boolean(c), (e) => e.child(this.btn("ssh-forget", "x", L("Zuordnung entfernen", "Remove mapping"), (_e, cx) => this.disconnect(cx), t))))
      .child(h_flex().gap(8).items_center().text_color(t.dim)
        .child(st === "connecting" ? div().text_color(t.working).frames(["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"], 90) : div().w(8).h(8).rounded(4).flex_none().bg(st === "ok" ? t.ansi2 : st === "error" ? t.ansi1 : t.dim))
        .child(div().flex_1().min_w(0).truncate().text_color(st === "error" ? t.ansi1 : t.dim).child(
          st === "ok" ? `${c.host}:${c.remote}${this.conn.missing ? L(" (Ordner existiert noch nicht)", " (folder does not exist yet)") : ""}`
            : st === "error" ? this.conn.msg : st === "connecting" ? L("Verbinde…", "Connecting…") : L(`Lokaler Ordner ${tilde(this.root)} ↔ Server-Ordner (gleiche Struktur). SSH-Key nötig.`, `Local folder ${tilde(this.root)} ↔ server folder (same structure). Needs an SSH key.`)))
        .when(st === "ok", (e) => e
          .child(div().text_color(t.blocked).child(`≠ ${counts.diff}`)).child(div().text_color(t.ansi2).child(`↑ ${counts.local}`)).child(div().text_color(t.ansi4).child(`↓ ${counts.remote}`))
          .child(this.btn("ssh-cmp", "refresh", L("Erneut vergleichen", "Compare again"), (_e, cx) => cx.spawn(async (cx) => { await this.compareAll(this.ctx, cx).catch((e) => { this.note = { text: String(e.message ?? e), level: "error" }; }); cx.notify(); }), t))
          .child(this.btn("ssh-all", "upload", L("Alle Unterschiede in geöffneten Ordnern hochladen", "Upload all differences in open folders"), (_e, cx) => this.uploadAllChanged(cx), t, { label: L("Alle hoch", "Upload all"), color: t.ansi2, enabled: counts.diff + counts.local > 0 }))));
  }

  tree(t) {
    const rows = this.rows("", 0, [], t);
    return div().flex_1().min_h(0).relative()
      .child(v_flex().id("201commander-tree").absolute().inset_0().overflow_y_scroll().p(5).children(rows)
        .when(Boolean(this.error) || !rows.length, (e) => e.child(div().p(8).text_size(this.sz(12)).text_color(this.error ? t.ansi1 : t.dim).child(this.error || (this.loading ? L("Lade…", "Loading…") : this.root ? L("Leerer Ordner", "Empty folder") : L("Kein Ordner – Ordner wählen oder ein Terminal fokussieren", "No folder – choose one or start a terminal in this space")))))
        .when(this.limited, (e) => e.child(div().p(8).text_size(this.sz(11)).text_color(t.dim).child(L("Liste begrenzt auf 500 Einträge pro Ordner / 5.000 gesamt", "List limited to 500 entries per folder / 5,000 total")))))
      .child(Scrollbar.vertical("201commander-tree").absolute().inset_0());
  }

  fileView(t, narrow) {
    const rel = this.file, conn = this.connected(), status = conn ? this.cmp.get(rel) : null;
    return v_flex().flex_1().h_full().min_w(0).min_h(0)
      .child(h_flex().h(36).flex_none().px(6).gap(2).items_center().border_b(1).border_color(t.border)
        .when(narrow, (e) => e.child(this.btn("f-back", "back", L("Zurück zur Liste", "Back to list"), () => this.guard(() => { this.closeFile(); this.view = "tree"; }), t)))
        .child(h_flex().flex_1().min_w(0).gap(6).items_center().px(4)
          .child(div().min_w(0).truncate().font_semibold().text_size(this.sz(12)).child(basename(rel)))
          .when(this.dirty, (e) => e.child(div().w(7).h(7).rounded(4).flex_none().bg(t.blocked)))
          .child(div().min_w(0).flex_1().truncate().text_size(this.sz(11)).text_color(t.dim).child(dirname(rel)))
          .when(Boolean(status) && status !== "same", (e) => e.child(this.badge(status, t))))
        .when(!this.on, (e) => e
          .child(this.btn("f-save", "save", L("Speichern (⌘S)", "Save (⌘S)"), (_e, cx) => this.save(cx), t, { enabled: this.dirty || this.conflict, solid: this.dirty, label: this.saving ? "…" : L("Speichern", "Save") }))
          .child(this.btn("f-finder", "finder", L("Im Finder zeigen", "Show in Finder"), () => this.finder(rel, false), t))
          .child(this.btn("f-open", "external", L("Mit Standard-App öffnen", "Open with default app"), () => this.openDefault(rel), t))
          .child(this.btn("f-copy", "copy", L("Pfad kopieren", "Copy path"), (_e, cx) => this.copyPath(rel, cx), t)))
        .when(conn, (e) => e
          .child(this.btn("f-diff", "diff", L("Mit Server vergleichen", "Compare with server"), (_e, cx) => this.showDiff(rel, cx), t, { color: status === "diff" ? t.blocked : undefined }))
          .child(this.btn("f-up", "upload", L("Auf Server hochladen", "Upload to server"), (_e, cx) => { if (this.dirty) this.note = { text: L("Erst speichern, dann hochladen", "Save first, then upload"), level: "error" }; else this.upload(rel, false, cx); }, t, { color: status === "local" || status === "diff" ? t.ansi2 : undefined }))))
      .when(this.conflict, (e) => e.child(h_flex().flex_none().px(10).py(6).gap(8).items_center().bg(t.ansi1 + "22").text_size(this.sz(12))
        .child(div().flex_1().child(L("Datei wurde extern geändert.", "The file was changed elsewhere.")))
        .child(this.btn("c-reload", "refresh", L("Neu laden (eigene Änderungen verwerfen)", "Reload (discard your changes)"), (_e, cx) => this.reload(cx), t, { label: L("Neu laden", "Reload") }))
        .child(this.btn("c-force", "save", L("Trotzdem überschreiben", "Overwrite anyway"), (_e, cx) => this.save(cx, true), t, { label: L("Überschreiben", "Overwrite") }))))
      .child(div().flex_1().min_h(0).on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .child(this.editor ? Editor.new(this.editor).size_full().when(this.retroOn(), (e) => e.bg(DOS.background).text_color(DOS.foreground)) : div().p(12).text_size(this.sz(12)).text_color(t.dim).child(this.fileError || L("Lade Datei…", "Loading file…"))));
  }

  diffView(t, narrow) {
    const rel = this.diffFile, rows = this.diff ?? [];
    return v_flex().flex_1().h_full().min_w(0).min_h(0)
      .child(h_flex().h(36).flex_none().px(6).gap(4).items_center().border_b(1).border_color(t.border)
        .child(this.btn("d-back", "back", L("Zurück", "Back"), () => { this.view = this.file ? "file" : "tree"; }, t))
        .child(div().flex_1().min_w(0).truncate().text_size(this.sz(12)).child(h_flex().gap(6).child(div().font_semibold().child(basename(rel))).child(div().text_color(t.ansi1).child(L("− lokal", "− local"))).child(div().text_color(t.ansi2).child("+ server"))))
        .child(this.btn("d-up", "upload", L("Lokale Version hochladen", "Upload local version"), (_e, cx) => this.upload(rel, false, cx), t, { label: L("Hochladen", "Upload"), color: t.ansi2 }))
        .child(this.btn("d-dn", "download", L("Server-Version übernehmen", "Take server version"), (_e, cx) => this.download(rel, false, cx), t, { label: L("Übernehmen", "Take"), color: t.ansi4 }))
        .child(this.btn("d-edit", "file", L("Lokal bearbeiten", "Edit locally"), (_e, cx) => this.openFile(rel, cx), t)))
      .child(this.diffError ? div().p(12).text_size(this.sz(12)).text_color(t.ansi1).child(this.diffError)
        : !this.diff ? div().p(12).text_size(this.sz(12)).text_color(t.dim).child(L("Hole Server-Version…", "Fetching server version…"))
        : div().flex_1().min_h(0).relative().font_family(this.retroOn() ? DOS_FONT : settings().font_family ?? "JetBrains Mono").text_size(this.retroOn() ? 16 : 11.5)
          .child(v_virtual_list("201commander-diff", rows.length, 20, (i) => String(i), (range) => rows.slice(range.start, range.end).map(({ kind, number, text }) =>
            kind === "@" ? div().w_full().px(10).h(20).flex_none().truncate().bg(t.raised).text_color(t.dim).child(text)
              : h_flex().w_full().h(20).flex_none().gap(10).when(kind === "+", (e) => e.bg(t.ansi2 + "1c")).when(kind === "-", (e) => e.bg(t.ansi1 + "1c"))
                .child(div().w(34).flex_none().text_right().text_color(t.dim).child(number === undefined ? "" : String(number)))
                .child(div().w(10).flex_none().text_color(kind === "+" ? t.ansi2 : kind === "-" ? t.ansi1 : t.dim).child(kind === " " ? "" : kind))
                .child(div().flex_1().min_w(0).truncate().child(text)))).size_full())
          .child(Scrollbar.vertical("201commander-diff").viewport_from_layout().absolute().inset_0()));
  }

  footer(t) {
    if (this.confirm) {
      const c = this.confirm;
      return h_flex().flex_none().px(10).py(7).gap(8).items_center().border_t(1).border_color(t.border).bg(t.raised).text_size(this.sz(12))
        .child(div().flex_1().min_w(0).child(c.text))
        .child(this.btn("cf-no", "x", L("Abbrechen", "Cancel"), () => { this.confirm = null; }, t, { label: L("Abbrechen", "Cancel") }))
        .child(this.btn("cf-yes", "upload", c.yes, () => { this.confirm = null; c.action(); }, t, { solid: true, label: c.yes }));
    }
    if (this.busy) return h_flex().flex_none().px(10).py(6).gap(8).items_center().border_t(1).border_color(t.border).text_size(this.sz(12)).text_color(t.muted)
      .child(div().text_color(t.working).frames(["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"], 90)).child(div().flex_1().min_w(0).truncate().child(this.busy));
    if (this.note) return h_flex().id("201commander-note").flex_none().px(10).py(6).gap(8).items_center().border_t(1).border_color(t.border).text_size(this.sz(12))
      .text_color(this.note.level === "error" ? t.ansi1 : t.muted).cursor_pointer().on_click((_e, cx) => { this.note = null; cx.notify(); })
      .child(div().flex_1().min_w(0).truncate().child(this.note.text)).child(div().text_color(t.dim).child("×"));
    return null;
  }

  render(cx) {
    const forced = shared(LANG_KEY);
    UI_DE = forced === "de" || forced === "en" ? forced === "de" : Boolean(this.autoDe);
    this.resolveRoots(cx);
    if (this.key() !== this.ctx?.key && !checking()) this.refresh(cx);
    const retro = this.retroOn(), t = this.pal(), overlay = props()?.overlay, wide = this.width >= 760;
    if (this.editor && this.file && this.editorRetro !== retro && !this.rebuilding) {
      this.rebuilding = true;
      // EditorState.new can't run while rendering: wait for the next tick.
      cx.spawn(async (cx) => { await cx.sleep(1); this.rebuilding = false; if (this.editor && this.file && this.editorRetro !== this.retroOn()) this.makeEditor(null, this.file, true); cx.notify(); });
    }
    let content = null;
    try { content = this.view === "diff" && this.diffFile ? this.diffView(t, !wide) : this.view === "file" && this.file ? this.fileView(t, !wide) : null; }
    catch (e) { content = div().p(12).text_size(this.sz(12)).text_color(t.ansi1).child(L(`Fehler: ${e?.message ?? e}`, `Error: ${e?.message ?? e}`)); }
    const footer = this.footer(t);
    return v_flex().id("201commander").size_full().min_h(0).overflow_hidden().bg(t.background).text_color(t.foreground).text_size(this.sz(13))
      .when(!overlay, (e) => e.rounded(10).border_1().border_color(t.border))
      .track_focus(this.handle)
      .on_size_change((size, cx) => {
        if (Math.abs(size.width - this.width) <= 1) return;
        this.width = size.width;
        if (this.editor && this.file && (this.width < 760) !== this.wrap) this.makeEditor(null, this.file, true);
        cx.notify();
      })
      .on_key_down((e, cx) => {
        if (e.keystroke === "cmd-s" && this.view === "file") { this.save(cx); cx.stop_propagation(); }
        else if (e.key === "escape" && this.confirm) { this.confirm = null; cx.notify(); cx.stop_propagation(); }
      })
      .when(retro, (e) => e.font_family(DOS_FONT).text_size(16).rounded(0).border_color(DOS.border))
      .child(retro ? this.dosMenu(overlay) : this.header(t, overlay))
      .when(Boolean(this.sshOpen) && !this.on, (e) => e.child(this.sshBar(t)))
      .child(retro ? this.dosBody(t, content, wide) : h_flex().flex_1().min_h(0).items_start().on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .when(wide || !content, (e) => e.child(v_flex().h_full().min_h(0).when(wide && content, (x) => x.w(Math.min(360, Math.max(240, this.width * 0.32))).flex_none().border_r(1).border_color(t.border)).when(!(wide && content), (x) => x.flex_1().min_w(0)).child(this.tree(t))))
        .when(Boolean(content), (e) => e.child(content)))
      .when(Boolean(footer), (e) => e.child(footer))
      .when(retro, (e) => e.child(this.dosPrompt()).child(this.dosKeys()));
  }

  dosBody(t, content, wide) {
    const contentTitle = this.view === "diff" ? `Diff ${basename(this.diffFile ?? "")}` : basename(this.file ?? "");
    const treeFrame = (grow) => this.dosFrame("dos-left", tilde(this.root) || "C:\\", !content, this.tree(t)).when(grow, (e) => e.flex_1());
    return h_flex().flex_1().min_h(0).items_start().on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .when(wide && Boolean(content), (e) => e.child(treeFrame(false).w(Math.max(280, this.width * 0.36)).flex_none()))
      .when(!content, (e) => e.child(treeFrame(true)))
      .when(Boolean(content), (e) => e.child(this.dosFrame("dos-right", contentTitle, true, content).flex_1()));
  }
}
