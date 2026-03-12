/**
 * StoreConnect Site Analyser — Frontend Application
 *
 * Two-phase flow:
 *   Phase 1: /api/discover  — fetch URL list, cache in state
 *   Phase 2: /api/analyse   — SSE stream, scrape page-by-page
 *
 * Three views:
 *   1. Landing  — URL entry + validation
 *   2. Progress — Phase 1 discover + Phase 2 per-page analysis
 *   3. Report   — Rendered report with share/download
 */

(function () {
  'use strict';

  const L = window.SaLog || { trace(){}, debug(){}, info(){}, warn(){}, error(){}, traceSSE(){}, traceSSEOpen(){}, traceSSEClose(){}, traceSSEError(){}, traceState(){}, traceView(){} };

  // ── Configuration ──────────────────────────────────────────
  const CONFIG = {
    apiBase: (typeof window !== 'undefined' && window.SITE_ANALYSER_API_BASE) || 'http://localhost:8000/api',
    maxPages: 15,
    reassuranceDelay: 90000,        // Show "still working" after 90s
    minStepDisplay: 800,            // Minimum ms per step for fast sites
    reconnectAttempts: 3,
    reconnectDelay: 2000,
    shareLinkExpiryDays: 30,
  };

  L.info('config', 'App configuration loaded', CONFIG);

  // ── DOM References ─────────────────────────────────────────
  const $ = (id) => document.getElementById(id);

  const views = {
    landing: $('view-landing'),
    progress: $('view-progress'),
    report: $('view-report'),
  };

  const els = {
    urlForm: $('url-form'),
    contactName: $('contact-name'),
    contactEmail: $('contact-email'),
    contactPhone: $('contact-phone'),
    urlInput: $('url-input'),
    btnAnalyse: $('btn-analyse'),
    formError: $('form-error'),
    formWarning: $('form-warning'),
    formCached: $('form-cached'),
    btnWarningCancel: $('btn-warning-cancel'),
    btnWarningContinue: $('btn-warning-continue'),
    btnCachedLoad: $('btn-cached-load'),
    btnCachedRerun: $('btn-cached-rerun'),
    progressDomain: $('progress-domain'),
    progressSub: $('progress-sub'),
    progressBar: $('progress-bar'),
    progressTime: $('progress-time'),
    progressReassurance: $('progress-reassurance'),
    btnCancel: $('btn-cancel'),
    bannerError: $('banner-error'),
    bannerWarning: $('banner-warning'),
    bannerReconnect: $('banner-reconnect'),
    reportDomainLabel: $('report-domain-label'),
    reportDateBadge: $('report-date-badge'),
    reportEmailSent: $('report-email-sent'),
    reportWarningBar: $('report-warning-bar'),
    reportFrame: $('report-frame'),
    btnNewAnalysis: $('btn-new-analysis'),
    btnShare: $('btn-share'),
    btnDownload: $('btn-download'),
    shareModal: $('share-modal'),
    shareLinkInput: $('share-link-input'),
    btnCopy: $('btn-copy'),
    shareMeta: $('share-meta'),
    btnCloseModal: $('btn-close-modal'),
    navMeta: $('nav-meta'),
  };

  // Verify all DOM refs resolved
  const missingEls = Object.entries(els).filter(([, v]) => !v).map(([k]) => k);
  if (missingEls.length) {
    L.error('dom', `Missing DOM elements: ${missingEls.join(', ')}`);
  } else {
    L.debug('dom', `All ${Object.keys(els).length} DOM references resolved`);
  }

  // ── State ──────────────────────────────────────────────────
  let state = {
    currentView: 'landing',
    jobId: null,
    eventSource: null,
    startTime: null,
    reconnectCount: 0,
    reassuranceTimer: null,
    url: '',
    domain: '',
    reportId: null,
    discoveredUrls: [],     // cached URL list from Phase 1
    pagesTotal: 0,
    pagesDone: 0,
    contact: { name: '', email: '', phone: '' },
    emailSentThisRun: false,  // true when we completed analysis (PDF emailed)
  };

  // ── Steps definition ──────────────────────────────────────
  const STEPS = ['resolve', 'crawl', 'dom', 'sitemap', 'frameworks', 'scoring', 'report'];

  // ── View Management ────────────────────────────────────────
  function showView(name) {
    const prev = state.currentView;
    Object.entries(views).forEach(([key, el]) => {
      el.classList.toggle('hidden', key !== name);
    });
    state.currentView = name;
    L.traceView(prev, name);
  }

  // ── URL Validation ─────────────────────────────────────────
  function normaliseUrl(raw) {
    let url = raw.trim();
    if (!url) return '';
    if (!/^https?:\/\//i.test(url)) {
      L.debug('validate', `Auto-prefixing https:// to "${url}"`);
      url = 'https://' + url;
    }
    try {
      const parsed = new URL(url);
      if (parsed.pathname === '/') url = url.replace(/\/+$/, '');
      L.debug('validate', `Normalised URL: ${url}`);
      return url;
    } catch (e) {
      L.warn('validate', `URL parse failed for "${url}"`, { error: e.message });
      return '';
    }
  }

  function extractDomain(url) {
    try { return new URL(url).hostname; } catch { return url; }
  }

  function validateContact() {
    const name = (els.contactName?.value || '').trim();
    const email = (els.contactEmail?.value || '').trim();
    const phone = (els.contactPhone?.value || '').trim();
    if (!name) return { valid: false, error: 'Please enter your name.' };
    if (!email) return { valid: false, error: 'Please enter your email address.' };
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { valid: false, error: 'Please enter a valid email address.' };
    if (!phone) return { valid: false, error: 'Please enter your phone number.' };
    const digits = phone.replace(/\D/g, '');
    if (digits.length < 8) return { valid: false, error: 'Please enter a valid phone number.' };
    return { valid: true, contact: { name, email, phone } };
  }

  function validateUrl(url) {
    if (!url) {
      L.debug('validate', 'Empty URL submitted');
      return { valid: false, error: 'Please enter a URL to analyse.' };
    }
    const normalised = normaliseUrl(url);
    if (!normalised) return { valid: false, error: "That doesn't look like a valid URL." };
    return { valid: true, url: normalised };
  }

  // ── Error Display ──────────────────────────────────────────
  function showFormError(msg, focusContact) {
    L.warn('ui', `Form error shown: "${msg}"`);
    els.formError.textContent = msg;
    [els.contactName, els.contactEmail, els.contactPhone, els.urlInput].forEach((el) => {
      if (el) el.classList.add('error', 'shake');
    });
    (focusContact ? els.contactName : els.urlInput)?.focus();
    setTimeout(() => {
      [els.contactName, els.contactEmail, els.contactPhone, els.urlInput].forEach((el) => {
        if (el) el.classList.remove('shake');
      });
    }, 400);
  }

  function clearFormError() {
    els.formError.textContent = '';
    [els.contactName, els.contactEmail, els.contactPhone, els.urlInput].forEach((el) => {
      if (el) el.classList.remove('error');
    });
  }

  // ── Landing Page Logic ─────────────────────────────────────
  function handleSubmit(e) {
    e.preventDefault();
    clearFormError();
    els.formWarning.classList.add('hidden');
    els.formCached.classList.add('hidden');

    const contactResult = validateContact();
    if (!contactResult.valid) {
      showFormError(contactResult.error, true);
      return;
    }
    state.contact = contactResult.contact;

    const raw = els.urlInput.value;
    L.info('submit', `Form submitted with value: "${raw}"`);

    const result = validateUrl(raw);

    if (!result.valid) {
      showFormError(result.error, false);
      return;
    }

    state.url = result.url;
    state.domain = extractDomain(result.url);
    els.btnAnalyse.disabled = true;

    L.info('submit', `Validated URL: ${state.url} (domain: ${state.domain})`);
    L.traceState('pre-cache-check', { url: state.url, domain: state.domain });

    checkCachedReport(state.url)
      .then((cached) => {
        if (cached) {
          L.info('cache', 'Cached report found', cached);
          els.formCached.classList.remove('hidden');
          els.btnAnalyse.disabled = false;
        } else {
          L.info('cache', 'No cached report — starting Phase 1');
          runPhase1(state.url);
        }
      })
      .catch((err) => {
        L.warn('cache', 'Cache check failed, proceeding to Phase 1', { error: err.message });
        runPhase1(state.url);
      });
  }

  function contactParams() {
    const c = state.contact;
    return `name=${encodeURIComponent(c.name)}&email=${encodeURIComponent(c.email)}&phone=${encodeURIComponent(c.phone)}`;
  }

  async function checkCachedReport(url) {
    L.debug('cache', `Checking cache for: ${url}`);
    try {
      const res = await fetch(`${CONFIG.apiBase}/check?url=${encodeURIComponent(url)}&${contactParams()}`);
      if (res.ok) {
        const data = await res.json();
        L.debug('cache', 'Cache response', data);
        return data.cached ? data : null;
      }
      L.debug('cache', `Cache check returned ${res.status}`);
      return null;
    } catch (err) {
      L.warn('cache', 'Cache check network error', { error: err.message });
      return null;
    }
  }

  // ── Phase 1: Discover URLs ─────────────────────────────────
  async function runPhase1(url) {
    L.info('phase1', `=== PHASE 1 START === Discovering pages for ${url}`);
    showView('progress');
    els.progressDomain.textContent = state.domain;
    els.progressSub.textContent = `Discovering pages on ${state.domain}…`;
    if (els.navMeta) els.navMeta.textContent = state.domain;

    resetProgressSteps();
    els.bannerError.classList.add('hidden');
    els.bannerWarning.classList.add('hidden');
    els.bannerReconnect.classList.add('hidden');
    els.progressReassurance.classList.add('hidden');

    state.startTime = Date.now();
    state.reconnectCount = 0;
    state.discoveredUrls = [];
    state.pagesTotal = 0;
    state.pagesDone = 0;
    state.emailSentThisRun = false;

    L.traceState('phase1-init', {
      startTime: state.startTime,
      url: state.url,
      domain: state.domain,
    });

    // Start reassurance timer
    state.reassuranceTimer = setTimeout(() => {
      L.info('ui', 'Reassurance message shown (90s elapsed)');
      els.progressReassurance.classList.remove('hidden');
    }, CONFIG.reassuranceDelay);

    // Mark resolve as active immediately (backend will confirm via SSE)
    setStepState('resolve', 'active');

    // Call /api/discover to get URL list upfront
    const discoverUrl = `${CONFIG.apiBase}/discover?url=${encodeURIComponent(url)}&${contactParams()}`;
    L.info('phase1', `Calling discover endpoint: ${discoverUrl}`);

    try {
      setStepState('crawl', 'active', 'Mapping site pages…');
      const t0 = performance.now();
      const res = await fetch(discoverUrl);
      const dt = (performance.now() - t0).toFixed(0);

      if (res.ok) {
        const data = await res.json();
        state.discoveredUrls = data.urls || [url];
        state.pagesTotal = data.total || 1;
        L.info('phase1', `Discovery complete in ${dt}ms: ${state.pagesTotal} pages found`, {
          urls: state.discoveredUrls,
          total: state.pagesTotal,
        });
        setStepState('crawl', 'done', `Found ${state.pagesTotal} page${state.pagesTotal !== 1 ? 's' : ''} to analyse`);
        els.progressSub.textContent = `Analysing ${state.pagesTotal} page${state.pagesTotal !== 1 ? 's' : ''} on ${state.domain}…`;
      } else {
        L.warn('phase1', `Discovery failed with status ${res.status} after ${dt}ms — falling back to root URL`);
        state.discoveredUrls = [url];
        state.pagesTotal = 1;
        setStepState('crawl', 'done', 'Analysing root page');
        showBannerWarning('Could not map site — analysing root page only.');
      }
    } catch (err) {
      L.error('phase1', 'Discovery network error — falling back to root URL', {
        error: err.message,
        stack: err.stack,
      });
      state.discoveredUrls = [url];
      state.pagesTotal = 1;
      setStepState('crawl', 'done', 'Analysing root page');
      showBannerWarning('Discovery unavailable — analysing root page only.');
    }

    L.traceState('phase1-complete', {
      discoveredUrls: state.discoveredUrls,
      pagesTotal: state.pagesTotal,
    });

    // Phase 2: start SSE analysis with the discovered URL list
    L.info('phase1', '=== PHASE 1 END === Handing off to Phase 2');
    runPhase2(url, state.discoveredUrls);
  }

  // ── Phase 2: SSE Analysis ──────────────────────────────────
  function runPhase2(url, urls) {
    L.info('phase2', `=== PHASE 2 START === SSE analysis for ${urls.length} URL(s)`);
    const urlsParam = encodeURIComponent(JSON.stringify(urls));
    const endpoint = `${CONFIG.apiBase}/analyse?url=${encodeURIComponent(url)}&urls=${urlsParam}&${contactParams()}`;
    L.debug('phase2', `SSE endpoint: ${endpoint}`);
    connectSSE(endpoint, url);
  }

  // ── Progress Steps ─────────────────────────────────────────
  function resetProgressSteps() {
    L.debug('steps', 'Resetting all progress steps');
    STEPS.forEach((step) => {
      const icon = $(`icon-${step}`);
      const label = $(`label-${step}`);
      const detail = $(`detail-${step}`);
      if (icon) icon.className = 'step-icon pending';
      if (label) label.className = 'step-label';
      if (detail) detail.textContent = '';
    });
    // Reset step numbers (icon was replaced with checkmark previously)
    STEPS.forEach((step, i) => {
      const icon = $(`icon-${step}`);
      if (icon) icon.textContent = i + 1;
    });
    els.progressBar.style.width = '0%';
    els.progressTime.textContent = '';
  }

  function setStepState(stepName, stepState, detail) {
    const icon = $(`icon-${stepName}`);
    const label = $(`label-${stepName}`);
    const detailEl = $(`detail-${stepName}`);

    if (!icon) {
      L.warn('steps', `Step icon not found for "${stepName}"`);
      return;
    }

    L.debug('steps', `${stepName}: ${stepState}${detail ? ' — ' + detail : ''}`);

    icon.className = `step-icon ${stepState}`;
    label.className = `step-label ${stepState}`;

    if (stepState === 'done') {
      icon.textContent = '\u2713';
    } else if (stepState === 'error') {
      icon.textContent = '!';
    } else if (stepState === 'active') {
      // keep number
    }

    if (detail !== undefined) {
      detailEl.textContent = detail;
    }

    // Update progress bar
    const doneCount = STEPS.filter((s) => {
      const el = $(`icon-${s}`);
      return el && el.classList.contains('done');
    }).length;
    const pct = Math.round((doneCount / STEPS.length) * 100);
    els.progressBar.style.width = `${pct}%`;
    L.trace('steps', `Progress: ${doneCount}/${STEPS.length} (${pct}%)`);

    updateTimeEstimate();
  }

  function updateTimeEstimate() {
    if (!state.startTime) return;
    const elapsed = Math.round((Date.now() - state.startTime) / 1000);
    const min = Math.floor(elapsed / 60);
    const sec = elapsed % 60;
    els.progressTime.textContent = min > 0 ? `${min}m ${sec}s elapsed` : `${sec}s elapsed`;
  }

  function showBannerWarning(msg) {
    L.warn('ui', `Warning banner: "${msg}"`);
    els.bannerWarning.textContent = msg;
    els.bannerWarning.classList.remove('hidden');
  }

  // ── SSE Connection ─────────────────────────────────────────
  function connectSSE(endpoint, url) {
    if (state.eventSource) {
      L.info('sse', 'Closing previous EventSource before reconnect');
      state.eventSource.close();
    }

    L.traceSSEOpen(endpoint);
    state.eventSource = new EventSource(endpoint);

    state.eventSource.onopen = () => {
      L.info('sse', 'EventSource connection opened', { readyState: state.eventSource.readyState });
    };

    // step events — direct mapping to UI
    state.eventSource.addEventListener('step', (e) => {
      try {
        const data = JSON.parse(e.data);
        L.traceSSE('step', data);
        // skip crawl step — we handled it in Phase 1
        if (data.step === 'crawl') {
          L.debug('sse', 'Skipping crawl step event (handled in Phase 1)');
          return;
        }
        setStepState(data.step, data.state, data.detail);
        if (data.jobId) {
          state.jobId = data.jobId;
          L.debug('sse', `Job ID set: ${data.jobId}`);
        }
      } catch (err) {
        L.error('sse', 'Failed to parse step event', { raw: e.data, error: err.message });
      }
    });

    // page-done — live per-page counter
    state.eventSource.addEventListener('page-done', (e) => {
      try {
        const data = JSON.parse(e.data);
        state.pagesDone = data.index;
        state.pagesTotal = data.total;

        const shortUrl = (data.url || '')
          .replace(/^https?:\/\//, '')
          .substring(0, 45);

        L.traceSSE('page-done', { index: data.index, total: data.total, url: data.url });

        setStepState('dom', 'active',
          `Analysing page ${data.index} / ${data.total} — ${shortUrl}`
        );
      } catch (err) {
        L.error('sse', 'Failed to parse page-done event', { raw: e.data, error: err.message });
      }
    });

    state.eventSource.addEventListener('complete', (e) => {
      try {
        const data = JSON.parse(e.data);
        const totalTime = state.startTime ? ((Date.now() - state.startTime) / 1000).toFixed(1) : '?';
        L.info('sse', `=== ANALYSIS COMPLETE === reportId: ${data.reportId} (${totalTime}s total)`, data);
        state.reportId = data.reportId;
        state.emailSentThisRun = true;
        cleanup();
        showReport(data);
      } catch (err) {
        L.error('sse', 'Failed to parse complete event', { raw: e.data, error: err.message });
      }
    });

    state.eventSource.addEventListener('error-event', (e) => {
      try {
        const data = JSON.parse(e.data);
        L.error('sse', 'Server error event received', data);
        handleAnalysisError(data);
      } catch (err) {
        L.error('sse', 'Failed to parse error-event', { raw: e.data, error: err.message });
      }
    });

    state.eventSource.addEventListener('warning', (e) => {
      try {
        const data = JSON.parse(e.data);
        L.warn('sse', 'Server warning event', data);
        showBannerWarning(data.message);
      } catch (err) {
        L.error('sse', 'Failed to parse warning event', { raw: e.data, error: err.message });
      }
    });

    state.eventSource.onerror = (e) => {
      L.traceSSEError(endpoint, state.eventSource?.readyState);
      if (state.currentView !== 'progress') {
        L.debug('sse', 'SSE error ignored — not in progress view');
        return;
      }
      state.reconnectCount++;
      L.warn('sse', `SSE error — reconnect attempt ${state.reconnectCount}/${CONFIG.reconnectAttempts}`);

      if (state.reconnectCount <= CONFIG.reconnectAttempts) {
        els.bannerReconnect.classList.remove('hidden');
        state.eventSource.close();
        L.info('sse', `Reconnecting in ${CONFIG.reconnectDelay}ms...`);
        setTimeout(() => {
          els.bannerReconnect.classList.add('hidden');
          connectSSE(endpoint, url);
        }, CONFIG.reconnectDelay);
      } else {
        L.error('sse', 'Max reconnect attempts reached — giving up');
        cleanup();
        els.bannerReconnect.classList.add('hidden');
        els.bannerError.innerHTML =
          'Connection lost and could not reconnect. <a href="#" id="btn-retry">Retry</a>';
        els.bannerError.classList.remove('hidden');
        $('btn-retry')?.addEventListener('click', (ev) => {
          ev.preventDefault();
          L.info('ui', 'User clicked retry after connection failure');
          runPhase1(state.url);
        });
      }
    };
  }

  function handleAnalysisError(data) {
    L.error('analysis', 'Analysis error handler called', data);
    cleanup();

    const messages = {
      timeout: 'Crawl timed out — the site may be blocking crawlers.',
      zero_pages: "We couldn't access this site. It may require login or block automated access.",
      quota: 'Analysis unavailable right now, try again shortly.',
    };

    const msg = messages[data.code] || data.message || 'An unexpected error occurred.';
    L.error('analysis', `Error message: "${msg}" (code: ${data.code || 'none'})`);

    if (data.partial && data.reportId) {
      L.warn('analysis', 'Partial results available — showing report with warning');
      state.reportId = data.reportId;
      state.emailSentThisRun = true;
      showReport({ reportId: data.reportId, partial: true, warning: msg });
    } else {
      L.error('analysis', 'No partial results — showing error banner');
      els.bannerError.innerHTML = `${msg} <a href="#" id="btn-retry">Retry</a>`;
      els.bannerError.classList.remove('hidden');
      $('btn-retry')?.addEventListener('click', (ev) => {
        ev.preventDefault();
        L.info('ui', 'User clicked retry after analysis error');
        runPhase1(state.url);
      });
    }
  }

  function cancelAnalysis() {
    L.info('ui', 'User cancelled analysis', { jobId: state.jobId, elapsed: state.startTime ? Date.now() - state.startTime : 0 });
    cleanup();
    if (state.jobId) {
      L.info('cancel', `Sending cancel request for job ${state.jobId}`);
      fetch(`${CONFIG.apiBase}/cancel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId: state.jobId }),
      }).catch((err) => {
        L.warn('cancel', 'Cancel request failed (best effort)', { error: err.message });
      });
    }
    showView('landing');
    els.btnAnalyse.disabled = false;
  }

  function cleanup() {
    L.debug('cleanup', 'Running cleanup');
    if (state.eventSource) {
      L.debug('cleanup', 'Closing EventSource');
      state.eventSource.close();
      state.eventSource = null;
    }
    if (state.reassuranceTimer) {
      L.debug('cleanup', 'Clearing reassurance timer');
      clearTimeout(state.reassuranceTimer);
      state.reassuranceTimer = null;
    }
  }

  // ── Report View ────────────────────────────────────────────
  function showReport(data) {
    L.info('report', 'Showing report view', data);
    showView('report');

    const today = new Date().toLocaleDateString('en-AU', {
      day: '2-digit', month: 'short', year: 'numeric',
    });

    els.reportDomainLabel.textContent = state.domain;
    els.reportDateBadge.textContent = today;
    if (els.navMeta) els.navMeta.textContent = `${today} · ${state.domain}`;

    if (state.emailSentThisRun && state.contact?.email) {
      els.reportEmailSent.textContent = `Report sent to ${state.contact.email}`;
      els.reportEmailSent.classList.remove('hidden');
    } else {
      els.reportEmailSent.classList.add('hidden');
    }

    const reportUrl = `${CONFIG.apiBase}/report/${data.reportId}`;
    L.info('report', `Loading report iframe: ${reportUrl}`);
    els.reportFrame.src = reportUrl;

    if (data.partial && data.warning) {
      L.warn('report', `Partial results warning: "${data.warning}"`);
      els.reportWarningBar.textContent = data.warning;
      els.reportWarningBar.classList.remove('hidden');
    } else {
      els.reportWarningBar.classList.add('hidden');
    }
  }

  // ── Share ──────────────────────────────────────────────────
  async function openShareModal() {
    if (!state.reportId) {
      L.warn('share', 'Share clicked but no reportId in state');
      return;
    }

    L.info('share', `Opening share modal for report ${state.reportId}`);

    try {
      const res = await fetch(`${CONFIG.apiBase}/share`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reportId: state.reportId }),
      });

      if (res.ok) {
        const data = await res.json();
        L.info('share', 'Share link created', data);
        els.shareLinkInput.value = data.url;
        const expiry = new Date(data.expiresAt);
        els.shareMeta.textContent = `Link expires ${expiry.toLocaleDateString('en-AU', {
          day: 'numeric', month: 'short', year: 'numeric',
        })}`;
      } else {
        L.warn('share', `Share API returned ${res.status} — using fallback URL`);
        els.shareLinkInput.value = `${window.location.origin}/report/${state.reportId}`;
        els.shareMeta.textContent = `Link expires in ${CONFIG.shareLinkExpiryDays} days`;
      }
    } catch (err) {
      L.error('share', 'Share API error — using fallback URL', { error: err.message });
      els.shareLinkInput.value = `${window.location.origin}/report/${state.reportId}`;
      els.shareMeta.textContent = `Link expires in ${CONFIG.shareLinkExpiryDays} days`;
    }

    els.btnCopy.textContent = 'Copy';
    els.btnCopy.classList.remove('copied');
    els.shareModal.classList.add('active');
  }

  function copyShareLink() {
    const input = els.shareLinkInput;
    input.select();
    L.info('share', `Copying share link: ${input.value}`);
    navigator.clipboard.writeText(input.value).then(() => {
      L.info('share', 'Link copied to clipboard');
      els.btnCopy.textContent = 'Copied!';
      els.btnCopy.classList.add('copied');
      setTimeout(() => {
        els.btnCopy.textContent = 'Copy';
        els.btnCopy.classList.remove('copied');
      }, 2000);
    }).catch((err) => {
      L.error('share', 'Clipboard write failed', { error: err.message });
    });
  }

  function closeShareModal() {
    L.debug('share', 'Share modal closed');
    els.shareModal.classList.remove('active');
  }

  // ── Download PDF ───────────────────────────────────────────
  function downloadPdf() {
    L.info('pdf', `Download PDF triggered for report ${state.reportId}`);
    // Open report in a new tab so mermaid renders, then trigger print
    const reportUrl = `${CONFIG.apiBase}/report/${state.reportId}`;
    const printWin = window.open(reportUrl, '_blank');
    if (printWin) {
      printWin.addEventListener('load', () => {
        // Give mermaid a moment to render SVG before printing
        setTimeout(() => {
          printWin.print();
          L.info('pdf', 'Print dialog opened in new tab');
        }, 1500);
      });
    } else {
      // Popup blocked — fall back to iframe print
      L.warn('pdf', 'Popup blocked — falling back to iframe print');
      try {
        els.reportFrame.contentWindow.print();
      } catch (err) {
        L.warn('pdf', 'iframe print also failed', { error: err.message });
        window.open(reportUrl, '_blank');
      }
    }
  }

  // ── Event Bindings ─────────────────────────────────────────
  els.urlForm.addEventListener('submit', handleSubmit);

  els.urlInput.addEventListener('input', () => {
    clearFormError();
    els.formWarning.classList.add('hidden');
    els.formCached.classList.add('hidden');
  });

  els.btnWarningCancel.addEventListener('click', () => {
    L.debug('ui', 'User cancelled SC warning');
    els.formWarning.classList.add('hidden');
    els.btnAnalyse.disabled = false;
    els.urlInput.focus();
  });

  els.btnWarningContinue.addEventListener('click', () => {
    L.info('ui', 'User chose to continue despite SC warning');
    els.formWarning.classList.add('hidden');
    runPhase1(state.url);
  });

  els.btnCachedLoad.addEventListener('click', () => {
    L.info('ui', 'User chose to load cached report');
    els.formCached.classList.add('hidden');
    checkCachedReport(state.url).then((data) => {
      if (data && data.reportId) {
        state.reportId = data.reportId;
        showReport({ reportId: data.reportId });
      }
    });
  });

  els.btnCachedRerun.addEventListener('click', () => {
    L.info('ui', 'User chose to re-run analysis (ignoring cache)');
    els.formCached.classList.add('hidden');
    runPhase1(state.url);
  });

  els.btnCancel.addEventListener('click', cancelAnalysis);

  els.btnNewAnalysis.addEventListener('click', () => {
    L.info('ui', 'User started new analysis');
    showView('landing');
    els.urlInput.value = '';
    els.btnAnalyse.disabled = false;
    els.urlInput.focus();
  });

  els.btnShare.addEventListener('click', openShareModal);
  els.btnCopy.addEventListener('click', copyShareLink);
  els.btnCloseModal.addEventListener('click', closeShareModal);

  els.shareModal.addEventListener('click', (e) => {
    if (e.target === els.shareModal) closeShareModal();
  });

  els.btnDownload.addEventListener('click', downloadPdf);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && els.shareModal.classList.contains('active')) {
      closeShareModal();
    }
  });

  // ── Elapsed time ticker ────────────────────────────────────
  setInterval(() => {
    if (state.currentView === 'progress' && state.startTime) {
      updateTimeEstimate();
    }
  }, 1000);

  // ── Init ───────────────────────────────────────────────────
  showView('landing');
  if (els.navMeta) els.navMeta.textContent = new Date().toLocaleDateString('en-AU', {
    day: '2-digit', month: 'short', year: 'numeric',
  });

  L.info('app', '=== Site Analyser frontend initialised ===');
  L.info('app', `API base: ${CONFIG.apiBase}`);
  L.info('app', `User-Agent: ${navigator.userAgent}`);

})();
