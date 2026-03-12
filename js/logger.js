/**
 * StoreConnect Site Analyser — Debug Logger
 *
 * Captures timestamped, levelled log entries in a ring buffer.
 * Outputs to both the browser console and an in-page debug panel.
 *
 * Toggle panel:  Ctrl+Shift+L
 * Download log:  button in panel, or call SaLog.download()
 * Access logs:   SaLog.entries()
 */

(function () {
  'use strict';

  const MAX_ENTRIES = 2000;
  const LEVELS = { trace: 0, debug: 1, info: 2, warn: 3, error: 4 };
  const LEVEL_BADGES = {
    trace: 'color:#888',
    debug: 'color:#6b7280',
    info:  'color:#3b82f6',
    warn:  'color:#f59e0b;font-weight:bold',
    error: 'color:#dc2626;font-weight:bold',
  };

  let buffer = [];
  let seqId = 0;
  let sessionId = crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36);
  let minLevel = LEVELS.trace;        // capture everything by default
  let panelEl = null;
  let panelListEl = null;
  let panelVisible = false;
  let autoScroll = true;

  // ── Core ──────────────────────────────────────────────────
  function log(level, category, message, data) {
    if (LEVELS[level] === undefined) level = 'info';
    if (LEVELS[level] < minLevel) return;

    const entry = {
      id: ++seqId,
      ts: new Date().toISOString(),
      elapsed: performance.now().toFixed(1),
      level,
      cat: category || 'app',
      msg: message,
      data: data !== undefined ? structuredClone(data) : undefined,
    };

    buffer.push(entry);
    if (buffer.length > MAX_ENTRIES) buffer.shift();

    // Console output
    const badge = LEVEL_BADGES[level] || '';
    const prefix = `%c[${level.toUpperCase()}]%c [${entry.cat}]`;
    if (entry.data !== undefined) {
      console.log(prefix, badge, 'color:#9ca3af', entry.msg, entry.data);
    } else {
      console.log(prefix, badge, 'color:#9ca3af', entry.msg);
    }

    // Panel output
    if (panelListEl) appendPanelEntry(entry);

    return entry;
  }

  // ── Convenience methods ───────────────────────────────────
  const trace = (cat, msg, data) => log('trace', cat, msg, data);
  const debug = (cat, msg, data) => log('debug', cat, msg, data);
  const info  = (cat, msg, data) => log('info',  cat, msg, data);
  const warn  = (cat, msg, data) => log('warn',  cat, msg, data);
  const error = (cat, msg, data) => log('error', cat, msg, data);

  // ── Network tracing ───────────────────────────────────────
  function traceRequest(method, url, opts) {
    return info('net', `${method} ${url}`, opts);
  }

  function traceResponse(method, url, status, duration, body) {
    const level = status >= 400 ? 'error' : status >= 300 ? 'warn' : 'info';
    return log(level, 'net', `${method} ${url} → ${status} (${duration}ms)`, body);
  }

  // Wrap fetch for automatic tracing
  const _origFetch = window.fetch;
  window.fetch = async function (input, init) {
    const url = typeof input === 'string' ? input : input.url;
    const method = (init?.method || 'GET').toUpperCase();
    const t0 = performance.now();
    traceRequest(method, url, init?.body ? { body: init.body } : undefined);

    try {
      const res = await _origFetch.call(this, input, init);
      const dt = (performance.now() - t0).toFixed(0);
      // Clone and read body for logging (only for small JSON responses)
      let bodySnippet;
      try {
        const clone = res.clone();
        const ct = clone.headers.get('content-type') || '';
        if (ct.includes('json')) {
          bodySnippet = await clone.json();
        } else {
          const text = await clone.text();
          bodySnippet = text.length > 500 ? text.substring(0, 500) + '…' : text;
        }
      } catch { bodySnippet = '(unreadable)'; }

      traceResponse(method, url, res.status, dt, bodySnippet);
      return res;
    } catch (err) {
      const dt = (performance.now() - t0).toFixed(0);
      error('net', `${method} ${url} FAILED (${dt}ms)`, { error: err.message, stack: err.stack });
      throw err;
    }
  };

  // ── SSE tracing helper ────────────────────────────────────
  function traceSSE(eventType, data) {
    debug('sse', `event: ${eventType}`, data);
  }

  function traceSSEOpen(url) {
    info('sse', `EventSource opened → ${url}`);
  }

  function traceSSEClose(url, reason) {
    warn('sse', `EventSource closed → ${url}`, { reason });
  }

  function traceSSEError(url, readyState) {
    const stateMap = { 0: 'CONNECTING', 1: 'OPEN', 2: 'CLOSED' };
    error('sse', `EventSource error → ${url}`, { readyState: stateMap[readyState] || readyState });
  }

  // ── State tracing ─────────────────────────────────────────
  function traceState(label, stateObj) {
    debug('state', label, stateObj);
  }

  function traceView(from, to) {
    info('view', `${from} → ${to}`);
  }

  // ── Global error capture ──────────────────────────────────
  window.addEventListener('error', (e) => {
    error('uncaught', e.message, {
      filename: e.filename,
      lineno: e.lineno,
      colno: e.colno,
      stack: e.error?.stack,
    });
  });

  window.addEventListener('unhandledrejection', (e) => {
    error('promise', 'Unhandled rejection', {
      reason: e.reason?.message || String(e.reason),
      stack: e.reason?.stack,
    });
  });

  // ── Download ──────────────────────────────────────────────
  function download() {
    const lines = buffer.map((e) => {
      const dataStr = e.data !== undefined ? ' ' + JSON.stringify(e.data) : '';
      return `${e.ts} [${e.elapsed}ms] ${e.level.toUpperCase().padEnd(5)} [${e.cat}] ${e.msg}${dataStr}`;
    });

    const header = [
      `# StoreConnect Site Analyser — Debug Log`,
      `# Session: ${sessionId}`,
      `# Exported: ${new Date().toISOString()}`,
      `# Entries: ${buffer.length}`,
      `# User-Agent: ${navigator.userAgent}`,
      `# URL: ${window.location.href}`,
      ``,
    ];

    const blob = new Blob([header.join('\n') + lines.join('\n')], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `sa-debug-${sessionId.substring(0, 8)}-${Date.now()}.log`;
    a.click();
    URL.revokeObjectURL(a.href);
    info('logger', 'Log file downloaded');
  }

  // ── Debug Panel ───────────────────────────────────────────
  function createPanel() {
    panelEl = document.createElement('div');
    panelEl.id = 'sa-debug-panel';
    panelEl.innerHTML = `
      <div class="sa-dbg-header">
        <span class="sa-dbg-title">Debug Log</span>
        <span class="sa-dbg-count" id="sa-dbg-count">${buffer.length}</span>
        <div class="sa-dbg-actions">
          <select id="sa-dbg-filter">
            <option value="all">All</option>
            <option value="net">Network</option>
            <option value="sse">SSE</option>
            <option value="state">State</option>
            <option value="view">Views</option>
            <option value="error">Errors</option>
          </select>
          <button id="sa-dbg-clear" title="Clear">Clear</button>
          <button id="sa-dbg-download" title="Download .log">Export</button>
          <button id="sa-dbg-close" title="Close (Ctrl+Shift+L)">X</button>
        </div>
      </div>
      <div class="sa-dbg-list" id="sa-dbg-list"></div>
    `;
    document.body.appendChild(panelEl);
    panelListEl = document.getElementById('sa-dbg-list');

    // Render existing buffer
    buffer.forEach((e) => appendPanelEntry(e));

    // Bindings
    document.getElementById('sa-dbg-close').addEventListener('click', togglePanel);
    document.getElementById('sa-dbg-download').addEventListener('click', download);
    document.getElementById('sa-dbg-clear').addEventListener('click', () => {
      buffer = [];
      seqId = 0;
      panelListEl.innerHTML = '';
      updateCount();
    });
    document.getElementById('sa-dbg-filter').addEventListener('change', (e) => {
      filterPanel(e.target.value);
    });

    panelListEl.addEventListener('scroll', () => {
      const el = panelListEl;
      autoScroll = (el.scrollTop + el.clientHeight >= el.scrollHeight - 30);
    });
  }

  function appendPanelEntry(entry) {
    if (!panelListEl) return;
    const div = document.createElement('div');
    div.className = `sa-dbg-entry sa-dbg-${entry.level} sa-dbg-cat-${entry.cat}`;
    div.dataset.cat = entry.cat;
    div.dataset.level = entry.level;

    const ts = entry.ts.substring(11, 23); // HH:MM:SS.mmm
    const dataStr = entry.data !== undefined
      ? `<span class="sa-dbg-data">${escHtml(JSON.stringify(entry.data, null, 0).substring(0, 300))}</span>`
      : '';

    div.innerHTML = `<span class="sa-dbg-ts">${ts}</span>`
      + `<span class="sa-dbg-lvl">${entry.level.substring(0, 3).toUpperCase()}</span>`
      + `<span class="sa-dbg-cat">${entry.cat}</span>`
      + `<span class="sa-dbg-msg">${escHtml(entry.msg)}</span>`
      + dataStr;

    panelListEl.appendChild(div);
    if (autoScroll) panelListEl.scrollTop = panelListEl.scrollHeight;
    updateCount();
  }

  function updateCount() {
    const el = document.getElementById('sa-dbg-count');
    if (el) el.textContent = buffer.length;
  }

  function filterPanel(filter) {
    if (!panelListEl) return;
    const entries = panelListEl.querySelectorAll('.sa-dbg-entry');
    entries.forEach((el) => {
      if (filter === 'all') {
        el.style.display = '';
      } else if (filter === 'error') {
        el.style.display = (el.dataset.level === 'error' || el.dataset.level === 'warn') ? '' : 'none';
      } else {
        el.style.display = el.dataset.cat === filter ? '' : 'none';
      }
    });
  }

  function togglePanel() {
    if (!panelEl) createPanel();
    panelVisible = !panelVisible;
    panelEl.style.display = panelVisible ? 'flex' : 'none';
    if (panelVisible) {
      info('logger', 'Debug panel opened');
      panelListEl.scrollTop = panelListEl.scrollHeight;
    }
  }

  function escHtml(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // ── Keyboard shortcut ─────────────────────────────────────
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.shiftKey && e.key === 'L') {
      e.preventDefault();
      togglePanel();
    }
  });

  // ── Inject panel styles ───────────────────────────────────
  const style = document.createElement('style');
  style.textContent = `
    #sa-debug-panel {
      display: none;
      position: fixed; bottom: 0; left: 0; right: 0;
      height: 320px; z-index: 9999;
      background: #0f0f0f; color: #d4d4d4;
      font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace;
      font-size: 11px; line-height: 1.5;
      flex-direction: column;
      border-top: 2px solid #facc15;
      box-shadow: 0 -4px 20px rgba(0,0,0,0.5);
    }
    .sa-dbg-header {
      display: flex; align-items: center; gap: 0.5rem;
      padding: 6px 12px; background: #1a1a1a;
      border-bottom: 1px solid #333;
      flex-shrink: 0;
    }
    .sa-dbg-title { font-weight: 700; color: #facc15; font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; }
    .sa-dbg-count {
      background: #333; color: #9ca3af; font-size: 10px;
      padding: 1px 6px; border-radius: 8px;
    }
    .sa-dbg-actions { margin-left: auto; display: flex; gap: 4px; }
    .sa-dbg-actions select,
    .sa-dbg-actions button {
      background: #2a2a2a; color: #9ca3af; border: 1px solid #444;
      font-size: 10px; padding: 2px 8px; border-radius: 3px;
      cursor: pointer; font-family: inherit;
    }
    .sa-dbg-actions button:hover { background: #333; color: #fff; }
    .sa-dbg-list {
      flex: 1; overflow-y: auto; padding: 4px 0;
    }
    .sa-dbg-list::-webkit-scrollbar { width: 6px; }
    .sa-dbg-list::-webkit-scrollbar-thumb { background: #444; border-radius: 3px; }
    .sa-dbg-entry {
      display: flex; gap: 8px; padding: 1px 12px;
      border-bottom: 1px solid #1a1a1a;
      align-items: baseline; flex-wrap: wrap;
    }
    .sa-dbg-entry:hover { background: #1a1a1a; }
    .sa-dbg-ts { color: #555; flex-shrink: 0; }
    .sa-dbg-lvl { width: 28px; text-align: center; font-weight: 700; flex-shrink: 0; border-radius: 2px; padding: 0 2px; }
    .sa-dbg-trace .sa-dbg-lvl { color: #555; }
    .sa-dbg-debug .sa-dbg-lvl { color: #6b7280; }
    .sa-dbg-info  .sa-dbg-lvl { color: #3b82f6; }
    .sa-dbg-warn  .sa-dbg-lvl { color: #f59e0b; background: rgba(245,158,11,0.1); }
    .sa-dbg-error .sa-dbg-lvl { color: #ef4444; background: rgba(239,68,68,0.1); }
    .sa-dbg-error { background: rgba(239,68,68,0.04); }
    .sa-dbg-warn  { background: rgba(245,158,11,0.03); }
    .sa-dbg-cat { color: #818cf8; font-size: 10px; flex-shrink: 0; }
    .sa-dbg-msg { color: #d4d4d4; }
    .sa-dbg-data { color: #6b7280; font-size: 10px; word-break: break-all; width: 100%; padding-left: 92px; }
  `;
  document.head.appendChild(style);

  // ── Public API ────────────────────────────────────────────
  window.SaLog = {
    trace, debug, info, warn, error,
    traceRequest, traceResponse,
    traceSSE, traceSSEOpen, traceSSEClose, traceSSEError,
    traceState, traceView,
    entries: () => [...buffer],
    download,
    toggle: togglePanel,
    setLevel: (lvl) => { minLevel = LEVELS[lvl] || 0; },
    sessionId,
  };

  info('logger', `Debug logger initialised — session ${sessionId}`);
  info('logger', `Toggle panel: Ctrl+Shift+L | Download: SaLog.download()`);

})();
