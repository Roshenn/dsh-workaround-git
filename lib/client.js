/**
 * dsh-workaround-git — browser half.
 *
 * Registers one left-sidebar entry plus its main-area page, following the same
 * ModuleLoader contract as the other client plugins in this profile:
 * `window.__ModuleLoader__.load({ id, factory })`, exports `{ name, inject, apply }`.
 *
 * Layout: one vertical card per repository, laid out horizontally as a grid
 * (4 columns by default, adaptive down to 1). Every card keeps the same block
 * order and fixed block heights, so the file list, message box and action
 * buttons of a row share a horizontal line. A list view (single column) stays
 * available from the header and is remembered in localStorage.
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
      .wg-root { box-sizing: border-box; height: 100%; min-height: 0; display: flex; flex-direction: column;
        font: 13px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
        color: var(--wg-fg); background: var(--wg-bg); }
      .wg-root *, .wg-root *::before, .wg-root *::after { box-sizing: border-box; }
      .wg-head { flex: 0 0 auto; display: flex; align-items: center; gap: 10px; padding: 12px 20px;
        border-bottom: 1px solid var(--wg-line); }
      .wg-title { font-size: 15px; font-weight: 600; margin: 0; }
      .wg-muted { color: var(--wg-muted); }
      .wg-grow { flex: 1 1 auto; }
      .wg-body { flex: 1 1 auto; min-height: 0; overflow: auto; padding: 16px 20px 40px; }
      /* One horizontal strip: cards never wrap. Extra cards scroll sideways. */
      .wg-strip-wrap { position: relative; }
      .wg-strip { overflow-x: auto; overflow-y: hidden; padding-bottom: 10px; scrollbar-width: thin; }
      .wg-strip:focus-visible { outline: 2px solid var(--wg-accent); outline-offset: 2px; }
      .wg-strip-list { max-width: 920px; }
      .wg-grid { display: grid; grid-auto-flow: column; align-items: stretch; gap: ${GAP}px;
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
      .wg-col-head { display: flex; flex-direction: column; }
      .wg-col-line1 { display: flex; align-items: center; gap: 8px; min-width: 0; height: 22px; overflow: hidden; }
      .wg-repo-name { font-weight: 600; font-size: 13px; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .wg-col-line { display: flex; align-items: center; gap: 8px; min-width: 0; height: 18px; overflow: hidden;
        font-size: 11.5px; color: var(--wg-muted); }
      .wg-ws-tag, .wg-commit { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .wg-files { margin: 8px 0 0; padding: 0; list-style: none; height: 132px; overflow: auto;
        border-top: 1px dashed var(--wg-line); }
      .wg-files-empty { display: flex; align-items: center; justify-content: center; height: 132px; margin-top: 8px;
        border-top: 1px dashed var(--wg-line); color: var(--wg-muted); font-size: 11.5px; }
      .wg-file { display: flex; gap: 8px; padding: 3px 0; font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
        font-size: 11.5px; }
      .wg-file-status { flex: 0 0 12px; color: var(--wg-accent); }
      .wg-file-path { flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .wg-msg { width: 100%; height: 64px; resize: none; margin-top: 10px; padding: 7px 9px; border-radius: 8px;
        border: 1px solid var(--wg-line); background: var(--wg-bg); color: var(--wg-fg);
        font: 12px/1.45 ui-monospace, SFMono-Regular, Consolas, monospace; }
      .wg-msg:focus-visible { outline: 2px solid var(--wg-accent); outline-offset: -1px; }
      .wg-actions { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 6px; margin-top: 8px; }
      .wg-actions .wg-btn { width: 100%; padding: 0 6px; }
      .wg-actions .wg-btn-primary { grid-column: 1 / -1; }
      .wg-status { height: 18px; margin-top: 6px; font-size: 11.5px; line-height: 18px; overflow: hidden;
        text-overflow: ellipsis; white-space: nowrap; }
      .wg-status-error { color: var(--wg-danger); }
      .wg-status-ok { color: var(--wg-ok); }
      .wg-error { margin-top: 8px; font-size: 12px; color: var(--wg-danger); }
      .wg-empty { padding: 40px 0; text-align: center; color: var(--wg-muted); }
      .wg-section-hint { margin: 0 0 10px; color: var(--wg-muted); font-size: 12px; }
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

    /**
     * Column count for the card grid: 4 on a wide body, fewer as it narrows.
     * Measuring the grid wrapper (not the viewport) keeps the sidebar width out
     * of the calculation.
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
        h('div', { className: 'wg-actions', style: { marginTop: 14, gridTemplateColumns: 'repeat(3, max-content)' } },
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

    /** One vertical card per repository; block heights are fixed so a row lines up. */
    function RepoColumn({ workspaceId, workspaceTitle, repo, onChanged }) {
      const [message, setMessage] = React.useState('');
      const [busy, setBusy] = React.useState(null);
      const [error, setError] = React.useState(null);
      const [notice, setNotice] = React.useState(null);

      const run = async (action, task) => {
        setBusy(action);
        setError(null);
        setNotice(null);
        try {
          await task();
          onChanged();
        } catch (caught) {
          setError(caught.message || String(caught));
        } finally {
          setBusy(null);
        }
      };

      const stageAndDraft = () => run('suggest', async () => {
        await call('/stage', { method: 'POST', body: JSON.stringify({ workspaceId, repo: repo.path }) });
        const draft = await call('/suggest', { method: 'POST', body: JSON.stringify({ workspaceId, repo: repo.path }) });
        setMessage(draft.message);
        setNotice(`已暂存，草稿来自 ${draft.model}${draft.truncated ? '（diff 已截断）' : ''}`);
      });

      const commit = () => run('commit', async () => {
        if (message.trim() === '') throw new Error('先写入或生成一条 commit message');
        const result = await call('/commit', { method: 'POST', body: JSON.stringify({ workspaceId, repo: repo.path, message }) });
        setNotice(`已提交 ${result.commit || ''}`.trim());
        setMessage('');
      });

      const gitAction = (action) => run(action, async () => {
        const result = await call(`/${action}`, { method: 'POST', body: JSON.stringify({ workspaceId, repo: repo.path }) });
        setNotice(result.action || action);
      });

      const counts = [
        repo.staged > 0 ? `${repo.staged} 已暂存` : null,
        repo.modified > 0 ? `${repo.modified} 已修改` : null,
        repo.untracked > 0 ? `${repo.untracked} 未跟踪` : null,
        repo.conflicted > 0 ? `${repo.conflicted} 冲突` : null,
      ].filter(Boolean);

      const lastCommit = repo.lastCommit
        ? `${repo.lastCommit.hash || ''} ${repo.lastCommit.subject || ''}`.trim()
        : '';

      const statusText = error || notice || '';
      const statusClass = error ? 'wg-status wg-status-error' : 'wg-status wg-status-ok';

      return h('article', { className: 'wg-card', 'data-repo': repo.path },
        h('div', { className: 'wg-col-head' },
          h('div', { className: 'wg-col-line1' },
            h('span', { className: 'wg-repo-name', title: repo.repo }, repo.repo),
            h('span', { className: 'wg-grow' }),
            h(Badge, null, repo.branch || '(detached)')),
          h('div', { className: 'wg-col-line' },
            workspaceTitle && workspaceTitle !== repo.repo
              ? h('span', { className: 'wg-ws-tag', title: workspaceTitle }, workspaceTitle)
              : null,
            h('span', { className: 'wg-grow' }),
            h('span', { className: 'wg-chip', title: 'ahead / behind' }, `↑${repo.ahead ?? 0} ↓${repo.behind ?? 0}`),
            counts.length > 0 ? h('span', { className: 'wg-chip' }, counts.join(' · ')) : null),
          h('div', { className: 'wg-col-line' },
            h('span', { className: 'wg-commit', title: lastCommit || '无提交' }, lastCommit || '—'),
            h('span', { className: 'wg-grow' }),
            h('span', { className: 'wg-chip', title: '新增 / 删除行数' }, `+${repo.added} −${repo.removed}`))),
        repo.files.length > 0
          ? h('ul', { className: 'wg-files', 'aria-label': '变更文件' },
            repo.files.slice(0, 60).map((file) => h('li', { key: file.path, className: 'wg-file' },
              h('span', { className: 'wg-file-status' }, file.status),
              h('span', { className: 'wg-file-path', title: file.path }, file.path))))
          : h('div', { className: 'wg-files-empty' }, '没有未提交的变更'),
        h('textarea', {
          className: 'wg-msg',
          value: message,
          placeholder: 'commit message（可 AI 生成）',
          'aria-label': `${repo.repo} 的 commit message`,
          onChange: (event) => setMessage(event.target.value),
        }),
        h('div', { className: 'wg-actions' },
          h('button', { className: 'wg-btn wg-btn-primary', disabled: busy !== null, onClick: stageAndDraft },
            busy === 'suggest' ? '生成中…' : '暂存并生成'),
          h('button', { className: 'wg-btn', disabled: busy !== null || message.trim() === '', onClick: commit },
            busy === 'commit' ? '提交中…' : '提交'),
          h('button', { className: 'wg-btn', disabled: busy !== null, onClick: () => gitAction('sync') }, '同步'),
          h('button', { className: 'wg-btn', disabled: busy !== null, onClick: () => gitAction('push') }, '推送')),
        h('div', { className: statusClass, role: error ? 'alert' : undefined, title: statusText }, statusText));
    }

    /**
     * One horizontal strip of repository cards. Cards never wrap: 4 are visible
     * by default, the rest scroll sideways (wheel, trackpad, or the edge buttons).
     */
    function RepoGrid({ data, view, columns, onRefresh, stripRef }) {
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

      return h('div', null,
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

      React.useEffect(() => { loadIndex(false); }, [loadIndex]);

      const switchView = (next) => {
        setView(next);
        storeView(next);
      };

      const save = async (picked) => {
        setSaving(true);
        setError(null);
        try {
          const result = await call('/managed', {
            method: 'POST',
            body: JSON.stringify({ workspaces: picked.map((workspace) => ({ id: workspace.id, path: workspace.path, title: workspace.title })) }),
          });
          setManaged(result.managed.workspaces);
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
        body = h(RepoGrid, { data, view, columns, onRefresh: refreshState, stripRef });
      }

      return h('div', { className: 'wg-root', 'data-view': view },
        h('header', { className: 'wg-head' },
          h('h1', { className: 'wg-title' }, '工作区 Git'),
          h('span', { className: 'wg-grow' }),
          phase === 'panel'
            ? h('div', { className: 'wg-seg', role: 'group', 'aria-label': '视图模式' },
              h('button', { type: 'button', 'aria-pressed': view === 'grid', onClick: () => switchView('grid') }, '网格'),
              h('button', { type: 'button', 'aria-pressed': view === 'list', onClick: () => switchView('list') }, '列表'))
            : null,
          phase === 'panel' || phase === 'error'
            ? h('button', { className: 'wg-btn', disabled: loading, onClick: () => loadIndex(true) }, loading ? '刷新中…' : '刷新')
            : null,
          phase === 'panel'
            ? h('button', { className: 'wg-btn', onClick: () => setPhase('picker') }, '管理工作区')
            : null),
        error && phase === 'panel' ? h('div', { className: 'wg-error', style: { padding: '0 20px' } }, error) : null,
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
