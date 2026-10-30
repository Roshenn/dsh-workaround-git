/**
 * dsh-workaround-git — browser half.
 *
 * Registers one left-sidebar entry plus its main-area page, following the same
 * ModuleLoader contract as the other client plugins in this profile:
 * `window.__ModuleLoader__.load({ id, factory })`, exports `{ name, inject, apply }`.
 *
 * Layout: one vertical card per repository in a single horizontal strip (4
 * visible by default, extra cards scroll sideways). The card follows VS Code's
 * source-control layout: commit box on top, then the staged / changes sections,
 * with hover actions and a context menu per file.
 */
window.__ModuleLoader__.load({
  id: 'dsh-workaround-git',
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;

    const React = require('react');
    const h = React.createElement;

    const API = '/workaround-git/api';
    const PANEL_ID = 'workaround-git';
    const PANEL_LABEL = '工作区 Git';
    const VIEW_KEY = 'wg-view';
    const MIN_COLUMN = 260;
    const GAP = 12;
    const MAX_COLUMNS = 4;

    const CSS = `
      .wg-root { box-sizing: border-box; position: relative; height: 100%; min-height: 0; display: flex; flex-direction: column;
        font: 13px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
        color: var(--wg-fg); background: var(--wg-bg); }
      .wg-root *, .wg-root *::before, .wg-root *::after { box-sizing: border-box; }
      .wg-head { flex: 0 0 auto; display: flex; align-items: center; flex-wrap: wrap; gap: 10px; padding: 12px 20px;
        border-bottom: 1px solid var(--wg-line); }
      .wg-title { font-size: 15px; font-weight: 600; margin: 0; }
      .wg-muted { color: var(--wg-muted); }
      .wg-grow { flex: 1 1 auto; }
      .wg-body { flex: 1 1 auto; min-height: 0; overflow: auto; padding: 16px 20px 40px;
        display: flex; flex-direction: column; }
      .wg-panel { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; }
      .wg-strip-wrap { position: relative; flex: 1 1 auto; min-height: 0; }
      .wg-strip { height: 100%; overflow-x: auto; overflow-y: hidden; padding-bottom: 10px; scrollbar-width: thin; }
      .wg-strip:focus-visible { outline: 2px solid var(--wg-accent); outline-offset: 2px; }
      .wg-strip-list { max-width: 920px; }
      .wg-grid { display: grid; grid-auto-flow: column; align-items: stretch; gap: ${GAP}px; height: 100%;
        grid-auto-columns: calc((100% - (var(--wg-cols, 4) - 1) * ${GAP}px) / var(--wg-cols, 4)); }
      .wg-scroll { position: absolute; top: 50%; transform: translateY(-50%); z-index: 2; width: 26px; height: 54px;
        display: flex; align-items: center; justify-content: center; border-radius: 8px;
        border: 1px solid var(--wg-line); background: var(--wg-card); color: var(--wg-fg); font-size: 18px;
        line-height: 1; cursor: pointer; box-shadow: 0 2px 10px rgba(0, 0, 0, .14); }
      .wg-scroll:hover { border-color: var(--wg-accent); }
      .wg-scroll:focus-visible { outline: 2px solid var(--wg-accent); outline-offset: 1px; }
      .wg-scroll-left { left: 6px; }
      .wg-scroll-right { right: 6px; }
      .wg-btn { height: 28px; padding: 0 12px; border-radius: 7px; border: 1px solid var(--wg-line);
        background: var(--wg-card); color: var(--wg-fg); font-size: 12px; cursor: pointer; white-space: nowrap; }
      .wg-btn:hover:not(:disabled) { border-color: var(--wg-accent); }
      .wg-btn:disabled { opacity: .45; cursor: default; }
      .wg-btn:focus-visible { outline: 2px solid var(--wg-accent); outline-offset: 1px; }
      .wg-btn-primary { background: var(--wg-accent); border-color: var(--wg-accent); color: #fff; }
      .wg-seg { display: inline-flex; border: 1px solid var(--wg-line); border-radius: 7px; overflow: hidden; }
      .wg-seg button { height: 26px; padding: 0 10px; border: 0; background: transparent; color: var(--wg-muted);
        font-size: 12px; cursor: pointer; }
      .wg-seg button[aria-pressed="true"] { background: var(--wg-accent); color: #fff; }
      .wg-seg button:focus-visible { outline: 2px solid var(--wg-accent); outline-offset: -2px; }
      .wg-listcard { border: 1px solid var(--wg-line); border-radius: 10px; background: var(--wg-card); }
      .wg-card { display: flex; flex-direction: column; min-width: 0; height: 100%; padding: 12px;
        border: 1px solid var(--wg-line); border-radius: 10px; background: var(--wg-card); }
      .wg-card:hover { border-color: color-mix(in srgb, var(--wg-accent) 45%, var(--wg-line)); }
      .wg-row { display: flex; align-items: flex-start; gap: 12px; padding: 12px 14px; }
      .wg-ws-row { border-top: 1px solid var(--wg-line); }
      .wg-ws-row:first-child { border-top: 0; }
      .wg-path { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 11.5px; color: var(--wg-muted);
        word-break: break-all; }
      .wg-badge { display: inline-flex; align-items: center; gap: 5px; height: 20px; padding: 0 8px; border-radius: 999px;
        border: 1px solid var(--wg-line); font-size: 11px; color: var(--wg-muted); white-space: nowrap; }
      .wg-badge-ok { color: var(--wg-ok); border-color: color-mix(in srgb, var(--wg-ok) 40%, transparent); }
      .wg-badge-warn { color: var(--wg-warn); border-color: color-mix(in srgb, var(--wg-warn) 40%, transparent); }
      .wg-chip { display: inline-flex; align-items: center; gap: 4px; flex: 0 0 auto; font-size: 11.5px; color: var(--wg-muted);
        white-space: nowrap; }
      .wg-chip-warn { color: var(--wg-warn); }
      .wg-behind { display: inline-flex; align-items: center; flex: 0 0 auto; height: 18px; padding: 0 7px;
        border-radius: 999px; font-size: 10.5px; white-space: nowrap; color: var(--wg-warn);
        background: color-mix(in srgb, var(--wg-warn) 15%, transparent);
        border: 1px solid color-mix(in srgb, var(--wg-warn) 45%, transparent); }
      .wg-col-head { display: flex; flex-direction: column; }
      .wg-col-line1 { display: flex; align-items: center; gap: 8px; min-width: 0; height: 22px; overflow: hidden; }
      .wg-repo-name { font-weight: 600; font-size: 13px; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .wg-col-line { display: flex; align-items: center; gap: 8px; min-width: 0; height: 18px; overflow: hidden;
        font-size: 11.5px; color: var(--wg-muted); }
      .wg-remote { display: flex; align-items: center; gap: 6px; height: 16px; min-width: 0; overflow: hidden;
        color: var(--wg-muted); font-size: 10.5px; opacity: .9;
        font-family: ui-monospace, SFMono-Regular, Consolas, monospace; }
      .wg-remote-label { flex: 0 0 auto; opacity: .75; }
      .wg-remote-track { flex: 1 1 auto; min-width: 0; overflow: hidden; position: relative; }
      .wg-remote-track::after { content: ''; position: absolute; top: 0; right: 0; bottom: 0; width: 16px;
        background: linear-gradient(to right, transparent, var(--wg-card)); pointer-events: none; }
      .wg-remote-text { display: inline-block; white-space: nowrap; will-change: transform; }
      @keyframes wg-marquee { from { transform: translateX(0); } to { transform: translateX(var(--wg-shift, 0px)); } }
      .wg-ws-tag, .wg-commit { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .wg-branch-btn { display: inline-flex; align-items: center; gap: 3px; height: 20px; max-width: 130px; padding: 0 7px;
        border-radius: 999px; border: 1px solid var(--wg-line); background: transparent; color: var(--wg-muted);
        font-size: 11px; cursor: pointer; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .wg-branch-btn:hover { border-color: var(--wg-accent); color: var(--wg-fg); }
      .wg-commit-box { position: relative; margin-top: 8px; }
      .wg-msg { width: 100%; height: 64px; resize: none; padding: 7px 32px 7px 9px; border-radius: 8px;
        border: 1px solid var(--wg-line); background: var(--wg-bg); color: var(--wg-fg);
        font: 12px/1.45 ui-monospace, SFMono-Regular, Consolas, monospace; }
      .wg-msg:focus-visible { outline: 2px solid var(--wg-accent); outline-offset: -1px; }
      .wg-sparkle { position: absolute; top: 6px; right: 6px; width: 22px; height: 22px; padding: 0; border: 0;
        border-radius: 6px; background: transparent; color: var(--wg-accent); font-size: 14px; cursor: pointer; }
      .wg-sparkle:hover:not(:disabled) { background: color-mix(in srgb, var(--wg-accent) 14%, transparent); }
      .wg-sparkle:disabled { opacity: .45; cursor: default; }
      .wg-commit-row { display: flex; gap: 6px; margin-top: 6px; }
      .wg-commit-main { flex: 1 1 auto; height: 28px; border-radius: 7px 0 0 7px; }
      .wg-commit-caret { flex: 0 0 28px; height: 28px; padding: 0; border-radius: 0 7px 7px 0;
        border: 1px solid var(--wg-accent); border-left: 0; background: var(--wg-accent); color: #fff; cursor: pointer; }
      .wg-commit-row .wg-btn-primary { border-radius: 7px; }
      .wg-files { margin: 8px 0 0; padding: 0; list-style: none; flex: 1 1 auto; min-height: 140px; overflow: auto;
        border-top: 1px dashed var(--wg-line); }
      .wg-files-empty { display: flex; align-items: center; justify-content: center; flex: 1 1 auto; min-height: 140px;
        margin-top: 8px; border-top: 1px dashed var(--wg-line); color: var(--wg-muted); font-size: 11.5px; }
      .wg-sec-head { display: flex; align-items: center; gap: 6px; height: 24px; padding: 0 2px; cursor: pointer;
        color: var(--wg-muted); font-size: 11.5px; user-select: none; border-radius: 5px; }
      .wg-sec-head:hover { color: var(--wg-fg); }
      .wg-sec-head:focus-visible { outline: 2px solid var(--wg-accent); outline-offset: -2px; }
      .wg-sec-caret { width: 10px; text-align: center; }
      .wg-sec-actions { margin-left: auto; display: flex; gap: 2px; opacity: 0; }
      .wg-sec-head:hover .wg-sec-actions, .wg-sec-head:focus-within .wg-sec-actions { opacity: 1; }
      .wg-file { display: flex; align-items: center; gap: 6px; height: 22px; padding: 0 2px; border-radius: 5px;
        cursor: default; font-size: 11.5px; min-width: 0; }
      .wg-file:hover, .wg-file:focus-within { background: color-mix(in srgb, var(--wg-accent) 10%, transparent); }
      .wg-file:focus-visible { outline: 2px solid var(--wg-accent); outline-offset: -2px; }
      .wg-file-status { flex: 0 0 12px; text-align: center; color: var(--wg-accent); font-family: ui-monospace, Consolas, monospace; }
      .wg-file-status-conflict { color: var(--wg-danger); }
      .wg-file-name { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        font-family: ui-monospace, SFMono-Regular, Consolas, monospace; }
      .wg-file-dir { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        color: var(--wg-muted); font-size: 11px; }
      .wg-file-stat { flex: 0 0 auto; color: var(--wg-muted); font-size: 10.5px; white-space: nowrap; }
      .wg-file-actions { flex: 0 0 auto; display: none; gap: 1px; }
      .wg-file:hover .wg-file-actions, .wg-file:focus-within .wg-file-actions { display: flex; }
      .wg-icon-btn { width: 20px; height: 20px; padding: 0; border: 0; border-radius: 4px; background: transparent;
        color: var(--wg-muted); cursor: pointer; display: flex; align-items: center; justify-content: center;
        font-size: 13px; line-height: 1; }
      .wg-icon-btn:hover { background: color-mix(in srgb, var(--wg-fg) 12%, transparent); color: var(--wg-fg); }
      .wg-icon-btn:focus-visible { outline: 2px solid var(--wg-accent); }
      .wg-icon-btn:disabled { opacity: .45; cursor: default; }
      .wg-repo-action { flex: 0 0 auto; width: 22px; height: 20px; font-size: 14px; }
      .wg-icon-btn-warn { color: var(--wg-warn); }
      .wg-icon-btn-accent { color: var(--wg-accent); }
      .wg-batch-note { flex: 0 0 auto; padding: 6px 20px; font-size: 12px; color: var(--wg-muted);
        border-bottom: 1px solid var(--wg-line); background: color-mix(in srgb, var(--wg-accent) 5%, transparent);
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .wg-status { height: 18px; margin-top: 6px; font-size: 11.5px; line-height: 18px; overflow: hidden;
        text-overflow: ellipsis; white-space: nowrap; }
      .wg-status-error { color: var(--wg-danger); }
      .wg-status-ok { color: var(--wg-ok); }
      .wg-error { margin-top: 8px; font-size: 12px; color: var(--wg-danger); }
      .wg-empty { padding: 40px 0; text-align: center; color: var(--wg-muted); }
      .wg-section-hint { margin: 0 0 10px; color: var(--wg-muted); font-size: 12px; }
      .wg-menu { position: fixed; z-index: 60; min-width: 200px; max-width: 320px; padding: 4px; border-radius: 8px;
        border: 1px solid var(--wg-line); background: var(--wg-card); box-shadow: 0 8px 24px rgba(0, 0, 0, .22); }
      .wg-menu-item { display: flex; align-items: center; gap: 8px; height: 26px; padding: 0 9px; border-radius: 5px;
        font-size: 12px; color: var(--wg-fg); cursor: pointer; white-space: nowrap; }
      .wg-menu-item:hover, .wg-menu-item:focus-visible { background: color-mix(in srgb, var(--wg-accent) 16%, transparent); outline: none; }
      .wg-menu-item[aria-disabled="true"] { opacity: .45; pointer-events: none; }
      .wg-menu-danger { color: var(--wg-danger); }
      .wg-menu-sep { height: 1px; margin: 4px 2px; background: var(--wg-line); }
      .wg-overlay { position: fixed; inset: 0; z-index: 40; display: flex; align-items: center; justify-content: center;
        background: rgba(0, 0, 0, .35); }
      .wg-dialog { width: min(460px, 84%); padding: 16px; border-radius: 10px; border: 1px solid var(--wg-line);
        background: var(--wg-card); box-shadow: 0 12px 32px rgba(0, 0, 0, .3); }
      .wg-dialog-title { font-size: 13px; font-weight: 600; margin: 0 0 8px; }
      .wg-dialog-body { font-size: 12px; color: var(--wg-muted); margin-bottom: 12px; max-height: 220px; overflow: auto; }
      .wg-dialog-actions { display: flex; justify-content: flex-end; gap: 8px; }
      .wg-dialog-danger { background: var(--wg-danger); border-color: var(--wg-danger); color: #fff; }
      .wg-drawer-mask { position: fixed; inset: 0; z-index: 30; background: rgba(0, 0, 0, .25); }
      .wg-drawer { position: fixed; top: 0; right: 0; bottom: 0; z-index: 31; width: min(720px, 64%);
        display: flex; flex-direction: column; border-left: 1px solid var(--wg-line); background: var(--wg-bg);
        box-shadow: -8px 0 24px rgba(0, 0, 0, .18); }
      .wg-drawer-head { flex: 0 0 auto; display: flex; align-items: center; gap: 10px; padding: 12px 14px;
        border-bottom: 1px solid var(--wg-line); }
      .wg-drawer-title { font-size: 12.5px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .wg-drawer-body { flex: 1 1 auto; min-height: 0; overflow: auto; }
      .wg-diff { font: 11.5px/1.5 ui-monospace, SFMono-Regular, Consolas, monospace; }
      .wg-diff-line { display: flex; align-items: flex-start; white-space: pre; }
      .wg-diff-no { flex: 0 0 44px; padding-right: 8px; text-align: right; color: var(--wg-muted); user-select: none;
        border-right: 1px solid var(--wg-line); }
      .wg-diff-text { flex: 1 1 auto; padding-left: 8px; white-space: pre-wrap; word-break: break-all; }
      .wg-diff-add { background: color-mix(in srgb, var(--wg-ok) 16%, transparent); }
      .wg-diff-del { background: color-mix(in srgb, var(--wg-danger) 16%, transparent); }
      .wg-diff-hunk { color: var(--wg-accent); }
      .wg-diff-meta { color: var(--wg-muted); }
      .wg-history { padding: 4px 0; }
      .wg-history-item { padding: 8px 14px; border-top: 1px solid var(--wg-line); }
      .wg-history-item:first-child { border-top: 0; }
      .wg-history-subject { font-size: 12.5px; }
      .wg-history-meta { font-size: 11px; color: var(--wg-muted); margin-top: 2px; }
      :root { --wg-bg: #ffffff; --wg-card: #ffffff; --wg-fg: #1f2328; --wg-muted: #6b7280; --wg-line: #e5e7eb;
        --wg-accent: #3b82f6; --wg-ok: #15803d; --wg-warn: #b45309; --wg-danger: #b91c1c; }
      [data-theme="dark"] { --wg-bg: #17181a; --wg-card: #1e1f22; --wg-fg: #e6e7e9; --wg-muted: #9aa0a6;
        --wg-line: #2c2e33; --wg-accent: #5b9cff; --wg-ok: #4ade80; --wg-warn: #fbbf24; --wg-danger: #f87171; }
      @media (prefers-color-scheme: dark) {
        :root:not([data-theme="light"]) { --wg-bg: #17181a; --wg-card: #1e1f22; --wg-fg: #e6e7e9; --wg-muted: #9aa0a6;
          --wg-line: #2c2e33; --wg-accent: #5b9cff; --wg-ok: #4ade80; --wg-warn: #fbbf24; --wg-danger: #f87171; }
      }
      @media (prefers-reduced-motion: reduce) { .wg-card, .wg-btn { transition: none; } }
    `;

    let styleInjected = false;
    function injectStyle() {
      if (styleInjected) return;
      styleInjected = true;
      try {
        const tag = document.createElement('style');
        tag.dataset.plugin = 'dsh-workaround-git';
        tag.textContent = CSS;
        document.head.appendChild(tag);
      } catch {
        styleInjected = false;
      }
    }

    async function call(path, init) {
      const response = await fetch(API + path, {
        cache: 'no-store',
        headers: { 'content-type': 'application/json' },
        ...init,
      });
      const text = await response.text();
      let payload;
      try {
        payload = JSON.parse(text);
      } catch {
        const hint = response.status === 404
          ? '面板 API 未挂载：host 半没有注册 /workaround-git 路由（重启 dsh 后再试）'
          : `HTTP ${response.status}: 响应不是 JSON`;
        throw new Error(hint);
      }
      if (!payload || payload.ok !== true) {
        const detail = payload && payload.error ? payload.error.message : `HTTP ${response.status}`;
        const error = new Error(detail || 'request failed');
        error.code = payload && payload.error ? payload.error.code : 'http-error';
        throw error;
      }
      return payload.data;
    }

    function postInit(body) {
      return { method: 'POST', body: JSON.stringify(body) };
    }

    function readView() {
      try {
        const stored = localStorage.getItem(VIEW_KEY);
        if (stored === 'grid' || stored === 'list') return stored;
      } catch { /* noop */ }
      return 'grid';
    }

    function storeView(view) {
      try { localStorage.setItem(VIEW_KEY, view); } catch { /* noop */ }
    }

    async function copyText(text) {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch {
        try {
          const area = document.createElement('textarea');
          area.value = text;
          area.style.position = 'fixed';
          area.style.opacity = '0';
          document.body.appendChild(area);
          area.select();
          const ok = document.execCommand('copy');
          document.body.removeChild(area);
          return ok;
        } catch {
          return false;
        }
      }
    }

    /**
     * Column count for the card strip: 4 on a wide body, fewer as it narrows.
     * Measured on the strip (not the viewport) so the sidebar width is excluded.
     */
    function useElementColumns(ref, view, phase) {
      const [columns, setColumns] = React.useState(MAX_COLUMNS);
      React.useEffect(() => {
        const element = ref.current;
        if (!element || typeof ResizeObserver === 'undefined') return undefined;
        const measure = () => {
          const width = element.clientWidth;
          const next = Math.max(1, Math.min(MAX_COLUMNS, Math.floor((width + GAP) / (MIN_COLUMN + GAP))));
          setColumns((previous) => (previous === next ? previous : next));
        };
        measure();
        const observer = new ResizeObserver(measure);
        observer.observe(element);
        return () => observer.disconnect();
      }, [ref, view, phase]);
      return columns;
    }

    function icon() {
      return h('svg', {
        width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true', style: { flex: '0 0 auto' },
      },
        h('circle', { cx: 4, cy: 3.2, r: 1.8, stroke: 'currentColor', strokeWidth: 1.4 }),
        h('circle', { cx: 4, cy: 12.8, r: 1.8, stroke: 'currentColor', strokeWidth: 1.4 }),
        h('circle', { cx: 12, cy: 6.4, r: 1.8, stroke: 'currentColor', strokeWidth: 1.4 }),
        h('path', { d: 'M4 5v6M4 4.9c0 3 8 0 8 1.5', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round' }));
    }

    function Badge({ tone, children }) {
      return h('span', { className: `wg-badge${tone ? ` wg-badge-${tone}` : ''}` }, children);
    }

    const GIT_LABEL = { git: 'Git 仓库', contains: '含子仓库', none: '无 Git' };

    function displayStatus(file) {
      if (file.conflicted) return '!';
      if (file.untracked) return 'U';
      if (file.index && file.index !== '.' && file.index !== '?') return file.index;
      return file.worktree && file.worktree !== '.' ? file.worktree : 'M';
    }

    function splitPath(value) {
      const slash = value.lastIndexOf('/');
      return slash === -1 ? { dir: '', name: value } : { dir: value.slice(0, slash + 1), name: value.slice(slash + 1) };
    }

    /**
     * One fixed-height line with the origin remote URL. Long URLs scroll
     * horizontally only while hovered; the row never grows because the
     * marquee moves the text, not the layout.
     */
    function RemoteLine({ remote }) {
      const textRef = React.useRef(null);
      const [shift, setShift] = React.useState(null);
      const label = remote?.name || 'origin';
      const url = remote?.url || '';
      const enter = () => {
        const element = textRef.current;
        if (!element) return;
        const track = element.parentElement;
        const distance = element.scrollWidth - (track ? track.clientWidth : 0);
        if (distance > 2) setShift(distance);
      };
      const leave = () => setShift(null);
      return h('div', { className: 'wg-remote', title: url ? `${label} ${url}` : undefined },
        url ? h('span', { className: 'wg-remote-label' }, label) : null,
        h('span', { className: 'wg-remote-track', onMouseEnter: enter, onMouseLeave: leave },
          h('span', {
            ref: textRef,
            className: 'wg-remote-text',
            style: shift === null ? undefined : { '--wg-shift': `-${shift}px`, animation: 'wg-marquee 5s ease-in-out infinite alternate' },
          }, url)));
    }

    function Menu({ menu, onClose }) {
      const ref = React.useRef(null);
      const [position, setPosition] = React.useState({ left: menu.x, top: menu.y });
      React.useEffect(() => {
        const element = ref.current;
        if (!element) return;
        const rect = element.getBoundingClientRect();
        const left = Math.max(8, Math.min(menu.x, (window.innerWidth || 1200) - rect.width - 8));
        const top = Math.max(8, Math.min(menu.y, (window.innerHeight || 800) - rect.height - 8));
        setPosition({ left, top });
      }, [menu]);
      React.useEffect(() => {
        const onKey = (event) => { if (event.key === 'Escape') onClose(); };
        const onDown = (event) => {
          if (ref.current && !ref.current.contains(event.target)) onClose();
        };
        window.addEventListener('keydown', onKey);
        window.addEventListener('mousedown', onDown, true);
        window.addEventListener('scroll', onClose, true);
        return () => {
          window.removeEventListener('keydown', onKey);
          window.removeEventListener('mousedown', onDown, true);
          window.removeEventListener('scroll', onClose, true);
        };
      }, [onClose]);
      return h('div', { ref, className: 'wg-menu', role: 'menu', style: { left: position.left, top: position.top } },
        menu.items.map((item, index) => (item.sep
          ? h('div', { key: `sep-${index}`, className: 'wg-menu-sep' })
          : h('div', {
            key: item.label,
            role: 'menuitem',
            tabIndex: 0,
            className: `wg-menu-item${item.danger ? ' wg-menu-danger' : ''}`,
            'aria-disabled': item.disabled ? 'true' : undefined,
            onClick: () => { onClose(); item.onClick?.(); },
            onKeyDown: (event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                onClose();
                item.onClick?.();
              }
            },
          }, item.label))));
    }

    function ConfirmDialog({ dialog, onClose }) {
      return h('div', { className: 'wg-overlay', role: 'dialog', 'aria-modal': 'true', 'aria-label': dialog.title },
        h('div', { className: 'wg-dialog' },
          h('h3', { className: 'wg-dialog-title' }, dialog.title),
          h('div', { className: 'wg-dialog-body' }, dialog.body),
          h('div', { className: 'wg-dialog-actions' },
            h('button', { className: 'wg-btn', onClick: onClose }, '取消'),
            h('button', {
              className: `wg-btn${dialog.danger ? ' wg-dialog-danger' : ' wg-btn-primary'}`,
              onClick: () => { onClose(); dialog.onConfirm?.(); },
            }, dialog.confirmLabel || '确定'))));
    }

    function DiffView({ text }) {
      const lines = String(text ?? '').split('\n');
      let oldNo = 0;
      let newNo = 0;
      return h('div', { className: 'wg-diff' }, lines.map((line, index) => {
        let className = 'wg-diff-line';
        let oldLabel = '';
        let newLabel = '';
        if (line.startsWith('@@')) {
          className += ' wg-diff-hunk';
          const match = /@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
          if (match) {
            oldNo = Number(match[1]) - 1;
            newNo = Number(match[2]) - 1;
          }
        } else if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff --git')) {
          className += ' wg-diff-meta';
        } else if (line.startsWith('+')) {
          className += ' wg-diff-add';
          newNo += 1;
          newLabel = String(newNo);
        } else if (line.startsWith('-')) {
          className += ' wg-diff-del';
          oldNo += 1;
          oldLabel = String(oldNo);
        } else if (line.startsWith(' ')) {
          className += ' wg-diff-ctx';
          oldNo += 1;
          newNo += 1;
          oldLabel = String(oldNo);
          newLabel = String(newNo);
        }
        return h('div', { key: index, className },
          h('span', { className: 'wg-diff-no' }, oldLabel),
          h('span', { className: 'wg-diff-no' }, newLabel),
          h('span', { className: 'wg-diff-text' }, line));
      }));
    }

    function Drawer({ drawer, onClose }) {
      return h('div', null,
        h('div', { className: 'wg-drawer-mask', onClick: onClose }),
        h('div', { className: 'wg-drawer', role: 'dialog', 'aria-label': drawer.title },
          h('div', { className: 'wg-drawer-head' },
            h('span', { className: 'wg-drawer-title', title: drawer.title }, drawer.title),
            h('span', { className: 'wg-grow' }),
            h('button', { className: 'wg-btn', onClick: onClose }, '关闭')),
          h('div', { className: 'wg-drawer-body' },
            drawer.loading ? h('div', { className: 'wg-empty' }, '读取中…')
              : drawer.error ? h('div', { className: 'wg-empty wg-status-error' }, drawer.error)
                : drawer.kind === 'diff'
                  ? (drawer.text ? h(DiffView, { text: drawer.text }) : h('div', { className: 'wg-empty' }, '没有可显示的差异'))
                  : (drawer.commits.length > 0
                    ? h('div', { className: 'wg-history' }, drawer.commits.map((commit) => h('div', { key: commit.hash, className: 'wg-history-item' },
                      h('div', { className: 'wg-history-subject' }, commit.subject || '(no subject)'),
                      h('div', { className: 'wg-history-meta' }, `${commit.short} · ${commit.author} · ${commit.when}`))))
                    : h('div', { className: 'wg-empty' }, '这个文件还没有提交历史')))));
    }

    function WorkspacePicker({ workspaces, managed, onSave, busy }) {
      const managedPaths = new Set(managed.map((entry) => entry.path));
      const [selected, setSelected] = React.useState(() => new Set(managedPaths));
      React.useEffect(() => {
        setSelected(new Set(managed.map((entry) => entry.path)));
      }, [managed]);

      const eligible = workspaces.filter((workspace) => workspace.exists && workspace.git !== 'none');
      const toggle = (workspace) => {
        setSelected((previous) => {
          const next = new Set(previous);
          if (next.has(workspace.path)) next.delete(workspace.path);
          else next.add(workspace.path);
          return next;
        });
      };
      const picked = workspaces.filter((workspace) => selected.has(workspace.path));

      return h('div', null,
        h('p', { className: 'wg-section-hint' },
          '首次使用：勾选要纳入面板的工作区。只有包含 Git 仓库的工作区可以加入，选择会写进 ',
          h('code', null, '$DSH_HOME/workaround-git/managed.json'), '。'),
        h('div', { className: 'wg-listcard' }, workspaces.map((workspace) => {
          const disabled = !workspace.exists || workspace.git === 'none';
          const checked = selected.has(workspace.path);
          return h('div', { key: workspace.path || workspace.id, className: 'wg-row wg-ws-row', style: { alignItems: 'center' } },
            h('input', {
              type: 'checkbox',
              checked,
              disabled: disabled || busy,
              onChange: () => toggle(workspace),
              'aria-label': `管理 ${workspace.title || workspace.path}`,
              style: { width: 15, height: 15, marginTop: 2, flex: '0 0 auto' },
            }),
            h('div', { className: 'wg-grow', style: { minWidth: 0 } },
              h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
                h('span', { style: { fontWeight: 600 } }, workspace.title || workspace.path),
                !workspace.exists ? h(Badge, { tone: 'warn' }, '路径不存在')
                  : h(Badge, { tone: workspace.git === 'none' ? 'warn' : 'ok' },
                    workspace.git === 'none' ? GIT_LABEL.none
                      : workspace.git === 'git' ? GIT_LABEL.git
                        : `${GIT_LABEL.contains} ${workspace.repoCount}`),
                managedPaths.has(workspace.path) ? h(Badge, null, '已在管理中') : null),
              h('div', { className: 'wg-path' }, workspace.path)),
            !disabled && workspace.repoCount > 0
              ? h('span', { className: 'wg-chip' }, `${workspace.repoCount} 个仓库`)
              : null);
        })),
        h('div', { className: 'wg-actions', style: { marginTop: 14, display: 'flex', gap: 8 } },
          h('button', {
            className: 'wg-btn wg-btn-primary',
            disabled: busy || picked.length === 0,
            onClick: () => onSave(picked),
          }, busy ? '保存中…' : `加入管理（${picked.length}）`),
          h('button', {
            className: 'wg-btn',
            disabled: busy || eligible.length === 0,
            onClick: () => setSelected(new Set(eligible.map((workspace) => workspace.path))),
          }, '全选可用'),
          h('button', { className: 'wg-btn', disabled: busy, onClick: () => setSelected(new Set()) }, '清空')),
      );
    }

    /** One vertical repository card in VS Code's source-control layout. */
    function RepoColumn({ workspaceId, workspaceTitle, repo, seed, onChanged }) {
      const [message, setMessage] = React.useState('');
      const [busy, setBusy] = React.useState(null);
      const [error, setError] = React.useState(null);
      const [notice, setNotice] = React.useState(null);
      const [menu, setMenu] = React.useState(null);
      const [dialog, setDialog] = React.useState(null);
      const [drawer, setDrawer] = React.useState(null);
      const [collapsed, setCollapsed] = React.useState({ staged: false, changes: false, conflicts: false });

      // Batch "generate commit messages" hands each card a draft through `seed`.
      React.useEffect(() => {
        if (seed && typeof seed.text === 'string') {
          setMessage(seed.text);
          setNotice('已生成 AI 草稿');
        }
      }, [seed]);

      const groups = repo.groups || { staged: [], changes: [], conflicts: [] };
      const repoBody = { workspaceId, repo: repo.path };

      const run = async (action, task) => {
        setBusy(action);
        setError(null);
        setNotice(null);
        try {
          const result = await task();
          if (result) setNotice(result);
          await onChanged();
        } catch (caught) {
          setError(caught.message || String(caught));
        } finally {
          setBusy(null);
        }
      };

      const post = (path, body) => call(path, postInit(body));
      const repoPost = (path, body) => post(path, { ...repoBody, ...body });

      const stageFile = (file) => run('stage', async () => {
        await repoPost('/stage', { paths: [file.path] });
        return `已暂存 ${file.path}`;
      });
      const unstageFile = (file) => run('unstage', async () => {
        await repoPost('/unstage', { paths: [file.path] });
        return `已取消暂存 ${file.path}`;
      });
      const stageAll = () => run('stage-all', async () => {
        await repoPost('/stage', {});
        return '已暂存全部更改';
      });
      const unstageAll = () => run('unstage-all', async () => {
        await repoPost('/unstage', {});
        return '已取消全部暂存';
      });

      /** Down arrow: fetch + fast-forward only (never merges by hand). */
      const pullRepo = () => run('pull', async () => {
        const result = await repoPost('/sync', {});
        if (result.action === 'skipped') return `已跳过：${result.error || '工作区有未提交更改'}`;
        if (result.action === 'no-upstream') return '当前分支没有 upstream，只做了 fetch';
        if (result.action === 'up-to-date') return '已是最新';
        return `已拉取 ${result.branch || repo.branch || ''}`.trim();
      });

      /** Up arrow: push the current branch (sets upstream on first push). */
      const pushRepo = () => run('push', async () => {
        const result = await repoPost('/push', {});
        if (result.action === 'up-to-date') return '已是最新，无需推送';
        return `已推送 ${result.branch || repo.branch || ''}`.trim();
      });

      const confirmDiscard = (file) => setDialog({
        title: '删除更改',
        danger: true,
        confirmLabel: '删除',
        body: h('div', null,
          h('div', null, `将丢弃 ${file.path} 的未提交更改${file.untracked ? '（未跟踪文件会被删除，不可恢复）' : ''}。`),
          h('div', { className: 'wg-path', style: { marginTop: 6 } }, file.path)),
        onConfirm: () => run('discard', async () => {
          const result = await repoPost('/discard', { paths: [file.path] });
          if (result && result.ok === false) throw new Error('部分文件删除失败');
          return `已删除更改 ${file.path}`;
        }),
      });

      const ignoreFile = (file, mode) => run('ignore', async () => {
        const result = await repoPost('/ignore', { path: file.path, mode });
        return result.added ? `已写入 .gitignore：${result.pattern}` : `规则已存在：${result.pattern}`;
      });

      const openFile = (file, mode) => run('open', async () => {
        await repoPost('/open', { path: file.path, mode });
        return mode === 'reveal' ? '已在资源管理器中显示' : '已打开文件';
      });

      const copyPath = (file, relativePath) => run('copy', async () => {
        const absolute = `${repo.path}/${file.path}`.replace(/\/+/g, '/');
        const text = relativePath ? file.path : absolute;
        if (!(await copyText(text))) throw new Error('复制失败：剪贴板不可用');
        return relativePath ? '已复制相对路径' : '已复制绝对路径';
      });

      const showDiff = (file, staged) => {
        setDrawer({ kind: 'diff', title: `${staged ? '已暂存 · ' : ''}${file.path}`, loading: true, text: '', error: null });
        repoPost('/diff', { path: file.path, staged: staged === true })
          .then((result) => setDrawer({ kind: 'diff', title: result.path, loading: false, text: result.text, error: null }))
          .catch((caught) => setDrawer({ kind: 'diff', title: file.path, loading: false, text: '', error: caught.message }));
      };

      const showHistory = (file) => {
        setDrawer({ kind: 'history', title: `文件历史 · ${file.path}`, loading: true, commits: [], error: null });
        repoPost('/history', { path: file.path })
          .then((result) => setDrawer({ kind: 'history', title: `文件历史 · ${result.path}`, loading: false, commits: result.commits, error: null }))
          .catch((caught) => setDrawer({ kind: 'history', title: `文件历史 · ${file.path}`, loading: false, commits: [], error: caught.message }));
      };

      const stashFile = (file) => run('stash', async () => {
        await repoPost('/stash', { paths: [file.path] });
        return '已贮藏更改（git stash pop 可恢复）';
      });
      const stashAll = () => run('stash-all', async () => {
        await repoPost('/stash', {});
        return '已贮藏全部更改（git stash pop 可恢复）';
      });

      const commit = (pushAfter) => run(pushAfter ? 'commit-push' : 'commit', async () => {
        if (message.trim() === '') throw new Error('先写入或生成一条 commit message');
        const result = await repoPost('/commit', { message });
        if (result.action !== 'committed') throw new Error('没有暂存的更改可提交');
        setMessage('');
        if (!pushAfter) return `已提交 ${result.commit || ''}`.trim();
        try {
          await repoPost('/push', {});
          return `已提交并推送 ${result.commit || ''}`.trim();
        } catch (pushError) {
          throw new Error(`已提交 ${result.commit || ''}，推送失败：${pushError.message}`);
        }
      });

      const draft = () => run('suggest', async () => {
        if ((groups.staged || []).length === 0) await repoPost('/stage', {});
        const result = await repoPost('/suggest', {});
        setMessage(result.message);
        return `草稿来自 ${result.model}${result.truncated ? '（diff 已截断）' : ''}`;
      });

      const loadBranches = async (event) => {
        const rect = event.currentTarget.getBoundingClientRect();
        try {
          const result = await repoPost('/branches', {});
          setMenu({
            x: rect.left,
            y: rect.bottom + 4,
            items: result.branches.map((branch) => ({
              label: `${branch.current ? '✓ ' : ''}${branch.name}${branch.upstream ? `  → ${branch.upstream}` : ''}`,
              onClick: () => run('branch', async () => {
                await repoPost('/branch-switch', { branch: branch.name });
                return `已切换到 ${branch.name}`;
              }),
            })),
          });
        } catch (caught) {
          setError(caught.message || String(caught));
        }
      };

      const openFileMenu = (event, file, section) => {
        event.preventDefault();
        event.stopPropagation();
        const close = () => setMenu(null);
        const items = [
          { label: '打开文件', onClick: () => openFile(file, 'file') },
          { label: '在资源管理器中显示', onClick: () => openFile(file, 'reveal') },
          { sep: true },
          { label: '复制路径', onClick: () => copyPath(file, false) },
          { label: '复制相对路径', onClick: () => copyPath(file, true) },
          { sep: true },
        ];
        if (section === 'changes') {
          items.push({ label: '暂存', onClick: () => stageFile(file) });
          if (file.untracked) {
            items.push({
              label: '添加到 .gitignore ▸',
              onClick: () => setMenu({
                x: event.clientX,
                y: event.clientY,
                items: [
                  { label: '此文件', onClick: () => ignoreFile(file, 'file') },
                  { label: '此扩展名', onClick: () => ignoreFile(file, 'ext') },
                  { label: '此目录', onClick: () => ignoreFile(file, 'dir') },
                ],
              }),
            });
          }
          items.push({ label: '删除更改…', danger: true, onClick: () => confirmDiscard(file) });
        } else if (section === 'staged') {
          items.push({ label: '取消暂存', onClick: () => unstageFile(file) });
        }
        items.push({ sep: true }, { label: '查看 diff', onClick: () => showDiff(file, section === 'staged') });
        if (section !== 'conflict') items.push({ label: '文件历史', onClick: () => showHistory(file) });
        if (section === 'changes') items.push({ sep: true }, { label: '贮藏更改', onClick: () => stashFile(file) });
        setMenu({ x: event.clientX, y: event.clientY, items });
      };

      const openCardMenu = (event) => {
        event.preventDefault();
        setMenu({
          x: event.clientX,
          y: event.clientY,
          items: [
            { label: '全部暂存', onClick: () => stageAll() },
            { label: '全部取消暂存', onClick: () => unstageAll() },
            { label: '贮藏全部更改', onClick: () => stashAll() },
            { sep: true },
            { label: '获取远端更新', onClick: () => run('fetch', async () => {
              await repoPost('/fetch', {});
              return '已获取远端更新';
            }) },
            { label: '刷新', onClick: () => run('refresh', async () => { await onChanged(); return '已刷新'; }) },
            { label: '复制仓库路径', onClick: () => run('copy', async () => {
              if (!(await copyText(repo.path))) throw new Error('复制失败');
              return '已复制仓库路径';
            }) },
            { label: '在资源管理器中显示仓库', onClick: () => run('open', async () => {
              await repoPost('/open', { path: '.', mode: 'reveal' });
              return '已在资源管理器中显示';
            }) },
          ],
        });
      };

      const sections = [
        { key: 'staged', title: '暂存的更改', files: groups.staged || [], empty: '没有暂存的更改' },
        { key: 'changes', title: '更改', files: groups.changes || [], empty: '没有未提交的更改' },
        { key: 'conflicts', title: '合并冲突', files: groups.conflicts || [], empty: '' },
      ].filter((section) => section.files.length > 0 || section.key !== 'conflicts');

      const totalFiles = (groups.staged?.length ?? 0) + (groups.changes?.length ?? 0) + (groups.conflicts?.length ?? 0);
      const statusText = error || notice || '';
      const statusClass = error ? 'wg-status wg-status-error' : 'wg-status wg-status-ok';

      return h('article', { className: 'wg-card', 'data-repo': repo.path },
        h('div', { className: 'wg-col-head', onContextMenu: openCardMenu },
          h('div', { className: 'wg-col-line1' },
            h('span', { className: 'wg-repo-name', title: repo.repo }, repo.repo),
            h('span', { className: 'wg-grow' }),
            (repo.behind ?? 0) > 0
              ? h('span', { className: 'wg-behind', title: `远端有 ${repo.behind} 个新提交尚未拉取` }, `↓${repo.behind} 可更新`)
              : null,
            h('button', {
              type: 'button',
              className: `wg-icon-btn wg-repo-action${(repo.behind ?? 0) > 0 ? ' wg-icon-btn-warn' : ''}`,
              title: `拉取 ${repo.branch || ''}（fetch + 快进，不产生合并）`.trim(),
              'aria-label': `拉取 ${repo.repo}`,
              disabled: busy !== null,
              onClick: pullRepo,
            }, '↓'),
            h('button', {
              type: 'button',
              className: `wg-icon-btn wg-repo-action${(repo.ahead ?? 0) > 0 ? ' wg-icon-btn-accent' : ''}`,
              title: `推送 ${repo.branch || ''}`.trim(),
              'aria-label': `推送 ${repo.repo}`,
              disabled: busy !== null,
              onClick: pushRepo,
            }, '↑'),
            h('button', {
              type: 'button',
              className: 'wg-branch-btn',
              title: '切换分支',
              onClick: loadBranches,
              disabled: busy !== null,
            }, repo.branch || '(detached)')),
          h(RemoteLine, { remote: repo.remote }),
          h('div', { className: 'wg-col-line' },
            workspaceTitle && workspaceTitle !== repo.repo
              ? h('span', { className: 'wg-ws-tag', title: workspaceTitle }, workspaceTitle)
              : null,
            h('span', { className: 'wg-grow' }),
            h('span', { className: 'wg-chip', title: 'ahead / behind' }, `↑${repo.ahead ?? 0} ↓${repo.behind ?? 0}`),
            h('span', { className: 'wg-chip' }, `${totalFiles} 个文件`)),
          repo.lastCommit
            ? h('div', { className: 'wg-col-line' },
              h('span', { className: 'wg-commit', title: repo.lastCommit.subject }, `${repo.lastCommit.hash} ${repo.lastCommit.subject}`))
            : h('div', { className: 'wg-col-line' },
              h('span', { className: 'wg-commit' }, '—'))),

        h('div', { className: 'wg-commit-box' },
          h('textarea', {
            className: 'wg-msg',
            value: message,
            placeholder: '提交信息（Ctrl+Enter 提交）',
            'aria-label': `${repo.repo} 的 commit message`,
            onChange: (event) => setMessage(event.target.value),
            onKeyDown: (event) => {
              if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
                event.preventDefault();
                commit(false);
              }
            },
          }),
          h('button', {
            type: 'button',
            className: 'wg-sparkle',
            title: 'AI 生成提交信息',
            'aria-label': 'AI 生成提交信息',
            disabled: busy !== null,
            onClick: draft,
          }, '✦'),
          h('div', { className: 'wg-commit-row' },
            h('button', {
              type: 'button',
              className: 'wg-btn wg-btn-primary wg-commit-main',
              disabled: busy !== null || message.trim() === '',
              onClick: () => commit(false),
            }, busy === 'commit' ? '提交中…' : '✓ 提交'),
            h('button', {
              type: 'button',
              className: 'wg-commit-caret',
              title: '更多提交方式',
              'aria-label': '更多提交方式',
              disabled: busy !== null || message.trim() === '',
              onClick: (event) => {
                const rect = event.currentTarget.getBoundingClientRect();
                setMenu({
                  x: rect.right - 180,
                  y: rect.bottom + 4,
                  items: [
                    { label: '提交', onClick: () => commit(false) },
                    { label: '提交并推送', onClick: () => commit(true) },
                    { sep: true },
                    { label: '贮藏全部更改', onClick: () => stashAll() },
                  ],
                });
              },
            }, '▾'))),

        totalFiles === 0
          ? h('div', { className: 'wg-files-empty' }, '没有未提交的更改')
          : h('div', { className: 'wg-files', 'aria-label': '变更文件' }, sections.map((section) => h('div', { key: section.key },
            h('div', {
              className: 'wg-sec-head',
              role: 'button',
              tabIndex: 0,
              'aria-expanded': !collapsed[section.key],
              onClick: () => setCollapsed((previous) => ({ ...previous, [section.key]: !previous[section.key] })),
              onKeyDown: (event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  setCollapsed((previous) => ({ ...previous, [section.key]: !previous[section.key] }));
                }
              },
            },
            h('span', { className: 'wg-sec-caret' }, collapsed[section.key] ? '▸' : '▾'),
            h('span', null, `${section.title} (${section.files.length})`),
            h('span', { className: 'wg-sec-actions' },
              section.key === 'staged'
                ? h('button', {
                  className: 'wg-icon-btn', title: '全部取消暂存', 'aria-label': '全部取消暂存',
                  onClick: (event) => { event.stopPropagation(); unstageAll(); },
                }, '−')
                : null,
              section.key === 'changes'
                ? h('button', {
                  className: 'wg-icon-btn', title: '全部暂存', 'aria-label': '全部暂存',
                  onClick: (event) => { event.stopPropagation(); stageAll(); },
                }, '＋')
                : null)),
            collapsed[section.key] ? null : section.files.map((file) => {
              const parts = splitPath(file.path);
              const added = typeof file.added === 'number' && file.added > 0 ? `+${file.added}` : '';
              const removed = typeof file.removed === 'number' && file.removed > 0 ? `−${file.removed}` : '';
              const counts = [added, removed].filter(Boolean).join(' ');
              return h('div', {
                key: `${section.key}:${file.path}`,
                className: 'wg-file',
                tabIndex: 0,
                title: file.path,
                onClick: () => showDiff(file, section.key === 'staged'),
                onContextMenu: (event) => openFileMenu(event, file, section.key),
              },
              h('span', { className: `wg-file-status${file.conflicted ? ' wg-file-status-conflict' : ''}` }, displayStatus(file)),
              h('span', { className: 'wg-file-name', title: parts.name }, parts.name),
              h('span', { className: 'wg-file-dir', title: parts.dir }, parts.dir),
              h('span', { className: 'wg-file-stat' }, counts),
              h('span', { className: 'wg-file-actions' },
                section.key === 'staged'
                  ? h('button', {
                    className: 'wg-icon-btn', title: '取消暂存', 'aria-label': `取消暂存 ${file.path}`,
                    onClick: (event) => { event.stopPropagation(); unstageFile(file); },
                  }, '−')
                  : h('button', {
                    className: 'wg-icon-btn', title: '暂存', 'aria-label': `暂存 ${file.path}`,
                    onClick: (event) => { event.stopPropagation(); stageFile(file); },
                  }, '＋'),
                section.key === 'changes'
                  ? h('button', {
                    className: 'wg-icon-btn', title: '删除更改', 'aria-label': `删除更改 ${file.path}`,
                    onClick: (event) => { event.stopPropagation(); confirmDiscard(file); },
                  }, '↩')
                  : null));
            })))),
        h('div', { className: statusClass, role: error ? 'alert' : undefined, title: statusText }, statusText),
        menu ? h(Menu, { menu, onClose: () => setMenu(null) }) : null,
        dialog ? h(ConfirmDialog, { dialog, onClose: () => setDialog(null) }) : null,
        drawer ? h(Drawer, { drawer, onClose: () => setDrawer(null) }) : null);
    }

    /** One horizontal strip of repository cards; cards never wrap. */
    function RepoGrid({ data, view, columns, onRefresh, stripRef, drafts }) {
      const workspaces = data?.workspaces ?? [];
      const items = [];
      const failures = [];
      for (const workspace of workspaces) {
        if (workspace.error) failures.push(`${workspace.title || workspace.path}：${workspace.error}`);
        for (const repo of workspace.repos ?? []) {
          items.push({
            workspaceId: workspace.id || workspace.path,
            workspaceTitle: workspace.title || workspace.path,
            repo,
          });
        }
      }

      const [scroll, setScroll] = React.useState({ left: false, right: false });
      const effectiveColumns = view === 'list' ? 1 : Math.min(columns, Math.max(1, items.length));

      const measure = React.useCallback(() => {
        const element = stripRef.current;
        if (!element) return;
        const max = element.scrollWidth - element.clientWidth;
        const left = element.scrollLeft > 2;
        const right = max > 2 && element.scrollLeft < max - 2;
        setScroll((previous) => (previous.left === left && previous.right === right ? previous : { left, right }));
      }, [stripRef]);

      React.useEffect(() => { measure(); }, [measure, items.length, view, columns]);

      React.useEffect(() => {
        const element = stripRef.current;
        if (!element) return undefined;
        const onWheel = (event) => {
          if (element.scrollWidth <= element.clientWidth + 2) return;
          if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
          element.scrollLeft += event.deltaY;
          event.preventDefault();
        };
        element.addEventListener('wheel', onWheel, { passive: false });
        return () => element.removeEventListener('wheel', onWheel);
      }, [stripRef, items.length, view]);

      const scrollByCards = (direction) => {
        const element = stripRef.current;
        if (!element || element.scrollWidth <= element.clientWidth + 2) return;
        const perCard = element.clientWidth / Math.max(1, effectiveColumns) + GAP;
        element.scrollBy({ left: direction * perCard, behavior: 'smooth' });
      };

      if (items.length === 0) {
        return h('div', { className: 'wg-empty' },
          workspaces.length === 0
            ? '还没有托管的工作区。点右上角「管理工作区」开始。'
            : '托管的工作区下没有发现 Git 仓库。');
      }

      return h('div', { className: 'wg-panel' },
        failures.length > 0 ? h('div', { className: 'wg-error' }, failures.join('；')) : null,
        h('div', { className: 'wg-strip-wrap' },
          scroll.left
            ? h('button', {
              type: 'button', className: 'wg-scroll wg-scroll-left', 'aria-label': '向左滚动',
              onClick: () => scrollByCards(-1),
            }, '‹')
            : null,
          h('div', {
            ref: stripRef,
            className: `wg-strip${view === 'list' ? ' wg-strip-list' : ''}`,
            onScroll: measure,
            tabIndex: 0,
            role: 'region',
            'aria-label': '仓库卡片',
          },
          h('div', {
            className: 'wg-grid',
            style: { '--wg-cols': String(effectiveColumns) },
          }, items.map((item) => h(RepoColumn, {
            key: item.repo.path,
            workspaceId: item.workspaceId,
            workspaceTitle: item.workspaceTitle,
            repo: item.repo,
            seed: drafts?.[item.repo.path],
            onChanged: onRefresh,
          })))),
          scroll.right
            ? h('button', {
              type: 'button', className: 'wg-scroll wg-scroll-right', 'aria-label': '向右滚动',
              onClick: () => scrollByCards(1),
            }, '›')
            : null));
    }

    function Page() {
      const [phase, setPhase] = React.useState('loading');
      const [workspaces, setWorkspaces] = React.useState([]);
      const [managed, setManaged] = React.useState([]);
      const [data, setData] = React.useState(null);
      const [error, setError] = React.useState(null);
      const [saving, setSaving] = React.useState(false);
      const [loading, setLoading] = React.useState(false);
      const [fetching, setFetching] = React.useState(false);
      const [fetchError, setFetchError] = React.useState(null);
      const [batchBusy, setBatchBusy] = React.useState(null);
      const [batchNotice, setBatchNotice] = React.useState(null);
      const [drafts, setDrafts] = React.useState({});
      const fetchedRef = React.useRef(false);
      const [view, setView] = React.useState(readView);
      const stripRef = React.useRef(null);
      const columns = useElementColumns(stripRef, view, phase);

      const loadIndex = React.useCallback(async (refresh) => {
        setError(null);
        setLoading(true);
        try {
          const index = await call(`/workspaces${refresh ? '?refresh=1' : ''}`);
          setWorkspaces(index.workspaces || []);
          setManaged(index.managed || []);
          if ((index.managed || []).length === 0) {
            setPhase('picker');
          } else {
            setPhase('panel');
            setData(await call('/state'));
          }
        } catch (caught) {
          setError(caught.message || String(caught));
          setPhase('error');
        } finally {
          setLoading(false);
        }
      }, []);

      const refreshState = React.useCallback(async () => {
        try {
          setData(await call('/state'));
        } catch (caught) {
          setError(caught.message || String(caught));
        }
      }, []);

      /** Fetch every managed repo once so `ahead/behind` reflects the real remote. */
      const checkUpdates = React.useCallback(async () => {
        setFetching(true);
        setFetchError(null);
        try {
          const result = await call('/fetch', postInit({}));
          if (result.failed > 0) setFetchError(`${result.failed} 个仓库获取远端失败`);
          await refreshState();
        } catch (caught) {
          setFetchError(caught.message || String(caught));
        } finally {
          setFetching(false);
        }
      }, [refreshState]);

      /** Bulk pull / push / AI drafts across every managed repository. */
      const runBatch = async (action) => {
        setBatchBusy(action);
        setBatchNotice(null);
        try {
          const result = await call('/batch', postInit({ action }));
          if (action === 'suggest') {
            const next = {};
            for (const row of result.results || []) {
              if (row.ok && typeof row.message === 'string') next[row.repo] = { text: row.message, at: Date.now() };
            }
            setDrafts(next);
            const generated = Object.keys(next).length;
            setBatchNotice(`批量生成提交信息：${generated} 条草稿${result.failedCount ? `，${result.failedCount} 个失败` : ''}`);
          } else {
            const verb = action === 'pull' ? '拉取' : '推送';
            const parts = [`${result.okCount} 成功`];
            if (result.skippedCount > 0) parts.push(`${result.skippedCount} 跳过`);
            if (result.failedCount > 0) parts.push(`${result.failedCount} 失败`);
            setBatchNotice(`批量${verb}：${parts.join(' / ')}`);
          }
          await refreshState();
        } catch (caught) {
          setBatchNotice(`批量操作失败：${caught.message || String(caught)}`);
        } finally {
          setBatchBusy(null);
        }
      };

      React.useEffect(() => { loadIndex(false); }, [loadIndex]);

      React.useEffect(() => {
        if (phase !== 'panel' || data === null || fetchedRef.current) return;
        fetchedRef.current = true;
        void checkUpdates();
      }, [phase, data, checkUpdates]);

      const updateCount = React.useMemo(() => {
        const workspaces = data?.workspaces ?? [];
        return workspaces.reduce(
          (count, workspace) => count + (workspace.repos ?? []).filter((repo) => (repo.behind ?? 0) > 0).length,
          0,
        );
      }, [data]);

      const switchView = (next) => {
        setView(next);
        storeView(next);
      };

      const save = async (picked) => {
        setSaving(true);
        setError(null);
        try {
          const result = await call('/managed', postInit({
            workspaces: picked.map((workspace) => ({ id: workspace.id, path: workspace.path, title: workspace.title })),
          }));
          setManaged(result.managed.workspaces);
          fetchedRef.current = false;
          await loadIndex(true);
        } catch (caught) {
          setError(caught.message || String(caught));
        } finally {
          setSaving(false);
        }
      };

      let body;
      if (phase === 'loading') {
        body = h('div', { className: 'wg-empty' }, '读取工作区…');
      } else if (phase === 'error') {
        body = h('div', { className: 'wg-empty' },
          h('div', { style: { marginBottom: 6 } }, '面板 API 没有响应，左侧仍可进入，但数据读不到。'),
          h('div', { className: 'wg-path', style: { marginBottom: 12 } }, error || ''),
          h('button', { className: 'wg-btn', onClick: () => loadIndex(true) }, '重试'));
      } else if (phase === 'picker') {
        body = h(WorkspacePicker, { workspaces, managed, onSave: save, busy: saving });
      } else if (data === null) {
        body = h('div', { className: 'wg-empty' }, '读取变更…');
      } else {
        body = h(RepoGrid, { data, view, columns, onRefresh: refreshState, stripRef, drafts });
      }

      return h('div', { className: 'wg-root', 'data-view': view },
        h('header', { className: 'wg-head' },
          h('h1', { className: 'wg-title' }, '工作区 Git'),
          h('span', { className: 'wg-grow' }),
          phase === 'panel' && fetching
            ? h('span', { className: 'wg-chip' }, '检查远端更新…')
            : null,
          phase === 'panel' && !fetching && updateCount > 0
            ? h('span', { className: 'wg-chip wg-chip-warn', title: '远端有尚未拉取的提交' }, `${updateCount} 个仓库可更新`)
            : null,
          phase === 'panel' && !fetching && fetchError
            ? h('span', { className: 'wg-chip wg-chip-warn', title: fetchError }, '远端检查失败')
            : null,
          phase === 'panel'
            ? h('div', { className: 'wg-seg', role: 'group', 'aria-label': '视图模式' },
              h('button', { type: 'button', 'aria-pressed': view === 'grid', onClick: () => switchView('grid') }, '网格'),
              h('button', { type: 'button', 'aria-pressed': view === 'list', onClick: () => switchView('list') }, '列表'))
            : null,
          phase === 'panel'
            ? h('button', {
              className: 'wg-btn',
              disabled: batchBusy !== null || fetching,
              title: '对所有托管仓库执行 git pull --ff-only（脏工作区会跳过）',
              onClick: () => runBatch('pull'),
            }, batchBusy === 'pull' ? '拉取中…' : '批量拉取')
            : null,
          phase === 'panel'
            ? h('button', {
              className: 'wg-btn',
              disabled: batchBusy !== null || fetching,
              title: '推送所有有 upstream 的仓库分支',
              onClick: () => runBatch('push'),
            }, batchBusy === 'push' ? '推送中…' : '批量推送')
            : null,
          phase === 'panel'
            ? h('button', {
              className: 'wg-btn',
              disabled: batchBusy !== null || fetching,
              title: '用模型为每个有变更的仓库生成 commit message 草稿',
              onClick: () => runBatch('suggest'),
            }, batchBusy === 'suggest' ? '生成中…' : '批量生成提交信息')
            : null,
          phase === 'panel' || phase === 'error'
            ? h('button', {
              className: 'wg-btn',
              disabled: loading || fetching,
              onClick: () => { if (phase === 'panel') void checkUpdates(); else loadIndex(true); },
            }, fetching ? '检查中…' : '刷新')
            : null,
          phase === 'panel'
            ? h('button', { className: 'wg-btn', onClick: () => setPhase('picker') }, '管理工作区')
            : null),
        error && phase === 'panel' ? h('div', { className: 'wg-error', style: { padding: '0 20px' } }, error) : null,
        batchNotice ? h('div', { className: 'wg-batch-note', role: 'status' }, batchNotice) : null,
        h('div', { className: 'wg-body' }, body));
    }

    function apply(ctx) {
      injectStyle();
      try {
        document.documentElement.dataset.dshWorkaroundGit = '1';
      } catch { /* noop */ }
      const slots = ctx && ctx.slots;
      if (!slots || typeof slots.register !== 'function') {
        ctx?.logger?.info?.('[workaround-git] slots unavailable; panel not registered');
        return;
      }
      try {
        slots.inject('main', () => slots.register({ name: 'main', key: PANEL_ID, locale: undefined }, Page));
        slots.inject('sidebar.panellist', () => slots.register({
          name: 'sidebar.panellist', id: PANEL_ID, order: 45, label: () => PANEL_LABEL,
        }, icon));
        ctx?.logger?.info?.('[workaround-git] sidebar entry + page registered');
      } catch (error) {
        ctx?.logger?.warn?.('[workaround-git] panel registration failed: ' + (error && error.message));
      }
    }

    exports.name = 'dsh-workaround-git-client';
    exports.inject = ['slots', 'layout'];
    exports.apply = apply;
    return module.exports;
  },
});
