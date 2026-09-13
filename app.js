// ============================================================
// CricTracker — Frontend App
// ============================================================

const APP_VERSION = '1.1.5';

function haptic(pattern) {
  try { if (navigator.vibrate) navigator.vibrate(pattern); } catch (e) {}
}
const HAPTIC = { tick: 10, confirm: 30, success: [50, 30, 50] };

let _appBusyDepth = 0;

function setAppBusy(active, message = 'Loading…') {
  const overlay = document.getElementById('app-busy');
  const text = document.getElementById('app-busy-text');
  const app = document.getElementById('app');
  if (!overlay) return;
  if (active) {
    _appBusyDepth++;
    if (text) text.textContent = message;
    overlay.hidden = false;
    overlay.setAttribute('aria-busy', 'true');
    app?.classList.add('app-is-busy');
  } else {
    _appBusyDepth = Math.max(0, _appBusyDepth - 1);
    if (_appBusyDepth === 0) {
      overlay.hidden = true;
      overlay.setAttribute('aria-busy', 'false');
      app?.classList.remove('app-is-busy');
    }
  }
}

function clearAppBusy() {
  _appBusyDepth = 0;
  const overlay = document.getElementById('app-busy');
  const app = document.getElementById('app');
  if (overlay) {
    overlay.hidden = true;
    overlay.setAttribute('aria-busy', 'false');
  }
  app?.classList.remove('app-is-busy');
}

async function withBusy(message, fn) {
  setAppBusy(true, message);
  try {
    return await fn();
  } finally {
    setAppBusy(false);
  }
}

function setBtnBusy(btn, active, busyText, idleText) {
  if (!btn) return;
  btn.disabled = active;
  if (busyText && idleText) btn.textContent = active ? busyText : idleText;
}

const API_URL = (typeof CRICKET_API_URL !== 'undefined') ? CRICKET_API_URL : '';
const WRITE_ACTIONS = new Set(['removePlayer', 'lockMatch', 'deleteMatch', 'setPlayerAmount', 'renamePlayer', 'deletePlayer']);
const UPI_VPA_RE = /^[\w.\-]{2,}@[a-z]{2,}$/i;
const UPI_PHONE_RE = /^\d{10}$/;

function isValidPayInput(raw) {
  const value = raw.trim();
  return UPI_VPA_RE.test(value) || UPI_PHONE_RE.test(value);
}

// --- State ---
let currentMatchId = null;
let _currentMatch = null;
let _costSaveTimer = null;
let _lastPersistedCost = null;
let _costBlockedValue = null;
let _loadGeneration = 0;
let _knownPlayers = [];
let _knownPlayersPromise = null;
let _suggestionIndex = -1;
let _payToSuggestionIndex = -1;
let _writeToken = null;
let _canWrite = true;
const _markPaidPending = new Set();
let _checkInPending = false;
const _pickerSelectedMatch = new Set();
const _pickerSelectedNew = new Set();
let _matchListCache = null;
let _matchListCacheTime = 0;
const MATCH_LIST_CACHE_MS = 15000;
let _warmMatchesPromise = null;
let _playersCacheTime = 0;
const PLAYERS_CACHE_MS = 30000;
const _matchDetailCache = {};
const MATCH_DETAIL_CACHE_MS = 15000;
const PAID_UNDO_TOAST_MS = 8000;
const IS_MOBILE = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

function debounce(fn, ms) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

function writeTokenKey(matchId) {
  return 'w_' + matchId;
}

function getWriteToken(matchId) {
  if (!matchId) return null;
  if (_writeToken && currentMatchId === matchId) return _writeToken;
  try {
    return localStorage.getItem(writeTokenKey(matchId))
      || sessionStorage.getItem(writeTokenKey(matchId))
      || null;
  } catch (e) {
    return null;
  }
}

const ADMIN_BYPASS_KEY = 'admin_bypass';

function storeAdminBypass(token) {
  if (!token) return;
  try {
    localStorage.setItem(ADMIN_BYPASS_KEY, token);
  } catch (e) {}
  try {
    sessionStorage.setItem(ADMIN_BYPASS_KEY, token);
  } catch (e) {}
}

function clearAdminBypass() {
  try {
    localStorage.removeItem(ADMIN_BYPASS_KEY);
  } catch (e) {}
  try {
    sessionStorage.removeItem(ADMIN_BYPASS_KEY);
  } catch (e) {}
}

function getAdminBypass() {
  try {
    return localStorage.getItem(ADMIN_BYPASS_KEY)
      || sessionStorage.getItem(ADMIN_BYPASS_KEY)
      || null;
  } catch (e) {
    try {
      return sessionStorage.getItem(ADMIN_BYPASS_KEY) || null;
    } catch (e2) {
      return null;
    }
  }
}

function updateAdminButton() {
  const btn = document.getElementById('btn-admin');
  if (!btn) return;
  if (getAdminBypass()) {
    btn.style.display = '';
    btn.textContent = 'Organizer ✓';
    btn.classList.add('btn-admin-active');
    btn.title = 'Organizer — tap to log out';
    btn.setAttribute('aria-label', 'Organizer logged in');
  } else {
    btn.style.display = '';
    btn.textContent = 'Organizer';
    btn.classList.remove('btn-admin-active');
    btn.title = 'Organizer login';
    btn.setAttribute('aria-label', 'Organizer login');
  }
  updateStatsAddPlayerVisibility();
  updateNewMatchFabVisibility();
}

function updateStatsAddPlayerVisibility() {
  const el = document.getElementById('stats-add-player');
  if (el) el.style.display = getAdminBypass() ? '' : 'none';
}

function updateNewMatchFabVisibility() {
  const fab = document.getElementById('fab-new-match');
  if (fab) fab.style.display = getAdminBypass() ? '' : 'none';
}

function openAdminModal() {
  const modal = document.getElementById('admin-modal');
  const form = document.getElementById('admin-login-form');
  const loggedIn = document.getElementById('admin-logged-in');
  if (!modal) return;

  const isAdmin = !!getAdminBypass();
  if (form) form.style.display = isAdmin ? 'none' : '';
  if (loggedIn) loggedIn.style.display = isAdmin ? '' : 'none';

  if (!isAdmin) {
    const userInput = document.getElementById('admin-username');
    const passInput = document.getElementById('admin-password');
    if (userInput) userInput.value = '';
    if (passInput) passInput.value = '';
    clearAdminLoginError();
  }

  if (!modal.open) modal.showModal();
  if (!isAdmin) {
    const userInput = document.getElementById('admin-username');
    if (userInput) setTimeout(() => userInput.focus(), 50);
  }
}

function closeAdminModal() {
  const modal = document.getElementById('admin-modal');
  if (modal && modal.open) modal.close();
}

function showAdminLoginError(msg) {
  const el = document.getElementById('admin-login-error');
  if (el) {
    el.textContent = msg;
    el.style.display = msg ? '' : 'none';
  }
  if (msg) showToast(msg, 'error');
}

function clearAdminLoginError() {
  showAdminLoginError('');
  const userInput = document.getElementById('admin-username');
  const passInput = document.getElementById('admin-password');
  if (userInput) userInput.classList.remove('input-error');
  if (passInput) passInput.classList.remove('input-error');
}

function getAdminGateConfig() {
  const user = (typeof CRICKET_ADMIN_USER !== 'undefined' && CRICKET_ADMIN_USER)
    ? CRICKET_ADMIN_USER : 'durga';
  const pass = (typeof CRICKET_ADMIN_PASSWORD !== 'undefined' && CRICKET_ADMIN_PASSWORD)
    ? CRICKET_ADMIN_PASSWORD : 'petals';
  const token = (typeof CRICKET_ADMIN_TOKEN !== 'undefined' && CRICKET_ADMIN_TOKEN)
    ? CRICKET_ADMIN_TOKEN : 'admin_009';
  return { user, pass, token };
}

function finishAdminLogin(token) {
  storeAdminBypass(token);
  updateModeBadge();
  updateAdminButton();
  haptic(HAPTIC.success);
  showToast('Organizer mode on — stays signed in on this device');
  closeAdminModal();
  if (currentMatchId) loadMatch(currentMatchId, { silent: true });
  else if (document.getElementById('view-stats')?.style.display !== 'none') loadStats();
}

async function submitAdminLogin() {
  const userInput = document.getElementById('admin-username');
  const passInput = document.getElementById('admin-password');
  const btn = document.getElementById('admin-login-btn');
  if (!userInput || !passInput || !btn) return;

  const username = userInput.value.trim();
  const password = passInput.value;
  clearAdminLoginError();

  if (!username && !password) {
    return showAdminLoginError('Enter username and password');
  }
  if (!username) {
    userInput.classList.add('input-error');
    return showAdminLoginError('Enter your username');
  }
  if (!password) {
    passInput.classList.add('input-error');
    return showAdminLoginError('Enter your password');
  }

  setBtnBusy(btn, true, 'Logging in…', 'Log in');
  setAppBusy(true, 'Logging in…');

  const gate = getAdminGateConfig();
  function endLoginBusy() {
    setAppBusy(false);
    setBtnBusy(btn, false, 'Logging in…', 'Log in');
  }

  const userOk = username.toLowerCase() === gate.user.toLowerCase();
  const passOk = password.toLowerCase() === gate.pass.toLowerCase();

  function failLogin(message, highlight = 'both') {
    endLoginBusy();
    if (highlight === 'user' || highlight === 'both') userInput.classList.add('input-error');
    if (highlight === 'pass' || highlight === 'both') passInput.classList.add('input-error');
    showAdminLoginError(message);
  }

  try {
    // Client gate (durga/petals) — works even if server has no adminLogin action
    if (userOk && passOk) {
      const check = await api('validateAdmin', { token: gate.token }, 'POST');
      if (check.error) {
        return failLogin('Network error — check connection and try again', 'both');
      }
      if (check.valid) {
        endLoginBusy();
        finishAdminLogin(gate.token);
        return;
      }
      return failLogin('Credentials OK but server rejected login — contact admin', 'both');
    }

    if (!userOk && passOk) {
      return failLogin('Wrong username — check spelling (organizers only)', 'user');
    }
    if (userOk && !passOk) {
      return failLogin('Wrong password — check spelling and try again', 'pass');
    }

    const direct = await api('validateAdmin', { token: password }, 'POST');
    if (direct.valid && userOk) {
      endLoginBusy();
      finishAdminLogin(password);
      return;
    }

    const data = await api('adminLogin', { username, password }, 'POST');
    if (data.success && data.token) {
      endLoginBusy();
      finishAdminLogin(data.token);
      return;
    }

    if (data.error && data.error.includes('Invalid username or password')) {
      return failLogin('Wrong username or password', 'both');
    }
    if (data.error && !data.error.includes('Unknown action')) {
      return failLogin(data.error, 'both');
    }
    return failLogin('Wrong username or password — organizers only', 'both');
  } catch (e) {
    failLogin('Network error — try again', 'both');
  }
}

function logoutAdmin() {
  if (!confirm('Log out of organizer mode?\n\nYou can sign in again anytime via ℹ → Organizer login.')) {
    return;
  }
  clearAdminBypass();
  updateModeBadge();
  updateAdminButton();
  closeAdminModal();
  showToast('Logged out — ℹ → Organizer login to manage matches');
  const hash = window.location.hash || '#/';
  if (hash === '#/stats' || hash === '#/new') {
    navigate('#/');
    return;
  }
  if (currentMatchId) loadMatch(currentMatchId, { silent: true });
}

function hasWriteAccess() {
  return !!getAdminBypass();
}

function getAuthToken(matchId) {
  return getWriteToken(matchId) || getAdminBypass();
}

/** Undo uses admin bypass already accepted by validateWriteToken on the live server — no Code.gs deploy. */
function getUndoAuthToken(matchId) {
  return getAdminBypass() || getAuthToken(matchId) || getAdminGateConfig().token || null;
}

function storeWriteToken(matchId, token) {
  if (!matchId || !token) return;
  _writeToken = token;
  try {
    localStorage.setItem(writeTokenKey(matchId), token);
    sessionStorage.setItem(writeTokenKey(matchId), token);
  } catch (e) {}
}

function buildMatchHash(matchId) {
  const id = encodeURIComponent(matchId);
  const w = getWriteToken(matchId);
  return w ? `#/match/${id}?w=${encodeURIComponent(w)}` : `#/match/${id}`;
}

function parseMatchRoute(hash) {
  const rest = (hash || '').replace(/^#\/match\//, '');
  const [idPart, query] = rest.split('?');
  const matchId = decodeURIComponent((idPart || '').split('#')[0]).replace(/\/+$/, '');
  let writeToken = null;
  let adminBypass = null;
  if (query) {
    const qs = new URLSearchParams(query);
    writeToken = qs.get('w');
    adminBypass = qs.get('a');
  }
  return { matchId, writeToken, adminBypass };
}

// --- API Helper ---
async function api(action, params = {}, method = 'GET', opts = {}) {
  if (!API_URL || API_URL.includes('YOUR_APPS_SCRIPT')) {
    return { error: 'Backend not configured. Copy config.example.js to config.js and set your Apps Script URL.' };
  }
  try {
    let payload = { ...params };
    if (method === 'POST' && WRITE_ACTIONS.has(action) && payload.matchId) {
      const token = payload.writeToken || getAuthToken(payload.matchId);
      if (token) payload.writeToken = token;
    }
    let resp;
    if (method === 'GET') {
      const qs = new URLSearchParams({ action, ...payload }).toString();
      resp = await fetch(`${API_URL}?${qs}`, { redirect: 'follow' });
    } else {
      resp = await fetch(API_URL, {
        method: 'POST',
        redirect: 'follow',
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify({ action, ...payload })
      });
    }
    const text = await resp.text();
    try { return JSON.parse(text); }
    catch (e) { return { error: 'Server returned invalid response' }; }
  } catch (err) {
    console.error('API error:', err);
    if (!opts.silent) showToast('Network error. Please try again.', 'error');
    return { error: err.message };
  }
}

// --- Routing ---
function navigate(hash) {
  window.location.hash = hash;
}

function goBack() {
  goHome();
}

function goHome() {
  navigate('#/');
}

function setPageTitle(text) {
  const el = document.getElementById('page-title-text');
  if (el) el.textContent = text;
}

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function warmApiContainer() {
  if (!API_URL || API_URL.includes('YOUR_APPS_SCRIPT')) return Promise.resolve();
  if (_matchListCache && Date.now() - _matchListCacheTime < MATCH_LIST_CACHE_MS) {
    return Promise.resolve();
  }
  if (_warmMatchesPromise) return _warmMatchesPromise;
  _warmMatchesPromise = (async () => {
    try {
      const resp = await fetch(`${API_URL}?action=matches`, { redirect: 'follow' });
      const data = JSON.parse(await resp.text());
      if (data.matches) {
        _matchListCache = data.matches;
        _matchListCacheTime = Date.now();
      }
    } catch (e) {}
    finally {
      _warmMatchesPromise = null;
    }
  })();
  return _warmMatchesPromise;
}

function initSplash() {
  warmApiContainer();

  const splash = document.getElementById('splash');
  const app = document.getElementById('app');
  if (!splash) {
    if (app) app.classList.add('app-ready');
    return;
  }

  try {
    if (sessionStorage.getItem('splash_seen')) {
      splash.remove();
      app.classList.add('app-ready');
      return;
    }
  } catch (e) {}

  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    try { sessionStorage.setItem('splash_seen', '1'); } catch (e) {}
    splash.remove();
    app.classList.add('app-ready');
    return;
  }

  const minMs = 500;
  const maxMs = 2500;
  const start = Date.now();
  let finished = false;

  function finish() {
    if (finished) return;
    finished = true;
    const wait = Math.max(0, minMs - (Date.now() - start));
    setTimeout(() => {
      try { sessionStorage.setItem('splash_seen', '1'); } catch (e) {}
      splash.classList.add('splash-exit');
      app.classList.add('app-ready');
      const removeSplash = () => { if (splash.parentNode) splash.remove(); };
      splash.addEventListener('transitionend', removeSplash, { once: true });
      setTimeout(removeSplash, 450);
    }, wait);
  }

  if (document.readyState === 'complete') {
    finish();
  } else {
    window.addEventListener('load', finish, { once: true });
  }
  setTimeout(finish, maxMs);
}

function updateModeBadge() {
  const badge = document.getElementById('mode-badge');
  if (!badge) return;

  const isGlobalAdmin = !!getAdminBypass();

  if (isGlobalAdmin) {
    badge.style.display = 'none';
    updateAdminButton();
    return;
  }

  badge.style.display = 'none';
  updateAdminButton();
}

async function handleRoute() {
  closeInfoModal();
  closeShareMenu();
  clearTimeout(_costSaveTimer);
  _loadGeneration++;

  const hash = window.location.hash || '#/';

  // Admin token validation — runs before any view transition
  if (hash.startsWith('#/admin_')) {
    const token = hash.replace(/^#\//, '');
    const check = await api('validateAdmin', { token }, 'POST');
    if (check.valid) {
      storeAdminBypass(token);
      updateModeBadge();
      showToast('Admin mode on — open any match');
    } else {
      showToast('Invalid admin token', 'error');
    }
    navigate('#/');
    return;
  }

  const applyRoute = () => {
    clearAppBusy();
    if (!hash.startsWith('#/match/')) currentMatchId = null;
    const views = document.querySelectorAll('.view');
    views.forEach(v => { v.style.display = 'none'; v.classList.remove('view-enter'); });

    const backBtn = document.getElementById('btn-back');
    const statsBtn = document.getElementById('btn-stats');

    backBtn.style.display = 'none';
    statsBtn.style.display = '';
    setPageTitle('CricTracker');

    hideSuggestions();
    updateModeBadge();

    let activeView;
    if (hash === '#/' || hash === '#' || hash === '') {
      activeView = document.getElementById('view-home');
      activeView.style.display = '';
      loadMatches();
    } else if (hash === '#/new') {
      if (!getAdminBypass()) {
        showToast('Admin login required to create matches', 'error');
        activeView = document.getElementById('view-home');
        activeView.style.display = '';
        loadMatches();
        history.replaceState(null, '', '#/');
      } else {
        activeView = document.getElementById('view-new');
        activeView.style.display = '';
        backBtn.style.display = '';
        setPageTitle('New Match');
        document.getElementById('match-date').value = todayISO();
        document.getElementById('pay-to').value = '';
        document.getElementById('pay-upi').value = '';
        hidePayToSuggestions();
        const costField = document.getElementById('new-match-cost');
        if (costField) costField.value = '';
        const accentPicker = document.getElementById('accent-picker');
        if (accentPicker) {
          accentPicker.querySelectorAll('.accent-swatch').forEach(s => s.classList.remove('active'));
          accentPicker.querySelector('[data-color=""]')?.classList.add('active');
        }
        _pickerSelectedNew.clear();
        renderNewMatchPickerTags();
        ensureKnownPlayers();
      }
    } else if (hash.startsWith('#/match/')) {
      activeView = document.getElementById('view-match');
      activeView.style.display = '';
      backBtn.style.display = '';
      setPageTitle('Match');
      const route = parseMatchRoute(hash);
      currentMatchId = route.matchId;
      if (route.adminBypass) storeAdminBypass(route.adminBypass);
      if (route.writeToken) {
        storeWriteToken(route.matchId, route.writeToken);
      } else if (!getAdminBypass()) {
        const stored = getWriteToken(route.matchId);
        if (stored) history.replaceState(null, '', buildMatchHash(route.matchId));
      }
      loadMatch(currentMatchId);
    } else if (hash === '#/stats') {
      activeView = document.getElementById('view-stats');
      activeView.style.display = '';
      backBtn.style.display = '';
      statsBtn.style.display = 'none';
      setPageTitle('Player Stats');
      loadStats();
    } else {
      activeView = document.getElementById('view-home');
      activeView.style.display = '';
      loadMatches();
    }

    if (activeView) {
      requestAnimationFrame(() => activeView.classList.add('view-enter'));
    }
  };

  if (document.startViewTransition) {
    document.startViewTransition(applyRoute);
  } else {
    applyRoute();
  }
}

window.addEventListener('hashchange', handleRoute);
window.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden' && _costSaveTimer) {
    clearTimeout(_costSaveTimer);
    _costSaveTimer = null;
    saveCost();
  }
});
function applyAppVersion() {
  const label = `v${APP_VERSION}`;
  const infoVer = document.getElementById('info-version');
  const creditVer = document.getElementById('credit-version');
  if (infoVer) infoVer.textContent = label;
  if (creditVer) creditVer.textContent = label;
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register(`./sw.js?v=${encodeURIComponent(APP_VERSION)}`).catch(() => {});
}

window.addEventListener('DOMContentLoaded', () => {
  applyAppVersion();
  registerServiceWorker();
  setupEventDelegation();
  setupCheckinInput();
  setupPayToInput();
  initCheckinTabBar();
  initSplash();
  updateAdminButton();
  handleRoute();

  // iOS Safari back-forward cache: refresh organizer/FAB state after swipe-back
  window.addEventListener('pageshow', (e) => {
    if (e.persisted) updateAdminButton();
  });

  const adminPassword = document.getElementById('admin-password');
  if (adminPassword) {
    adminPassword.addEventListener('input', clearAdminLoginError);
    adminPassword.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); submitAdminLogin(); }
    });
  }
  const adminUsername = document.getElementById('admin-username');
  if (adminUsername) adminUsername.addEventListener('input', clearAdminLoginError);
  if (adminUsername) adminUsername.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const pass = document.getElementById('admin-password');
      if (pass) pass.focus();
    }
  });

  const renameInput = document.getElementById('rename-input');
  if (renameInput) renameInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); confirmRenamePlayer(); }
  });

  const addPlayerInput = document.getElementById('add-player-input');
  if (addPlayerInput) addPlayerInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); submitAddPlayer(); }
    if (e.key === 'Escape') { e.preventDefault(); toggleAddPlayerForm(); }
  });

  // Native <dialog> handles Escape via 'cancel' event; add backdrop click-to-close
  document.querySelectorAll('dialog.modal-dialog').forEach(dialog => {
    dialog.addEventListener('click', e => {
      if (e.target === dialog) dialog.close();
    });
  });

  // Accent color picker
  const accentPicker = document.getElementById('accent-picker');
  if (accentPicker) {
    accentPicker.addEventListener('click', e => {
      const swatch = e.target.closest('.accent-swatch');
      if (!swatch) return;
      accentPicker.querySelectorAll('.accent-swatch').forEach(s => s.classList.remove('active'));
      swatch.classList.add('active');
    });
  }

  // Long-press to toggle paid (600ms hold)
  let _lpTimer = null;
  document.addEventListener('pointerdown', e => {
    const item = e.target.closest('.player-item');
    if (!item || item.dataset.canToggle !== 'true') return;
    if (e.target.closest('.player-remove, .player-amount-input, .player-name-editable')) return;
    _lpTimer = setTimeout(() => {
      _lpTimer = null;
      haptic(HAPTIC.confirm);
      const name = item.dataset.playerName;
      const newPaid = item.dataset.paid !== 'true';
      togglePaid(item, name, newPaid);
    }, 600);
  });
  document.addEventListener('pointerup', () => { if (_lpTimer) { clearTimeout(_lpTimer); _lpTimer = null; } });
  document.addEventListener('pointercancel', () => { if (_lpTimer) { clearTimeout(_lpTimer); _lpTimer = null; } });
  document.addEventListener('pointermove', e => {
    if (_lpTimer && (Math.abs(e.movementX) > 3 || Math.abs(e.movementY) > 3)) {
      clearTimeout(_lpTimer); _lpTimer = null;
    }
  });
});

// --- Event Delegation (replaces inline onclick for security) ---
function setupEventDelegation() {
  const playerList = document.getElementById('player-list');
  if (playerList) {
    playerList.addEventListener('click', (e) => {
      const nameSpan = e.target.closest('.player-name-editable');
      if (nameSpan && nameSpan.dataset.renameName) {
        openRenameModal(nameSpan.dataset.renameName, nameSpan.dataset.renameId || '');
        return;
      }

      const item = e.target.closest('.player-item');
      if (!item) return;

      const removeBtn = e.target.closest('.player-remove');
      if (removeBtn) {
        e.stopPropagation();
        const name = removeBtn.dataset.playerName;
        if (name) handleRemovePlayer(name);
        return;
      }

      if (e.target.closest('.player-amount-input, .player-amount-edit-wrap')) return;

      if (item.dataset.canToggle === 'true') {
        const name = item.dataset.playerName;
        const newPaid = item.dataset.paid !== 'true';
        if (name) togglePaid(item, name, newPaid);
      }
    });

    playerList.addEventListener('change', (e) => {
      const input = e.target.closest('.player-amount-input');
      if (!input?.dataset.playerName) return;
      e.stopPropagation();
      handlePlayerAmountChange(input.dataset.playerName, input.value, input);
    });

    playerList.addEventListener('keydown', (e) => {
      if (e.target.closest('.player-amount-input') && e.key === 'Enter') {
        e.preventDefault();
        e.target.blur();
      }
    });
  }

  document.querySelectorAll('input[name="split-mode"]').forEach(radio => {
    radio.addEventListener('change', () => {
      if (radio.checked) handleSplitModeChange(radio.value);
    });
  });

  const matchList = document.getElementById('match-list');
  if (matchList) {
    matchList.addEventListener('click', (e) => {
      const card = e.target.closest('.match-card');
      if (card && card.dataset.matchId) {
        navigate(buildMatchHash(card.dataset.matchId));
      }
    });
  }

  const statsWrap = document.getElementById('stats-table-wrap');
  if (statsWrap) {
    statsWrap.addEventListener('click', (e) => {
      const expandBtn = e.target.closest('.stat-expand-btn');
      if (expandBtn) {
        const card = expandBtn.closest('.stat-card');
        if (card) togglePlayerHistory(expandBtn.dataset.playerId, card);
        return;
      }
      const btn = e.target.closest('[data-rename-name]');
      if (btn) openRenameModal(btn.dataset.renameName, btn.dataset.renameId || '');
    });
  }

  const pickerList = document.getElementById('picker-list');
  if (pickerList) {
    pickerList.addEventListener('click', handlePickerListClick);
  }
}

// --- Check-in Input Setup ---
function setupCheckinInput() {
  const input = document.getElementById('checkin-name');
  if (!input) return;

  input.addEventListener('keydown', (e) => {
    const dropdown = document.getElementById('checkin-suggestions');
    const items = dropdown ? dropdown.querySelectorAll('.suggestion-item') : [];

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      _suggestionIndex = Math.min(_suggestionIndex + 1, items.length - 1);
      updateSuggestionHighlight(items);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      _suggestionIndex = Math.max(_suggestionIndex - 1, -1);
      updateSuggestionHighlight(items);
    } else if (e.key === 'Enter') {
      if (_suggestionIndex >= 0 && items[_suggestionIndex]) {
        e.preventDefault();
        const name = items[_suggestionIndex].dataset.name;
        input.value = name;
        hideSuggestions();
        handleCheckIn();
      } else {
        handleCheckIn();
      }
    } else if (e.key === 'Escape') {
      hideSuggestions();
    }
  });

  const debouncedSuggest = debounce(async () => {
    const q = input.value.trim();
    if (!q) return hideSuggestions();
    await ensureKnownPlayers();
    showSuggestions(q);
  }, 120);

  input.addEventListener('input', () => debouncedSuggest());

  input.addEventListener('focus', () => {
    ensureKnownPlayers().then(() => {
      const q = input.value.trim();
      if (q) showSuggestions(q);
    });
  });

  input.addEventListener('blur', () => {
    setTimeout(hideSuggestions, 200);
  });
}

function setupPayToInput() {
  const input = document.getElementById('pay-to');
  if (!input) return;

  input.addEventListener('keydown', (e) => {
    const dropdown = document.getElementById('payto-suggestions');
    const items = dropdown ? dropdown.querySelectorAll('.suggestion-item') : [];

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      _payToSuggestionIndex = Math.min(_payToSuggestionIndex + 1, items.length - 1);
      updateSuggestionHighlight(items, _payToSuggestionIndex);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      _payToSuggestionIndex = Math.max(_payToSuggestionIndex - 1, -1);
      updateSuggestionHighlight(items, _payToSuggestionIndex);
    } else if (e.key === 'Enter' && _payToSuggestionIndex >= 0 && items[_payToSuggestionIndex]) {
      e.preventDefault();
      input.value = items[_payToSuggestionIndex].dataset.name;
      hidePayToSuggestions();
    } else if (e.key === 'Escape') {
      hidePayToSuggestions();
    }
  });

  const debouncedSuggest = debounce(async () => {
    const q = input.value.trim();
    if (!q) return hidePayToSuggestions();
    await ensureKnownPlayers();
    showPayToSuggestions(q);
  }, 120);

  input.addEventListener('input', () => debouncedSuggest());

  input.addEventListener('focus', () => {
    ensureKnownPlayers().then(() => {
      const q = input.value.trim();
      if (q) showPayToSuggestions(q);
    });
  });

  input.addEventListener('blur', () => {
    setTimeout(hidePayToSuggestions, 200);
  });
}

function nameMatchesQuery(name, queryLower) {
  const n = name.toLowerCase();
  if (queryLower.length < 2) return n.startsWith(queryLower);
  return n.startsWith(queryLower) || n.includes(queryLower);
}

function showSuggestions(query) {
  const dropdown = document.getElementById('checkin-suggestions');
  if (!dropdown || !query || query.length < 1) {
    hideSuggestions();
    return;
  }

  const currentPlayers = (_currentMatch?.players || []).map(p => p.name.toLowerCase());
  const queryLower = query.toLowerCase();
  const matches = _knownPlayers
    .filter(p => nameMatchesQuery(p.name, queryLower) && !currentPlayers.includes(p.name.toLowerCase()))
    .sort((a, b) => b.matches - a.matches || a.name.localeCompare(b.name))
    .slice(0, 6);

  if (matches.length === 0) {
    hideSuggestions();
    return;
  }

  _suggestionIndex = -1;
  dropdown.innerHTML = matches.map(p =>
    `<div class="suggestion-item" data-name="${escapeAttr(p.name)}">` +
    `${escapeHtml(p.name)}` +
    `<span class="suggestion-games">${p.matches} game${p.matches !== 1 ? 's' : ''}</span>` +
    `</div>`
  ).join('');
  dropdown.style.display = '';

  dropdown.querySelectorAll('.suggestion-item').forEach(item => {
    item.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const input = document.getElementById('checkin-name');
      input.value = item.dataset.name;
      hideSuggestions();
      handleCheckIn();
    });
  });
}

function hideSuggestions() {
  const dropdown = document.getElementById('checkin-suggestions');
  if (dropdown) {
    dropdown.style.display = 'none';
    dropdown.innerHTML = '';
  }
  _suggestionIndex = -1;
}

function showPayToSuggestions(query) {
  const dropdown = document.getElementById('payto-suggestions');
  if (!dropdown || !query) {
    hidePayToSuggestions();
    return;
  }

  const queryLower = query.toLowerCase();
  const matches = _knownPlayers
    .filter(p => nameMatchesQuery(p.name, queryLower))
    .sort((a, b) => b.matches - a.matches || a.name.localeCompare(b.name))
    .slice(0, 6);

  if (!matches.length) {
    hidePayToSuggestions();
    return;
  }

  _payToSuggestionIndex = -1;
  dropdown.innerHTML = matches.map(p =>
    `<div class="suggestion-item" data-name="${escapeAttr(p.name)}">` +
    `${escapeHtml(p.name)}` +
    `<span class="suggestion-games">${p.matches} game${p.matches !== 1 ? 's' : ''}</span>` +
    `</div>`
  ).join('');
  dropdown.style.display = '';

  dropdown.querySelectorAll('.suggestion-item').forEach(item => {
    item.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const payInput = document.getElementById('pay-to');
      if (payInput) payInput.value = item.dataset.name;
      hidePayToSuggestions();
    });
  });
}

function hidePayToSuggestions() {
  const dropdown = document.getElementById('payto-suggestions');
  if (dropdown) {
    dropdown.style.display = 'none';
    dropdown.innerHTML = '';
  }
  _payToSuggestionIndex = -1;
}

function updateSuggestionHighlight(items, activeIndex = _suggestionIndex) {
  items.forEach((item, i) => {
    item.classList.toggle('active', i === activeIndex);
  });
}

// --- Fetch Known Players for Autocomplete ---
async function ensureKnownPlayers(force = false) {
  const cacheFresh = _knownPlayers.length > 0 &&
    (Date.now() - _playersCacheTime < PLAYERS_CACHE_MS);
  if (cacheFresh && !force) return;
  if (_knownPlayersPromise && !force) return _knownPlayersPromise;

  _knownPlayersPromise = (async () => {
    const data = await api('players', {}, 'GET', { silent: true });
    if (data.players && Array.isArray(data.players)) {
      _knownPlayers = mergePlayerStats(data.players);
      _playersCacheTime = Date.now();
    }
    refreshOpenPickerModal();
  })();

  try {
    await _knownPlayersPromise;
  } finally {
    _knownPlayersPromise = null;
  }
}

async function fetchKnownPlayers(force = false) {
  return ensureKnownPlayers(force);
}

function normalizePlayerKey(name) {
  return (name || '').toLowerCase().replace(/\s*\(\d+\)$/, '').replace(/\s+/g, ' ').trim();
}

function addKnownPlayerName(name) {
  const key = normalizePlayerKey(name);
  const existing = _knownPlayers.find(p => normalizePlayerKey(p.name) === key);
  if (existing) {
    existing.matches += 1;
    return;
  }
  _knownPlayers.push({ name, playerId: '', matches: 1, totalOwed: 0, totalPaid: 0, outstanding: 0 });
}

// --- Match List ---
function skeletonCards(count) {
  return Array.from({ length: count }, () =>
    `<div class="skeleton-card">
      <div class="skeleton-line w60"></div>
      <div class="skeleton-line w40 h8"></div>
      <div class="skeleton-line w80 h20"></div>
    </div>`
  ).join('');
}

function invalidateMatchListCache(matchId) {
  _matchListCache = null;
  _matchListCacheTime = 0;
  if (matchId) invalidateMatchDetailCache(matchId);
}

function invalidateMatchDetailCache(matchId) {
  if (matchId) delete _matchDetailCache[matchId];
  else Object.keys(_matchDetailCache).forEach(k => delete _matchDetailCache[k]);
}

function invalidatePlayersCache() {
  _playersCacheTime = 0;
}

function matchListFingerprint(matches) {
  return (matches || []).map(m => `${m.matchId}:${m.playerCount || 0}:${m.paidCount || 0}`).join('|');
}

async function loadMatches(force = false) {
  const gen = _loadGeneration;
  const listEl = document.getElementById('match-list');
  const emptyEl = document.getElementById('no-matches');
  const hasCache = !!_matchListCache;
  const cacheFresh = hasCache && (Date.now() - _matchListCacheTime < MATCH_LIST_CACHE_MS);

  if (hasCache) {
    renderMatchList(_matchListCache, listEl, emptyEl);
  } else {
    listEl.innerHTML = skeletonCards(3);
    emptyEl.style.display = 'none';
  }

  if (!force && cacheFresh) return;

  if (!force && !hasCache) await warmApiContainer();
  if (!force && _matchListCache) {
    renderMatchList(_matchListCache, listEl, emptyEl);
    if (Date.now() - _matchListCacheTime < MATCH_LIST_CACHE_MS) return;
  }

  const prevFp = hasCache ? matchListFingerprint(_matchListCache) : '';
  const data = await api('matches');
  if (_loadGeneration !== gen) return;

  if (!data.error && data.matches) {
    _matchListCache = data.matches;
    _matchListCacheTime = Date.now();
    if (matchListFingerprint(data.matches) !== prevFp) {
      renderMatchList(data.matches, listEl, emptyEl);
    }
    return;
  }

  if (data.error) {
    if (hasCache) {
      showToast('Could not refresh match list', 'error');
      return;
    }
    listEl.innerHTML = `<div class="empty-state"><p>${escapeHtml(data.error)}</p></div>`;
  }
}

function renderMatchList(matches, listEl, emptyEl) {
  if (matches.length === 0) {
    listEl.innerHTML = '';
    emptyEl.style.display = '';
    return;
  }
  emptyEl.style.display = 'none';

  // Group by date
  const groups = {};
  matches.forEach(m => {
    const dateKey = m.date || 'Unknown';
    if (!groups[dateKey]) groups[dateKey] = [];
    groups[dateKey].push(m);
  });

  let html = '';
  let cardIndex = 0;
  Object.entries(groups).forEach(([dateKey, group]) => {
    html += `<div class="date-group">`;
    html += `<div class="date-group-header">📅 ${formatDate(dateKey)}</div>`;
    group.forEach(m => {
      const hasCost = m.totalCost > 0;
      const pct = m.playerCount > 0 ? Math.round((m.paidCount / m.playerCount) * 100) : 0;
      const allPaid = hasCost && m.paidCount === m.playerCount && m.playerCount > 0;
      const isPartial = hasCost && m.paidCount > 0 && !allPaid;
      const isCheckin = !hasCost && m.playerCount > 0;
      const isEmpty = m.playerCount === 0;

      let stateClass = '';
      if (allPaid) stateClass = 'card-all-paid';
      else if (isPartial) stateClass = 'card-partial';
      else if (isCheckin) stateClass = 'card-checkin';
      else if (isEmpty) stateClass = 'card-empty';

      const circumference = 2 * Math.PI * 13;
      const dashoffset = circumference - (pct / 100) * circumference;

      const isExact = m.splitMode === 'exact';
      const perPlayer = hasCost && m.playerCount > 0 ? Math.ceil(m.totalCost / m.playerCount) : 0;
      const statusBadge = allPaid
        ? `<span class="match-card-settled">All settled</span>`
        : hasCost
          ? `<span class="match-card-status status-locked">${m.paidCount > 0 ? 'Collecting' : 'Awaiting payment'}</span>`
          : isCheckin
            ? `<span class="match-card-status status-checkin">${m.playerCount} at crease</span>`
            : `<span class="match-card-status status-checkin">Awaiting players</span>`;

      const splitLabel = isExact ? 'Custom split' : `₹${perPlayer}/player`;
      const cardMeta = hasCost
        ? `${escapeHtml(m.payTo || '—')} · ${splitLabel} · ${m.paidCount}/${m.playerCount} paid`
        : `${escapeHtml(m.payTo || '—')} · ${m.playerCount} player${m.playerCount !== 1 ? 's' : ''}`;

      const accentAttr = m.accentColor ? ` data-accent="${escapeAttr(m.accentColor)}"` : '';
      html += `
        <div class="match-card ${stateClass}" data-match-id="${escapeAttr(m.matchId)}"${accentAttr} style="animation-delay:${cardIndex * 50}ms">
          <div class="match-card-emoji" aria-hidden="true">${allPaid ? '🏆' : hasCost ? (m.paidCount > 0 ? '💸' : '⏳') : isCheckin ? '🏏' : '🆕'}</div>
          <div class="match-card-body">
            <div class="match-card-top">
              <span class="match-card-cost">${hasCost ? '<span class="match-card-cost-prefix">₹</span>' + m.totalCost : '<span class="text-muted" style="font-size:14px">No cost yet</span>'}</span>
              ${statusBadge}
            </div>
            <div class="match-card-submeta">${cardMeta}</div>
            ${hasCost && !allPaid && m.playerCount > 0 ? `
            <div class="match-card-bottom">
              <svg class="progress-ring" viewBox="0 0 32 32">
                <circle class="progress-ring-bg" cx="16" cy="16" r="13"/>
                <circle class="progress-ring-fill" cx="16" cy="16" r="13" stroke-dasharray="${circumference}" stroke-dashoffset="${dashoffset}"/>
              </svg>
              <span class="match-card-progress">
                <span class="progress-bar"><span class="progress-fill" style="width:${pct}%"></span></span>
                <span class="progress-label">${m.paidAmount > 0 ? '₹' + m.paidAmount + ' collected' : 'No payments yet'}</span>
              </span>
            </div>` : hasCost && allPaid ? `
            <div class="match-card-bottom">
              <span class="match-card-meta" style="color:var(--paid)">All settled · ₹${m.totalCost}</span>
            </div>` : !hasCost ? `
            <div class="match-card-bottom">
              <span class="match-card-meta">Tap to check in players</span>
            </div>` : ''}
          </div>
        </div>`;
      cardIndex++;
    });
    html += `</div>`;
  });

  listEl.innerHTML = html;
}

// --- Create Match ---
function getSelectedAccent() {
  const active = document.querySelector('.accent-swatch.active');
  return active ? active.dataset.color : '';
}

async function handleCreateMatch(btn) {
  if (!getAdminBypass()) return showToast('Admin login required to create matches', 'error');

  const date = document.getElementById('match-date').value;
  const payToRaw = document.getElementById('pay-upi').value.trim();
  const upfrontCost = Number(document.getElementById('new-match-cost')?.value) || 0;
  const accentColor = getSelectedAccent();

  if (!date) return showToast('Please select a date', 'error');
  const payTo = document.getElementById('pay-to').value.trim();
  if (!payTo) return showToast('Please enter who collects payment', 'error');
  if (!payToRaw) return showToast('Please enter a UPI ID or phone number', 'error');
  if (!isValidPayInput(payToRaw)) {
    return showToast('Enter a 10-digit phone or UPI ID (e.g. 9876543210 or name@ybl)', 'error');
  }
  const payToUPI = payToRaw.trim();

  setAppBusy(true, 'Creating match…');
  setBtnBusy(btn, true, 'Creating…', 'Create Match');
  try {
    const data = await api('createMatch', {
      date, payTo, payToUPI, accentColor
    }, 'POST');

    if (data.error) {
      showToast(data.error, 'error');
      return;
    }

    if (upfrontCost > 0 && data.matchId) {
      try { localStorage.setItem('pending_cost_' + data.matchId, String(upfrontCost)); } catch (e) {}
    }

    if (data.writeToken) storeWriteToken(data.matchId, data.writeToken);
    invalidateMatchListCache();

    if (_pickerSelectedNew.size > 0 && data.matchId) {
      const pickedNames = _knownPlayers
        .filter(p => _pickerSelectedNew.has(normalizePlayerKey(p.name)))
        .map(p => p.name);
      if (pickedNames.length) {
        setAppBusy(true, `Adding ${pickedNames.length} player${pickedNames.length === 1 ? '' : 's'}…`);
        await api('checkInBatch', { matchId: data.matchId, playerNames: pickedNames }, 'POST');
        pickedNames.forEach(addKnownPlayerName);
      }
      _pickerSelectedNew.clear();
    }

    showToast('Match created!');
    const adminQuery = data.writeToken ? `?w=${encodeURIComponent(data.writeToken)}` : '';
    navigate(`#/match/${encodeURIComponent(data.matchId)}${adminQuery}`);
  } catch (e) {
    showToast('Could not create match — try again', 'error');
  } finally {
    setAppBusy(false);
    setBtnBusy(btn, false, 'Creating…', 'Create Match');
  }
}

// --- Load Match Detail ---
function skeletonPlayers(count) {
  return Array.from({ length: count }, () =>
    `<div class="skeleton-player">
      <div class="skeleton-circle"></div>
      <div class="skeleton-line w60" style="margin-bottom:0;flex:1"></div>
    </div>`
  ).join('');
}

async function loadMatch(matchId, options = {}) {
  const silent = options.silent === true;
  const force = options.force === true;
  if (!silent) {
    switchCheckinTab('type');
    _pickerSelectedMatch.clear();
  }
  const gen = _loadGeneration;
  const loading = document.getElementById('match-loading');
  const body = document.getElementById('match-body');

  const cached = _matchDetailCache[matchId];
  const cacheFresh = cached && (Date.now() - cached.time < MATCH_DETAIL_CACHE_MS);
  if (!force && cacheFresh) {
    applyMatchData(cached.match, matchId);
    if (!silent) {
      loading.style.display = 'none';
      body.style.display = '';
    }
    return;
  }

  if (!silent) {
    loading.style.display = '';
    body.style.display = 'none';
  }

  const data = await api('match', { id: matchId });

  if (_loadGeneration !== gen) return;

  if (data.error) {
    if (!silent) {
      loading.style.display = '';
      loading.textContent = data.error;
    } else {
      showToast(data.error, 'error');
    }
    return;
  }

  if (!silent) {
    loading.style.display = 'none';
    body.style.display = '';
  }

  let match = data.match;
  if (isSplitStale(match)) {
    match = await resyncSplitIfStale(match, matchId);
  }

  applyMatchData(match, matchId);
}

function applyMatchData(match, matchId) {
  _currentMatch = match;
  if (matchId) _matchDetailCache[matchId] = { match, time: Date.now() };

  // Apply per-match accent color
  const viewMatch = document.getElementById('view-match');
  if (viewMatch) {
    if (match.accentColor) viewMatch.setAttribute('data-accent', match.accentColor);
    else viewMatch.removeAttribute('data-accent');
  }

  _canWrite = hasWriteAccess();
  applyReadOnlyUI();
  updateModeBadge();

  setPageTitle(formatDate(match.date));

  const payBar = document.getElementById('payment-info-bar');
  const isExact = isExactSplit(match);
  const perPlayerDisplay = expectedPerPlayer(match) || match.perPlayerCost;
  if (match.totalCost > 0 && match.payTo) {
    payBar.style.display = '';
    const playerCount = match.players.length;
    const labelEl = document.querySelector('.pay-amount-label');
    if (labelEl) {
      labelEl.textContent = isExact
        ? `Custom split · ₹${match.totalCost} total`
        : (playerCount > 0
          ? `Per player · ₹${match.totalCost} ÷ ${playerCount}`
          : 'Per player');
    }
    document.getElementById('pay-amount-display').innerHTML = isExact
      ? '<span class="pay-amount-sub">Amounts vary per player</span>'
      : `<span class="pay-amount-prefix">₹</span>${perPlayerDisplay}`;

    const payToInfo = document.getElementById('pay-to-info');
    if (payToInfo) {
      payToInfo.innerHTML = `Pay to <strong>${escapeHtml(match.payTo)}</strong>${match.payToUPI ? ' (' + escapeHtml(match.payToUPI) + ')' : ''}`;
    }

    const copyBtn = document.getElementById('btn-copy-upi');
    if (copyBtn) copyBtn.style.display = match.payToUPI ? '' : 'none';

    const upiLink = document.getElementById('upi-link');
    let showUpiLink = false;
    if (upiLink) {
      if (match.payToUPI && IS_MOBILE && !isExact) {
        const upiTn = encodeURIComponent('Cricket ' + formatDate(match.date));
        upiLink.href = `upi://pay?pa=${encodeURIComponent(match.payToUPI)}&am=${perPlayerDisplay}&cu=INR&tn=${upiTn}`;
        upiLink.style.display = '';
        showUpiLink = true;
      } else {
        upiLink.style.display = 'none';
      }
    }
    payBar.classList.toggle('compact', !match.payToUPI && !showUpiLink);
  } else {
    payBar.style.display = 'none';
    const labelEl = document.querySelector('.pay-amount-label');
    if (labelEl) labelEl.textContent = 'Per Player';
  }

  const costInput = document.getElementById('total-cost');
  if (match.totalCost > 0) {
    costInput.value = match.totalCost;
    _lastPersistedCost = match.totalCost;
  } else {
    _lastPersistedCost = null;
    try {
      const pending = localStorage.getItem('pending_cost_' + matchId);
      if (pending) {
        costInput.value = pending;
        if (match.players.length > 0) {
          setTimeout(() => {
            const pendingCheck = localStorage.getItem('pending_cost_' + matchId);
            if (pendingCheck) {
              localStorage.removeItem('pending_cost_' + matchId);
              saveCost();
            }
          }, 100);
        }
      }
    } catch (e) {}
  }
  updateSplitPreview();
  updateCostSectionUI(match);
  updateSplitModeUI(match);
  updateSplitAssignmentBar(match);
  updateSplitDoneButton(match);

  const badge = document.getElementById('player-count-badge');
  if (badge) {
    badge.textContent = match.players.length > 0 ? match.players.length : '';
    badge.style.display = match.players.length > 0 ? '' : 'none';
  }

  renderPlayerList(match);
  updateSummary(match);

  if (_canWrite) {
    costInput.oninput = () => {
      updateSplitPreview();
      clearTimeout(_costSaveTimer);
      _costSaveTimer = setTimeout(() => saveCost(), 1500);
    };
    costInput.onblur = () => {
      if (_costSaveTimer) { clearTimeout(_costSaveTimer); _costSaveTimer = null; saveCost(); }
    };
  } else {
    costInput.oninput = null;
    costInput.onblur = null;
  }
}

function updateCostSectionUI(match) {
  const section = document.getElementById('split-cost-section');
  const editBtn = document.getElementById('btn-edit-cost');
  if (!section) return;

  if (match.totalCost > 0) {
    section.style.display = section.dataset.editing === 'true' ? '' : 'none';
    if (editBtn) editBtn.style.display = (_canWrite && section.style.display === 'none') ? '' : 'none';
  } else {
    section.style.display = '';
    section.dataset.editing = '';
    if (editBtn) editBtn.style.display = 'none';
  }
}

function isSplitEditing() {
  const section = document.getElementById('split-cost-section');
  return section?.dataset.editing === 'true';
}

function setSplitEditing(on) {
  const section = document.getElementById('split-cost-section');
  if (!section) return;
  section.dataset.editing = on ? 'true' : '';
  if (_currentMatch) {
    updateCostSectionUI(_currentMatch);
    updateSplitModeUI(_currentMatch);
    updateSplitAssignmentBar(_currentMatch);
    updateSplitDoneButton(_currentMatch);
    renderPlayerList(_currentMatch);
  }
}

function toggleCostEdit() {
  const section = document.getElementById('split-cost-section');
  const editBtn = document.getElementById('btn-edit-cost');
  if (!section) return;
  setSplitEditing(true);
  section.style.display = '';
  if (editBtn) editBtn.style.display = 'none';

  const splitRow = document.getElementById('split-mode-row');
  const target = splitRow && splitRow.style.display !== 'none' ? splitRow : section;
  target.scrollIntoView({ behavior: 'smooth', block: 'center' });
  target.classList.add('split-edit-highlight');
  setTimeout(() => target.classList.remove('split-edit-highlight'), 2200);

  const costInput = document.getElementById('total-cost');
  if (costInput && target === section) costInput.focus();
}

function finishSplitEdit() {
  if (!_currentMatch) return;
  if (isExactSplit(_currentMatch)) {
    const left = _currentMatch.totalCost - sumPlayerAmounts(_currentMatch);
    if (left > 0) {
      showToast(`₹${left} still unassigned — balance before Done`, 'error');
      return;
    }
    if (left < 0) {
      showToast(`₹${-left} over assigned — fix amounts first`, 'error');
      return;
    }
  }
  setSplitEditing(false);
  document.getElementById('payment-info-bar')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  showToast('Split saved');
}

function updateSplitDoneButton(match) {
  const btn = document.getElementById('btn-split-done');
  if (!btn) return;
  btn.style.display = (_canWrite && match?.totalCost > 0 && isSplitEditing()) ? '' : 'none';
}

function applyReadOnlyUI() {
  const pill = document.getElementById('readonly-pill');
  if (pill) pill.style.display = _canWrite ? 'none' : '';

  const hint = document.getElementById('match-access-hint');
  if (hint) {
    if (getAdminBypass()) {
      hint.textContent = 'Organizer mode — you can edit this match';
      hint.className = 'match-access-hint hint-admin';
    } else {
      hint.textContent = 'Player mode — tap ✓ when paid; tap again to undo';
      hint.className = 'match-access-hint hint-player';
    }
  }

  const costInput = document.getElementById('total-cost');
  if (costInput) {
    costInput.readOnly = !_canWrite;
    costInput.classList.toggle('input-readonly', !_canWrite);
  }

  const checkinRow = document.querySelector('.checkin-form');
  if (checkinRow) checkinRow.style.display = '';

  const actionsRow = document.querySelector('.match-actions-row');
  if (actionsRow) {
    const deleteBtn = actionsRow.querySelector('.btn-delete-match');
    if (deleteBtn) deleteBtn.style.display = _canWrite ? '' : 'none';
  }

  if (_currentMatch) updateCostSectionUI(_currentMatch);
}

function handleCopyUPI() {
  if (!_currentMatch?.payToUPI) return;
  let text = _currentMatch.payToUPI;
  if (!isExactSplit(_currentMatch)) {
    const per = expectedPerPlayer(_currentMatch) || _currentMatch.perPlayerCost;
    text += `\nPay ₹${per} for Cricket ${formatDate(_currentMatch.date)}`;
  } else {
    text += `\nCricket ${formatDate(_currentMatch.date)} — see match for your amount`;
  }
  try {
    navigator.clipboard.writeText(text);
    showToast('UPI ID copied!');
  } catch (e) {
    showToast('Could not copy', 'error');
  }
}

function isExactSplit(match) {
  return match?.splitMode === 'exact';
}

function getSelectedSplitMode() {
  const checked = document.querySelector('input[name="split-mode"]:checked');
  return checked ? checked.value : 'equal';
}

function sumPlayerAmounts(match) {
  return (match?.players || []).reduce((s, p) => s + (Number(p.amountOwed) || 0), 0);
}

function getPlayerOwed(match, player) {
  if (isExactSplit(match)) return Number(player.amountOwed) || 0;
  return expectedPerPlayer(match) || player.amountOwed || 0;
}

function expectedPerPlayer(match) {
  if (!match?.totalCost || !match.players?.length) return 0;
  return Math.ceil(match.totalCost / match.players.length);
}

function isSplitStale(match) {
  if (isExactSplit(match)) return false;
  if (!match?.totalCost || !match.players?.length) return false;
  const expected = expectedPerPlayer(match);
  if (match.perPlayerCost !== expected) return true;
  return match.players.some(p => p.amountOwed !== expected);
}

function applyExpectedSplit(match) {
  const per = expectedPerPlayer(match);
  if (!per) return match;
  match.perPlayerCost = per;
  match.players.forEach(p => { p.amountOwed = per; });
  return match;
}

function applyServerMatchData(match, data) {
  if (!data) return match;
  if (data.totalCost) match.totalCost = data.totalCost;
  if (data.splitMode) match.splitMode = data.splitMode;
  if (data.perPlayerCost) match.perPlayerCost = data.perPlayerCost;
  if (data.players) match.players = data.players;
  return match;
}

function applyServerSplit(match, data) {
  if (isExactSplit(match) || data?.splitMode === 'exact') {
    return applyServerMatchData(match, data);
  }
  if (!data?.perPlayerCost) return match;
  if (data.totalCost) match.totalCost = data.totalCost;
  match.perPlayerCost = data.perPlayerCost;
  match.players.forEach(p => { p.amountOwed = data.perPlayerCost; });
  return match;
}

async function resyncSplitIfStale(match, matchId) {
  if (!isSplitStale(match)) return match;

  const canWrite = hasWriteAccess();
  const localFix = () => applyExpectedSplit({
    ...match,
    players: match.players.map(p => ({ ...p }))
  });

  if (!canWrite) return localFix();

  const lock = await api('lockMatch', { matchId, totalCost: match.totalCost }, 'POST');
  if (!lock.success) return localFix();

  return applyServerSplit({
    ...match,
    players: match.players.map(p => ({ ...p }))
  }, lock);
}

function updateSplitModeUI(match) {
  const row = document.getElementById('split-mode-row');
  if (!row) return;
  const show = _canWrite && (match?.players?.length || 0) > 0 && match?.totalCost > 0 && isSplitEditing();
  row.style.display = show ? '' : 'none';
  if (!show) return;
  const mode = match.splitMode || 'equal';
  const radio = row.querySelector(`input[name="split-mode"][value="${mode}"]`);
  if (radio) radio.checked = true;
}

function updateSplitAssignmentBar(match) {
  const bar = document.getElementById('split-balance-bar');
  if (!bar) return;
  if (!isExactSplit(match) || !match.totalCost || !isSplitEditing()) {
    bar.style.display = 'none';
    return;
  }
  const assigned = sumPlayerAmounts(match);
  const total = match.totalCost;
  const left = total - assigned;
  bar.style.display = '';
  if (left === 0) {
    bar.className = 'split-balance-bar balanced';
    bar.textContent = `₹${assigned} assigned of ₹${total} ✓ balanced`;
  } else if (left > 0) {
    bar.className = 'split-balance-bar unbalanced';
    bar.textContent = `₹${assigned} of ₹${total} — ₹${left} left to assign`;
  } else {
    bar.className = 'split-balance-bar unbalanced';
    bar.textContent = `₹${assigned} of ₹${total} — ₹${-left} over assigned`;
  }
}

async function handleSplitModeChange(newMode) {
  if (!_canWrite || !_currentMatch) return;
  const prev = _currentMatch.splitMode || 'equal';
  if (newMode === prev) return;
  if (prev === 'exact' && newMode === 'equal') {
    if (!confirm('Switch to equal split? Each player will owe the same amount.')) {
      const revert = document.querySelector(`input[name="split-mode"][value="${prev}"]`);
      if (revert) revert.checked = true;
      return;
    }
  }
  const totalCost = _currentMatch.totalCost || Number(document.getElementById('total-cost')?.value);
  if (!totalCost) return;
  setAppBusy(true, 'Updating split…');
  try {
    const data = await api('lockMatch', { matchId: currentMatchId, totalCost, splitMode: newMode }, 'POST');
    if (data.error) {
      showToast(data.error, 'error');
      const revert = document.querySelector(`input[name="split-mode"][value="${prev}"]`);
      if (revert) revert.checked = true;
      return;
    }
    applyServerMatchData(_currentMatch, data);
    setSplitEditing(newMode === 'exact');
    applyMatchData(_currentMatch, currentMatchId);
    invalidateMatchListCache(currentMatchId);
  } finally {
    setAppBusy(false);
  }
}

async function handlePlayerAmountChange(playerName, rawValue, inputEl) {
  if (!_canWrite || !isExactSplit(_currentMatch)) return;
  const amount = Math.round(Number(rawValue) * 100) / 100;
  if (isNaN(amount) || amount < 0) {
    showToast('Invalid amount', 'error');
    if (inputEl && _currentMatch) {
      const p = _currentMatch.players.find(pl => pl.name.toLowerCase() === playerName.toLowerCase());
      if (p) inputEl.value = p.amountOwed;
    }
    return;
  }
  setAppBusy(true, 'Saving amount…');
  try {
    const data = await api('setPlayerAmount', { matchId: currentMatchId, playerName, amountOwed: amount }, 'POST');
    if (data.error) {
      showToast(data.error, 'error');
      return;
    }
    applyServerMatchData(_currentMatch, data);
    updateSplitAssignmentBar(_currentMatch);
    renderPlayerList(_currentMatch);
    updateSummary(_currentMatch);
    invalidateMatchListCache(currentMatchId);
  } finally {
    setAppBusy(false);
  }
}

function updateSplitPreview() {
  const preview = document.getElementById('split-preview');
  if (!preview) return;

  // Pay banner already shows per-player when cost is saved
  if (_currentMatch?.totalCost > 0) {
    preview.textContent = '';
    preview.style.display = 'none';
    return;
  }

  const costInput = document.getElementById('total-cost');
  const cost = Number(costInput.value);
  const count = _currentMatch ? _currentMatch.players.length : 0;
  const isExact = getSelectedSplitMode() === 'exact';

  if (cost > 0 && count > 0 && isExact) {
    preview.textContent = 'Set each player\'s amount after saving the total';
    preview.style.display = '';
  } else if (cost > 0 && count > 0) {
    preview.innerHTML = `Each batter owes <strong>₹${Math.ceil(cost / count)}</strong> (₹${cost} ÷ ${count})`;
    preview.style.display = '';
  } else if (cost > 0) {
    preview.textContent = 'Add players to see the split';
    preview.style.display = '';
  } else {
    preview.textContent = '';
    preview.style.display = 'none';
  }
}

async function saveCost() {
  if (!_canWrite) return;
  const cost = Number(document.getElementById('total-cost').value);
  if (!cost || cost <= 0 || !_currentMatch) return;
  if (cost === _lastPersistedCost) return;
  if (cost === _costBlockedValue) return;
  const splitMode = getSelectedSplitMode();
  setAppBusy(true, 'Saving cost…');
  try {
    const data = await api('lockMatch', { matchId: currentMatchId, totalCost: cost, splitMode }, 'POST');
    if (data.error) {
      _costBlockedValue = cost;
      showToast(data.error, 'error');
      return;
    }
    _costBlockedValue = null;
    _lastPersistedCost = cost;
    if (_currentMatch) {
      _currentMatch.totalCost = cost;
      if (data.splitMode === 'exact') applyServerMatchData(_currentMatch, data);
      else applyServerSplit(_currentMatch, data);
      const section = document.getElementById('split-cost-section');
      const wasEditing = isSplitEditing();
      if (section) {
        if (data.splitMode === 'exact') section.dataset.editing = 'true';
        else if (!wasEditing) section.dataset.editing = '';
      }
      applyMatchData(_currentMatch, currentMatchId);
    }
    invalidateMatchListCache(currentMatchId);
  } finally {
    setAppBusy(false);
  }
}

function renderPlayerList(match) {
  const listEl = document.getElementById('player-list');
  const players = match.players || [];
  const hasCost = match.totalCost > 0;

  if (players.length === 0) {
    listEl.innerHTML = `
      <div class="empty-state" style="padding:32px 24px">
        <img class="empty-logo app-logo" src="logo.png?v=1.1.4" width="96" height="96" alt="">
        <h3>No one at the crease</h3>
        <p>Type a name above and tap Add</p>
      </div>`;
    return;
  }

  const sorted = [...players].sort((a, b) => {
    if (hasCost && a.paid !== b.paid) return a.paid ? 1 : -1;
    return a.name.localeCompare(b.name);
  });

  const isExact = isExactSplit(match);
  const perPlayer = isExact ? 0 : expectedPerPlayer(match);

  listEl.innerHTML = sorted.map((p, i) => {
    const canToggle = hasCost;
    const showRemove = !hasCost && _canWrite;
    const owed = getPlayerOwed(match, p);
    const amountHtml = hasCost
      ? (isExact && _canWrite && !p.paid
        ? `<span class="player-amount-edit-wrap"><span class="player-amount-prefix">₹</span><input type="number" class="player-amount-input" data-player-name="${escapeAttr(p.name)}" value="${p.amountOwed}" min="0" inputmode="numeric"></span>`
        : `<span class="player-amount ${p.paid ? 'paid-amount' : ''}">₹${owed}</span>`)
      : (showRemove
        ? `<button class="player-remove" data-player-name="${escapeAttr(p.name)}" title="Remove">✕</button>`
        : '');
    const exactEdit = isExact && _canWrite && hasCost && !p.paid && isSplitEditing();
    return `
      <div class="player-item ${p.paid && hasCost ? 'paid' : ''} ${exactEdit ? 'player-item-exact' : ''}"
           data-player-name="${escapeAttr(p.name)}"
           data-can-toggle="${canToggle}"
           data-paid="${p.paid && hasCost}"
           style="animation-delay:${i * 50}ms">
        <div class="player-checkbox ${hasCost ? '' : 'checked-in'}">${hasCost ? (p.paid ? '✓' : '') : '✓'}</div>
        <span class="player-name ${getAdminBypass() ? 'player-name-editable' : ''}" title="${getAdminBypass() ? 'Tap to rename' : escapeAttr(p.name)}" data-rename-name="${escapeAttr(p.name)}" data-rename-id="${escapeAttr(p.playerId || '')}">${escapeHtml(p.name)}</span>
        ${amountHtml}
      </div>`;
  }).join('');
}

function updateSummary(match) {
  const players = match.players || [];
  const summaryBar = document.getElementById('summary-bar');
  if (!match.totalCost || players.length === 0) {
    summaryBar.style.display = 'none';
    return;
  }
  const paidCount = players.filter(p => p.paid).length;
  if (paidCount === players.length) {
    summaryBar.style.display = 'none';
    return;
  }
  summaryBar.style.display = '';
  const paidAmount = players.filter(p => p.paid).reduce((s, p) => s + getPlayerOwed(match, p), 0);
  const remaining = Math.max(0, match.totalCost - paidAmount);
  document.getElementById('summary-text').innerHTML =
    `<strong>${paidCount}/${players.length}</strong> paid · <span style="color:var(--warn)">₹${remaining} left</span>`;
}

// --- Bulk Check In ---
const BULK_CHECKIN_MAX = 50;

function parseBulkNames(text) {
  const seen = new Set();
  const names = [];
  for (const part of text.split(/[\r\n,;]+/)) {
    const name = part.trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(name);
  }
  return names;
}

function toggleBulkCheckin(forceOpen) {}

// --- Check-in Tabs ---
function switchCheckinTab(tabName) {
  const bar = document.getElementById('checkin-tab-bar');
  if (!bar) return;
  bar.querySelectorAll('.checkin-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tabName));
  ['type', 'paste', 'pick'].forEach(id => {
    const panel = document.getElementById('tab-' + id);
    if (panel) panel.style.display = id === tabName ? '' : 'none';
  });
  if (tabName === 'pick') {
    ensureKnownPlayers().then(() => renderPickerChips('match'));
  }
}

function initCheckinTabBar() {
  const bar = document.getElementById('checkin-tab-bar');
  if (!bar) return;
  bar.addEventListener('click', e => {
    const tab = e.target.closest('.checkin-tab');
    if (tab) switchCheckinTab(tab.dataset.tab);
  });
}

// --- Picker Chips ---
function renderPickerChips(context) {
  const isMatch = context === 'match';
  const container = document.getElementById(isMatch ? 'player-picker-chips' : 'new-match-picker-chips');
  if (!container) return;
  const selected = isMatch ? _pickerSelectedMatch : _pickerSelectedNew;

  const currentPlayers = isMatch && _currentMatch
    ? new Set(_currentMatch.players.map(p => normalizePlayerKey(p.name)))
    : new Set();

  if (!_knownPlayers.length) {
    container.innerHTML = '<span class="picker-empty">No past players yet</span>';
    updatePickerBtn(context);
    return;
  }

  const sorted = [..._knownPlayers].sort((a, b) => b.matches - a.matches || a.name.localeCompare(b.name));
  container.innerHTML = sorted.map(p => {
    const lower = normalizePlayerKey(p.name);
    const disabled = currentPlayers.has(lower);
    const sel = selected.has(lower);
    const cls = ['picker-chip'];
    if (disabled) cls.push('chip-disabled');
    else if (sel) cls.push('chip-selected');
    return `<button type="button" class="${cls.join(' ')}" data-player="${escapeAttr(p.name)}" data-ctx="${context}"${disabled ? ' disabled' : ''}>${escapeHtml(p.name)}</button>`;
  }).join('');

  updatePickerBtn(context);
}

function updatePickerBtn(context) {
  if (context === 'match') {
    const btn = document.getElementById('btn-picker-add');
    if (btn) {
      const n = _pickerSelectedMatch.size;
      btn.disabled = n === 0;
      btn.textContent = n ? `Add ${n} player${n > 1 ? 's' : ''}` : 'Add selected';
    }
  } else {
    const hint = document.getElementById('new-match-picker-count');
    if (hint) {
      const n = _pickerSelectedNew.size;
      hint.textContent = n ? `${n} player${n > 1 ? 's' : ''} selected` : '';
    }
  }
}

function handleChipClick(e) {
  const chip = e.target.closest('.picker-chip');
  if (!chip || chip.classList.contains('chip-disabled')) return;
  const name = chip.dataset.player;
  const ctx = chip.dataset.ctx;
  const sel = ctx === 'match' ? _pickerSelectedMatch : _pickerSelectedNew;
  const key = normalizePlayerKey(name);
  if (sel.has(key)) sel.delete(key);
  else sel.add(key);
  chip.classList.toggle('chip-selected', sel.has(key));
  updatePickerBtn(ctx);
}

document.addEventListener('click', e => {
  if (e.target.closest('.picker-chip')) handleChipClick(e);
});

function invalidateHistoryForNames(names) {
  names.forEach(name => {
    const p = _knownPlayers.find(k => normalizePlayerKey(k.name) === normalizePlayerKey(name));
    if (p?.playerId) invalidatePlayerHistoryCache(p.playerId);
  });
}

function applyBatchCheckInLocally(names, data) {
  if (!_currentMatch) return;
  const existing = new Set(_currentMatch.players.map(p => p.name.toLowerCase()));
  for (const name of names) {
    const key = name.toLowerCase();
    if (!existing.has(key)) {
      _currentMatch.players.push({
        name,
        playerId: '',
        amountOwed: data.perPlayerCost || 0,
        paid: false,
        paidTimestamp: ''
      });
      existing.add(key);
    }
  }
  if (data.splitMode === 'exact') {
    if (data.totalCost) _currentMatch.totalCost = data.totalCost;
    if (data.splitMode) _currentMatch.splitMode = data.splitMode;
  } else if (data.perPlayerCost) applyServerSplit(_currentMatch, data);
  else if (!isExactSplit(_currentMatch)) applyExpectedSplit(_currentMatch);
  applyMatchData(_currentMatch, currentMatchId);
  invalidateHistoryForNames(names);
  invalidatePlayersCache();
}

async function handlePickerCheckIn() {
  if (_checkInPending || !_pickerSelectedMatch.size) return;
  const names = _knownPlayers
    .filter(p => _pickerSelectedMatch.has(normalizePlayerKey(p.name)))
    .map(p => p.name);
  if (!names.length) return;

  _checkInPending = true;
  const btn = document.getElementById('btn-picker-add');
  setBtnBusy(btn, true, 'Adding…', 'Add selected');
  setAppBusy(true, `Adding ${names.length} player${names.length === 1 ? '' : 's'}…`);

  let data;
  try {
    data = await api('checkInBatch', { matchId: currentMatchId, playerNames: names }, 'POST');
  } finally {
    _checkInPending = false;
    setBtnBusy(btn, false, 'Adding…', 'Add selected');
    setAppBusy(false);
  }

  if (data.error) return showToast(data.error, 'error');

  _pickerSelectedMatch.clear();
  _costBlockedValue = null;
  names.forEach(addKnownPlayerName);
  applyBatchCheckInLocally(names, data);
  invalidateMatchListCache(currentMatchId);
  renderPickerChips('match');

  const added = data.added || 0;
  const skipped = data.skipped || 0;
  if (added === 0 && skipped > 0) showToast('Everyone was already on the list', 'error');
  else if (skipped > 0) { haptic(HAPTIC.tick); showToast(`Added ${added} · ${skipped} already on list`); }
  else { haptic(HAPTIC.tick); showToast(`Added ${added} player${added === 1 ? '' : 's'}!`); }
}

// --- New Match Picker Modal ---
let _pickerModalTemp = new Set();

async function openNewMatchPicker() {
  _pickerModalTemp = new Set(_pickerSelectedNew);
  const modal = document.getElementById('picker-modal');
  const search = document.getElementById('picker-search');
  const list = document.getElementById('picker-list');
  if (modal && !modal.open) modal.showModal();
  if (search) search.value = '';
  if (list) list.innerHTML = '<span class="picker-empty">Loading players…</span>';
  updatePickerModalBtn();
  await ensureKnownPlayers();
  renderPickerModalList();
  if (search) {
    setTimeout(() => search.focus(), 50);
    search.oninput = debounce(
      () => renderPickerModalList(search.value.trim().toLowerCase()),
      150
    );
  }
}

function closeNewMatchPicker() {
  const modal = document.getElementById('picker-modal');
  if (modal && modal.open) modal.close();
}

function refreshOpenPickerModal() {
  const modal = document.getElementById('picker-modal');
  if (!modal?.open) return;
  const search = document.getElementById('picker-search');
  renderPickerModalList((search?.value || '').trim().toLowerCase());
}

function renderPickerModalList(filter = '') {
  const list = document.getElementById('picker-list');
  if (!list) return;
  const sorted = [..._knownPlayers].sort((a, b) => b.matches - a.matches || a.name.localeCompare(b.name));
  const filtered = filter
    ? sorted.filter(p => normalizePlayerKey(p.name).includes(filter))
    : sorted;

  if (!filtered.length) {
    list.innerHTML = `<span class="picker-empty">${filter ? 'No players match your search' : 'No past players yet'}</span>`;
    updatePickerModalBtn();
    return;
  }

  list.innerHTML = filtered.map(p => {
    const key = normalizePlayerKey(p.name);
    const sel = _pickerModalTemp.has(key);
    return `<div class="picker-list-item ${sel ? 'selected' : ''}" data-player-key="${escapeAttr(key)}" data-player-name="${escapeAttr(p.name)}">
      <div class="picker-list-check">${sel ? '✓' : ''}</div>
      <span class="picker-list-name">${escapeHtml(p.name)}</span>
      <span class="picker-list-meta">${p.matches} game${p.matches !== 1 ? 's' : ''}</span>
    </div>`;
  }).join('');

  updatePickerModalBtn();
}

function updatePickerModalBtn() {
  const btn = document.getElementById('picker-modal-add');
  if (!btn) return;
  const n = _pickerModalTemp.size;
  btn.disabled = n === 0;
  btn.textContent = n ? `Add ${n}` : 'Add';
}

function handlePickerListClick(e) {
  const item = e.target.closest('.picker-list-item');
  if (!item) return;
  const key = item.dataset.playerKey;
  if (!key) return;
  if (_pickerModalTemp.has(key)) _pickerModalTemp.delete(key);
  else _pickerModalTemp.add(key);
  item.classList.toggle('selected', _pickerModalTemp.has(key));
  const check = item.querySelector('.picker-list-check');
  if (check) check.textContent = _pickerModalTemp.has(key) ? '✓' : '';
  updatePickerModalBtn();
}

function confirmNewMatchPicker() {
  _pickerSelectedNew.clear();
  _pickerModalTemp.forEach(k => _pickerSelectedNew.add(k));
  closeNewMatchPicker();
  renderNewMatchPickerTags();
}

function renderNewMatchPickerTags() {
  const container = document.getElementById('new-match-picker-tags');
  if (!container) return;
  if (!_pickerSelectedNew.size) { container.innerHTML = ''; return; }

  container.innerHTML = [..._pickerSelectedNew].map(key => {
    const p = _knownPlayers.find(pl => normalizePlayerKey(pl.name) === key);
    const name = p ? p.name : key;
    return `<span class="picker-tag">${escapeHtml(name)}<button type="button" class="picker-tag-x" data-key="${escapeAttr(key)}" onclick="removePickerTag(this.dataset.key)">&times;</button></span>`;
  }).join('');
}

function removePickerTag(key) {
  _pickerSelectedNew.delete(key);
  renderNewMatchPickerTags();
}

// --- Rename Player Modal ---
let _renameTarget = { name: '', playerId: '' };

function openRenameModal(name, playerId) {
  if (!getAdminBypass()) return showToast('Admin access required', 'error');
  _renameTarget = { name, playerId: playerId || '' };
  const modal = document.getElementById('rename-modal');
  const input = document.getElementById('rename-input');
  const deleteBtn = document.getElementById('rename-delete-btn');
  
  input.value = name;
  
  if (deleteBtn) {
    deleteBtn.style.display = (playerId && getAdminBypass()) ? '' : 'none';
  }
  
  if (modal && !modal.open) modal.showModal();
  setTimeout(() => { input.focus(); input.select(); }, 50);
}

function closeRenameModal() {
  const modal = document.getElementById('rename-modal');
  if (modal && modal.open) modal.close();
}

async function confirmRenamePlayer() {
  const input = document.getElementById('rename-input');
  const newName = input.value.trim();
  if (!newName) return showToast('Name cannot be empty', 'error');
  if (newName === _renameTarget.name) return closeRenameModal();

  const btn = document.getElementById('rename-save-btn');
  setBtnBusy(btn, true, 'Saving…', 'Save');
  setAppBusy(true, 'Saving name…');

  const token = getAdminBypass() || getAuthToken(currentMatchId);
  const payload = { action: 'renamePlayer', newName, writeToken: token };
  if (_renameTarget.playerId) payload.playerId = _renameTarget.playerId;
  else payload.oldName = _renameTarget.name;
  if (currentMatchId) payload.matchId = currentMatchId;

  try {
    const data = await api('renamePlayer', payload, 'POST');
    if (data.error) return showToast(data.error, 'error');

    closeRenameModal();
    showToast(`Renamed to ${newName}`);

    invalidatePlayerHistoryCache(_renameTarget.playerId || null);
    invalidatePlayersCache();
    const onStats = document.getElementById('view-stats')?.style.display !== 'none';
    const refresh = [];
    if (currentMatchId) refresh.push(loadMatch(currentMatchId, { silent: true, force: true }));
    if (onStats) refresh.push(loadStats(true));
    else refresh.push(ensureKnownPlayers(true));
    await Promise.all(refresh);
  } finally {
    setBtnBusy(btn, false, 'Saving…', 'Save');
    setAppBusy(false);
  }
}

// --- Delete Player (from roster) ---
async function handleDeletePlayer(playerId, name) {
  if (!confirm(`Remove "${name}" from the roster?\nOnly works if they have no match history.`)) return;

  const token = getAdminBypass();
  if (!token) return showToast('Admin access required', 'error');

  setAppBusy(true, 'Removing from roster…');
  try {
    const data = await api('deletePlayer', { playerId, writeToken: token }, 'POST');
    if (data.error) return showToast(data.error, 'error');
    showToast(`${name} removed from roster`);
    invalidatePlayerHistoryCache(playerId);
    await ensureKnownPlayers(true);
    loadStats();
  } finally {
    setAppBusy(false);
  }
}

async function deletePlayerFromRenameModal() {
  if (!_renameTarget.playerId) return showToast('Cannot delete player without ID', 'error');
  
  if (!confirm(`Remove "${_renameTarget.name}" from the roster?\nOnly works if they have no match history.`)) return;

  const token = getAdminBypass();
  if (!token) return showToast('Admin access required', 'error');

  const deleteBtn = document.getElementById('rename-delete-btn');
  setBtnBusy(deleteBtn, true, 'Deleting…', 'Delete from roster');
  setAppBusy(true, 'Removing from roster…');
  try {
    const data = await api('deletePlayer', { playerId: _renameTarget.playerId, writeToken: token }, 'POST');
    if (data.error) return showToast(data.error, 'error');
    closeRenameModal();
    showToast(`${_renameTarget.name} removed from roster`);
    invalidatePlayerHistoryCache(_renameTarget.playerId);
    await ensureKnownPlayers(true);
    loadStats();
  } finally {
    setBtnBusy(deleteBtn, false, 'Deleting…', 'Delete from roster');
    setAppBusy(false);
  }
}

async function handleBulkCheckIn() {
  const ta = document.getElementById('bulk-checkin-names');
  if (!ta || _checkInPending) return;

  const names = parseBulkNames(ta.value);
  if (!names.length) return showToast('Paste at least one name', 'error');
  if (names.length > BULK_CHECKIN_MAX) {
    return showToast(`Max ${BULK_CHECKIN_MAX} names at once`, 'error');
  }

  hideSuggestions();
  _checkInPending = true;
  const bulkBtn = document.getElementById('btn-bulk-checkin');
  ta.disabled = true;
  setBtnBusy(bulkBtn, true, 'Adding…', 'Add all');
  setAppBusy(true, `Adding ${names.length} player${names.length === 1 ? '' : 's'}…`);

  let data;
  try {
    data = await api('checkInBatch', { matchId: currentMatchId, playerNames: names }, 'POST');
  } finally {
    ta.disabled = false;
    _checkInPending = false;
    setBtnBusy(bulkBtn, false, 'Adding…', 'Add all');
    setAppBusy(false);
  }

  if (data.error) return showToast(data.error, 'error');

  ta.value = '';
  _costBlockedValue = null;
  names.forEach(addKnownPlayerName);
  applyBatchCheckInLocally(names, data);
  invalidateMatchListCache(currentMatchId);

  const added = data.added || 0;
  const skipped = data.skipped || 0;
  if (added === 0 && skipped > 0) {
    showToast('Everyone was already on the list', 'error');
  } else if (skipped > 0) {
    showToast(`Added ${added} · ${skipped} already on list`);
  } else {
    showToast(`Added ${added} player${added === 1 ? '' : 's'}!`);
  }
  if (data.splitMode === 'exact' && data.remaining > 0) {
    setTimeout(() => showToast(`₹${data.remaining} still unassigned — set amounts`, 'info'), 600);
  }
}

// --- Check In ---
async function handleCheckIn() {
  const input = document.getElementById('checkin-name');
  const name = input.value.trim();
  if (!name) return showToast('Enter a name', 'error');
  if (_checkInPending) return;

  hideSuggestions();
  _checkInPending = true;
  input.disabled = true;
  const addBtn = document.getElementById('btn-checkin-add');
  setBtnBusy(addBtn, true, 'Adding…', 'Add');
  setAppBusy(true, 'Adding player…');

  let data;
  try {
    data = await api('checkIn', { matchId: currentMatchId, playerName: name }, 'POST');
  } finally {
    input.disabled = false;
    _checkInPending = false;
    setBtnBusy(addBtn, false, 'Adding…', 'Add');
    setAppBusy(false);
  }

  if (data.error) return showToast(data.error, 'error');

  input.value = '';
  _costBlockedValue = null;
  if (_currentMatch) {
    const key = name.toLowerCase();
    if (!_currentMatch.players.some(p => p.name.toLowerCase() === key)) {
      _currentMatch.players.push({
        name,
        playerId: '',
        amountOwed: data.perPlayerCost || 0,
        paid: false,
        paidTimestamp: ''
      });
    }
    if (data.players || data.splitMode === 'exact') applyServerMatchData(_currentMatch, data);
    else if (data.perPlayerCost) applyServerSplit(_currentMatch, data);
    else if (!isExactSplit(_currentMatch)) applyExpectedSplit(_currentMatch);
    applyMatchData(_currentMatch, currentMatchId);
    addKnownPlayerName(name);
    invalidateHistoryForNames([name]);
    invalidatePlayersCache();
  }
  haptic(HAPTIC.tick);
  showToast(`${name} is at the crease!`);
  if (data.splitMode === 'exact' && data.remaining > 0) {
    setTimeout(() => showToast(`Set amount for ${name} (₹${data.remaining} unassigned)`, 'info'), 600);
  }
  invalidateMatchListCache(currentMatchId);
}

// --- Remove Player ---
async function handleRemovePlayer(name) {
  if (!_canWrite) return showToast('View-only link — cannot remove players', 'error');
  setAppBusy(true, 'Removing player…');
  let data;
  try {
    data = await api('removePlayer', { matchId: currentMatchId, playerName: name }, 'POST');
  } finally {
    setAppBusy(false);
  }
  if (data.error) return showToast(data.error, 'error');
  if (_currentMatch) {
    const removed = _currentMatch.players.find(p => p.name.toLowerCase() === name.toLowerCase());
    _currentMatch.players = _currentMatch.players.filter(
      p => p.name.toLowerCase() !== name.toLowerCase()
    );
    if (data.players || data.splitMode === 'exact') applyServerMatchData(_currentMatch, data);
    else if (data.perPlayerCost) applyServerSplit(_currentMatch, data);
    else if (!isExactSplit(_currentMatch)) applyExpectedSplit(_currentMatch);
    applyMatchData(_currentMatch, currentMatchId);
    if (removed?.playerId) invalidatePlayerHistoryCache(removed.playerId);
    invalidatePlayersCache();
  }
  showToast(`${name} removed`);
  invalidateMatchListCache(currentMatchId);
}

// --- Delete Match ---
async function handleDeleteMatch() {
  if (!_canWrite) return showToast('View-only link — cannot delete match', 'error');
  let msg = 'Delete this match?\nThis cannot be undone.';
  if (_currentMatch?.players?.length) {
    const unpaid = _currentMatch.players.filter(p => !p.paid);
    const unpaidAmt = unpaid.reduce((s, p) => s + (p.amountOwed || 0), 0);
    if (unpaid.length > 0 && unpaidAmt > 0) {
      msg = `⚠ ${unpaid.length} player${unpaid.length > 1 ? 's haven\'t' : ' hasn\'t'} paid yet (₹${unpaidAmt} outstanding).\nDeleting will remove all payment records.\n\nAre you sure?`;
    } else if (unpaid.length > 0) {
      msg = `${unpaid.length} player${unpaid.length > 1 ? 's' : ''} checked in.\nDeleting will remove all records.\n\nAre you sure?`;
    } else {
      msg = 'All payments settled.\nDelete this match?';
    }
  }
  if (!confirm(msg)) return;

  const token = getAuthToken(currentMatchId);
  if (!token) return showToast('Admin login required', 'error');

  setAppBusy(true, 'Deleting match…');
  let data;
  try {
    data = await api('deleteMatch', { matchId: currentMatchId, writeToken: token }, 'POST');
  } finally {
    setAppBusy(false);
  }
  if (data.error) {
    const msg = /write token/i.test(data.error)
      ? 'Admin token missing or expired. Use the link from when you created this match.'
      : data.error;
    return showToast(msg, 'error');
  }

  try {
    localStorage.removeItem(writeTokenKey(currentMatchId));
    sessionStorage.removeItem(writeTokenKey(currentMatchId));
  } catch (e) {}

  invalidateMatchListCache(currentMatchId);
  invalidatePlayersCache();
  showToast('Match deleted');
  location.hash = '#/';
}

// --- Mark Paid ---
async function togglePaid(el, playerName, paid) {
  if (_markPaidPending.has(playerName)) return;

  const player = _currentMatch?.players.find(
    p => p.name.toLowerCase() === playerName.toLowerCase()
  );

  if (!paid && player && !player.paid) {
    return showToast('Not marked as paid', 'error');
  }

  const params = { matchId: currentMatchId, playerName, paid };
  if (!paid) {
    const token = getUndoAuthToken(currentMatchId);
    if (!token) return showToast('Could not undo — ask organizer', 'error');
    params.writeToken = token;
  }

  _markPaidPending.add(playerName);
  el.classList.add('settling');
  setAppBusy(true, paid ? 'Marking paid…' : 'Undoing…');
  let data;
  try {
    data = await api('markPaid', params, 'POST');
  } finally {
    _markPaidPending.delete(playerName);
    el.classList.remove('settling');
    setAppBusy(false);
  }
  if (data.error) return showToast(data.error, 'error');

  haptic(HAPTIC.confirm);
  el.classList.add('flash');
  setTimeout(() => el.classList.remove('flash'), 400);

  if (_currentMatch) {
    if (player) {
      player.paid = paid;
      player.paidTimestamp = paid ? new Date().toISOString() : '';
      if (data.amountOwed) player.amountOwed = data.amountOwed;
    }
    renderPlayerList(_currentMatch);
    updateSummary(_currentMatch);
    invalidateMatchListCache(currentMatchId);
    if (player?.playerId) invalidatePlayerHistoryCache(player.playerId);
    else invalidatePlayerHistoryCache();
  }

  if (paid && player && !hasWriteAccess()) {
    showPaidUndoToast(playerName, el);
  } else if (!paid) {
    showToast('Payment unmarked');
  }

  if (_currentMatch && _currentMatch.totalCost > 0) {
    const allPaid = _currentMatch.players.length > 0 &&
      _currentMatch.players.every(p => p.paid);
    if (allPaid && paid) {
      haptic(HAPTIC.success);
      showToast('All out! Every player has paid!');
      fireConfetti();
    }
  }
}

// --- Player Stats ---
let _statsLoadSeq = 0;

function renderStatsUI(players) {
  const tableWrap = document.getElementById('stats-table-wrap');
  const noStats = document.getElementById('no-stats');
  if (!tableWrap || !noStats) return;

  if (players.length === 0) {
    tableWrap.innerHTML = '';
    noStats.style.display = '';
    return;
  }

  noStats.style.display = 'none';
  window._statsPlayers = players;
  tableWrap.innerHTML = `
      <div class="stats-sort-bar">
        <span class="stats-sort-label">Sort:</span>
        <button class="stats-sort-btn${_statsSortKey === 'matches' ? ' active' : ''}" id="ssb-matches" onclick="sortStats('matches')">Games</button>
        <button class="stats-sort-btn${_statsSortKey === 'outstanding' ? ' active' : ''}" id="ssb-outstanding" onclick="sortStats('outstanding')">Due ↑</button>
        <button class="stats-sort-btn${_statsSortKey === 'totalOwed' ? ' active' : ''}" id="ssb-totalOwed" onclick="sortStats('totalOwed')">Owed</button>
        <button class="stats-sort-btn${_statsSortKey === 'name' ? ' active' : ''}" id="ssb-name" onclick="sortStats('name')">A–Z</button>
      </div>
      <div class="stats-cards" id="stats-cards-body"></div>`;
  renderStatsCards(players);
}

async function loadStats(force = false) {
  const seq = ++_statsLoadSeq;
  const gen = _loadGeneration;
  const loading = document.getElementById('stats-loading');
  const tableWrap = document.getElementById('stats-table-wrap');
  const noStats = document.getElementById('no-stats');

  updateStatsAddPlayerVisibility();
  const hasCache = _knownPlayers.length > 0;
  const cacheFresh = hasCache && (Date.now() - _playersCacheTime < PLAYERS_CACHE_MS);

  if (hasCache && !force) {
    renderStatsUI(_knownPlayers);
    if (cacheFresh) {
      loading.style.display = 'none';
      return;
    }
  } else {
    loading.style.display = '';
    tableWrap.innerHTML = '';
    noStats.style.display = 'none';
  }

  try {
    const data = await api('players', {}, 'GET', { silent: true });
    if (_loadGeneration !== gen || seq !== _statsLoadSeq) return;

    if (data.error) {
      if (!hasCache || force) {
        tableWrap.innerHTML = `<div class="empty-state"><p>${escapeHtml(data.error)}</p></div>`;
        showToast(data.error, 'error');
      }
      return;
    }

    const players = mergePlayerStats(data.players || []);
    _knownPlayers = players;
    _playersCacheTime = Date.now();
    renderStatsUI(players);
  } finally {
    if (seq === _statsLoadSeq) loading.style.display = 'none';
  }
}

function mergePlayerStats(players) {
  const rows = players.map(p => ({ ...p }));
  const merged = [];
  const used = new Set();

  for (let i = 0; i < rows.length; i++) {
    if (used.has(i)) continue;
    const acc = { ...rows[i] };
    used.add(i);
    const nameKey = normalizePlayerKey(acc.name);

    for (let j = i + 1; j < rows.length; j++) {
      if (used.has(j)) continue;
      const other = rows[j];
      const samePerson = (acc.playerId && acc.playerId === other.playerId) ||
        (nameKey && nameKey === normalizePlayerKey(other.name));
      if (!samePerson) continue;
      used.add(j);
      if (other.playerId && !acc.playerId) acc.playerId = other.playerId;
      if (other.playerId && other.name) acc.name = other.name;
      acc.matches += other.matches;
      acc.totalOwed += other.totalOwed;
      acc.totalPaid += other.totalPaid;
      acc.outstanding += other.outstanding;
    }
    merged.push(acc);
  }
  return merged;
}

function getExpandedPlayerIds() {
  const ids = new Set();
  document.querySelectorAll('.stat-card-expanded[data-player-id]').forEach(card => {
    const id = card.dataset.playerId;
    if (id) ids.add(id);
  });
  return ids;
}

function renderStatsCards(players) {
  const expanded = getExpandedPlayerIds();
  const body = document.getElementById('stats-cards-body');
  if (!body) return;
  body.innerHTML = players.map((p, i) => renderStatCard(p, i)).join('');
  expanded.forEach(pid => {
    const card = document.querySelector(`.stat-card[data-player-id="${CSS.escape(pid)}"]`);
    if (!card) return;
    const historyEl = card.querySelector('.stat-card-history');
    const expandBtn = card.querySelector('.stat-expand-btn');
    if (!historyEl) return;
    card.classList.add('stat-card-expanded');
    if (expandBtn) expandBtn.textContent = '▼';
    historyEl.style.display = '';
    if (_playerHistoryCache[pid]) {
      historyEl.innerHTML = renderPlayerHistory(_playerHistoryCache[pid]);
    }
  });
}

function renderStatCard(p, index = 0) {
  const dueClass = p.outstanding > 0 ? 'due-positive' : 'due-zero';
  const isAdmin = !!getAdminBypass();
  const adminHtml = isAdmin ? `
        <div class="stat-card-actions">
          <button type="button" class="stat-action-btn" title="Rename" data-rename-name="${escapeAttr(p.name)}" data-rename-id="${escapeAttr(p.playerId || '')}">✎</button>
        </div>` : '';
  const expandable = p.playerId && p.matches > 0;
  const expandBtn = expandable ? `<button type="button" class="stat-expand-btn" data-player-id="${escapeAttr(p.playerId)}" title="Match history">▶</button>` : '';
  return `
    <div class="stat-card${expandable ? ' stat-card-expandable' : ''}" data-player-id="${escapeAttr(p.playerId || '')}" style="animation-delay:${index * 40}ms">
      <div class="stat-card-top">
        <span class="stat-name">${escapeHtml(p.name)}</span>${adminHtml}
        <span class="stat-games">${p.matches} game${p.matches !== 1 ? 's' : ''}</span>
        ${expandBtn}
      </div>
      <div class="stat-card-nums">
        <div class="stat-num">
          <span class="stat-num-label">Owed</span>
          <span class="stat-num-val">₹${p.totalOwed}</span>
        </div>
        <div class="stat-num">
          <span class="stat-num-label">Paid</span>
          <span class="stat-num-val paid-val">₹${p.totalPaid}</span>
        </div>
        <div class="stat-num">
          <span class="stat-num-label">Due</span>
          <span class="stat-num-val ${dueClass}">₹${p.outstanding}</span>
        </div>
      </div>
      <div class="stat-card-history" style="display:none"></div>
    </div>`;
}

let _statsSortKey = 'matches';
let _statsSortAsc = false;

function sortStats(key) {
  if (_statsSortKey === key) {
    _statsSortAsc = !_statsSortAsc;
  } else {
    _statsSortKey = key;
    _statsSortAsc = key === 'name';
  }

  document.querySelectorAll('.stats-sort-btn').forEach(b => b.classList.remove('active'));
  const btn = document.getElementById('ssb-' + key);
  if (btn) btn.classList.add('active');

  const players = window._statsPlayers || [];
  players.sort((a, b) => {
    let va = a[key], vb = b[key];
    if (typeof va === 'string') {
      return _statsSortAsc ? va.localeCompare(vb) : vb.localeCompare(va);
    }
    return _statsSortAsc ? va - vb : vb - va;
  });

  renderStatsCards(players);
}

// --- Player History Drill-down ---

const _playerHistoryCache = {};
const _historyLoading = new Set();

function invalidatePlayerHistoryCache(playerId) {
  if (playerId) delete _playerHistoryCache[playerId];
  else Object.keys(_playerHistoryCache).forEach(k => delete _playerHistoryCache[k]);
}

async function togglePlayerHistory(playerId, card) {
  if (!playerId || !card) return;
  const historyEl = card.querySelector('.stat-card-history');
  const expandBtn = card.querySelector('.stat-expand-btn');
  if (!historyEl) return;

  const isOpen = historyEl.style.display !== 'none';
  if (isOpen) {
    historyEl.style.display = 'none';
    if (expandBtn) expandBtn.textContent = '▶';
    card.classList.remove('stat-card-expanded');
    return;
  }

  card.classList.add('stat-card-expanded');
  if (expandBtn) expandBtn.textContent = '▼';
  historyEl.style.display = '';

  if (_playerHistoryCache[playerId]) {
    historyEl.innerHTML = renderPlayerHistory(_playerHistoryCache[playerId]);
    return;
  }

  if (_historyLoading.has(playerId)) return;
  _historyLoading.add(playerId);
  historyEl.innerHTML = '<div class="history-loading">Loading match history…</div>';
  const data = await api('playerHistory', { id: playerId }, 'GET', { silent: true });
  _historyLoading.delete(playerId);

  if (data.error) {
    historyEl.innerHTML = `<div class="history-loading">${escapeHtml(data.error)}</div>`;
    return;
  }

  _playerHistoryCache[playerId] = data.history || [];
  historyEl.innerHTML = renderPlayerHistory(data.history || []);
}

function renderPlayerHistory(history) {
  if (!history.length) return '<div class="history-empty">No match history</div>';
  return '<div class="history-list">' + history.map(h => {
    const dateStr = h.date ? formatDate(h.date) : 'Unknown date';
    const paidClass = h.paid ? 'history-paid' : 'history-unpaid';
    const paidLabel = h.paid ? '✓ Paid' : 'Unpaid';
    return `<div class="history-row">
      <div class="history-row-top">
        <span class="history-date">${escapeHtml(dateStr)}</span>
        <span class="history-payto">Pay to: ${escapeHtml(h.payTo || '—')}</span>
      </div>
      <div class="history-row-bottom">
        <span class="history-amount">₹${h.amount}</span>
        <span class="history-status ${paidClass}">${paidLabel}</span>
      </div>
    </div>`;
  }).join('') + '</div>';
}

// --- Add Player (from Stats page) ---

function toggleAddPlayerForm() {
  const form = document.getElementById('add-player-form');
  const btn = document.getElementById('btn-add-player-toggle');
  if (!form) return;
  const showing = form.style.display !== 'none';
  form.style.display = showing ? 'none' : '';
  btn.textContent = showing ? '+ Add Player' : '− Cancel';
  if (!showing) {
    const input = document.getElementById('add-player-input');
    if (input) { input.value = ''; setTimeout(() => input.focus(), 50); }
  }
}

let _addPlayerPending = false;

async function submitAddPlayer() {
  if (!getAdminBypass()) return showToast('Admin access required', 'error');
  if (_addPlayerPending) return;
  const input = document.getElementById('add-player-input');
  const btn = document.getElementById('btn-add-player-submit');
  if (!input || !btn) return;

  const name = input.value.trim();
  if (!name) return showToast('Enter a player name', 'error');

  _addPlayerPending = true;
  setBtnBusy(btn, true, 'Adding…', 'Add');
  setAppBusy(true, 'Adding to roster…');
  try {
    const data = await api('addPlayer', { playerName: name }, 'POST', { silent: true });
    if (data.error) return showToast(data.error, 'error');
    input.value = '';
    haptic(HAPTIC.tick);
    showToast(`${data.playerName || name} added to roster!`);
    invalidatePlayersCache();
    await loadStats(true);
  } finally {
    _addPlayerPending = false;
    setBtnBusy(btn, false, 'Adding…', 'Add');
    setAppBusy(false);
  }
}

// --- Share (WhatsApp-friendly) ---
function getMatchPlayerUrl(matchId) {
  const base = window.location.origin + window.location.pathname;
  return `${base}#/match/${encodeURIComponent(matchId)}`;
}

function buildShareContent(match) {
  const players = match.players || [];
  const hasCost = match.totalCost > 0;
  const dateStr = formatDate(match.date);
  const url = getMatchPlayerUrl(match.matchId);
  const shareTitle = `🏏 Cricket Match — ${dateStr}`;
  let body = '';

  if (hasCost) {
    const isExact = isExactSplit(match);
    if (isExact) {
      body += `💰 Custom split · ₹${match.totalCost} total\n`;
    } else {
      const per = expectedPerPlayer(match) || match.perPlayerCost;
      body += `💰 ₹${per} per player (₹${match.totalCost} total)\n`;
    }
    if (match.payTo) {
      body += `📤 Pay to: ${match.payTo}`;
      if (match.payToUPI) body += ` (${match.payToUPI})`;
      body += `\n`;
    }
    body += `\n`;

    const paid = players.filter(p => p.paid);
    const unpaid = players.filter(p => !p.paid);

    if (paid.length > 0) {
      body += `✅ Paid (${paid.length}):\n`;
      paid.forEach(p => { body += `  • ${p.name} — ₹${getPlayerOwed(match, p)}\n`; });
      body += `\n`;
    }
    if (unpaid.length > 0) {
      body += `⏳ Pending (${unpaid.length}):\n`;
      unpaid.forEach(p => { body += `  • ${p.name} — ₹${getPlayerOwed(match, p)}\n`; });
      body += `\n`;
    }

    body += `Open match:\n${url}`;
  } else {
    body += `👥 ${players.length} player${players.length !== 1 ? 's' : ''} checked in\n`;
    body += `💰 Cost not set yet\n\n`;
    body += `Check in here:\n${url}`;
  }

  return { shareTitle, body, msg: `${shareTitle}\n\n${body}`, url };
}

function openInfoModal() {
  const modal = document.getElementById('info-modal');
  if (modal && !modal.open) modal.showModal();
}

function closeInfoModal() {
  const modal = document.getElementById('info-modal');
  if (modal && modal.open) modal.close();
}

function openShareMenu() {
  if (!_currentMatch) return;
  const modal = document.getElementById('share-modal');
  if (modal && !modal.open) modal.showModal();
}

function closeShareMenu() {
  const modal = document.getElementById('share-modal');
  if (modal && modal.open) modal.close();
}

async function copyMatchLink() {
  if (!_currentMatch) return;
  const url = getMatchPlayerUrl(_currentMatch.matchId);
  try {
    await navigator.clipboard.writeText(url);
    closeShareMenu();
    showToast('Link copied!');
  } catch (e) {
    showToast('Could not copy link', 'error');
  }
}

async function shareToGroup() {
  if (!_currentMatch) return;
  const { shareTitle, body, msg } = buildShareContent(_currentMatch);

  if (navigator.share) {
    try {
      await navigator.share({ title: shareTitle, text: body });
      closeShareMenu();
      return;
    } catch (e) {
      // User cancelled or share failed, fall through to clipboard
    }
  }

  try {
    await navigator.clipboard.writeText(msg);
    closeShareMenu();
    showToast('Copied to clipboard! Paste in your group');
  } catch (e) {
    showToast('Could not copy to clipboard', 'error');
  }
}

// --- Confetti ---
function fireConfetti() {
  const canvas = document.getElementById('confetti-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;

  const colors = ['#34E27A', '#FFB020', '#FF5C5C', '#4DA3FF', '#F5F7FA'];
  const pieces = Array.from({ length: 80 }, () => ({
    x: canvas.width / 2 + (Math.random() - 0.5) * 200,
    y: canvas.height / 2,
    vx: (Math.random() - 0.5) * 16,
    vy: Math.random() * -18 - 4,
    size: Math.random() * 8 + 4,
    color: colors[Math.floor(Math.random() * colors.length)],
    rotation: Math.random() * 360,
    rotSpeed: (Math.random() - 0.5) * 12,
    gravity: 0.4 + Math.random() * 0.2
  }));

  let frame = 0;
  function animate() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    let alive = false;
    pieces.forEach(p => {
      p.x += p.vx;
      p.vy += p.gravity;
      p.y += p.vy;
      p.rotation += p.rotSpeed;
      p.vx *= 0.99;
      if (p.y < canvas.height + 50) alive = true;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rotation * Math.PI / 180);
      ctx.fillStyle = p.color;
      ctx.globalAlpha = Math.max(0, 1 - frame / 100);
      ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.6);
      ctx.restore();
    });
    frame++;
    if (alive && frame < 120) requestAnimationFrame(animate);
    else ctx.clearRect(0, 0, canvas.width, canvas.height);
  }
  animate();
}

// --- Utilities ---
function formatDate(dateStr) {
  try {
    const d = new Date(dateStr + 'T12:00:00');
    if (isNaN(d.getTime())) return dateStr || 'Unknown date';
    return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
  } catch {
    return dateStr || 'Unknown date';
  }
}

function escapeHtml(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function escapeAttr(str) {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// --- Toast ---
let toastTimeout;
function showToast(msg, type = '', durationMs = 2500) {
  let toast = document.querySelector('.toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.className = 'toast';
    document.body.appendChild(toast);
  }

  let icon = '';
  if (type === 'error') icon = '<span class="toast-icon">⚠</span>';
  else if (msg.includes('!')) icon = '<span class="toast-icon">✓</span>';

  toast.innerHTML = icon + escapeHtml(msg);
  toast.className = 'toast' + (type === 'error' ? ' error' : type === 'success' ? ' success' : '');

  clearTimeout(toastTimeout);
  requestAnimationFrame(() => {
    toast.classList.add('show');
    toastTimeout = setTimeout(() => toast.classList.remove('show'), durationMs);
  });
}

function showPaidUndoToast(playerName, el) {
  let toast = document.querySelector('.toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.className = 'toast';
    document.body.appendChild(toast);
  }

  toast.className = 'toast toast-with-action';
  toast.innerHTML =
    '<span class="toast-icon">✓</span>' +
    '<span class="toast-msg">Marked paid</span>' +
    '<button type="button" class="toast-action">Undo</button>';

  const undoBtn = toast.querySelector('.toast-action');
  if (undoBtn) {
    undoBtn.onclick = e => {
      e.stopPropagation();
      clearTimeout(toastTimeout);
      toast.classList.remove('show');
      const row = el?.closest?.('.player-item') || document.querySelector(
        `.player-item[data-player-name="${CSS.escape(playerName)}"]`
      );
      if (row) togglePaid(row, playerName, false);
    };
  }

  clearTimeout(toastTimeout);
  requestAnimationFrame(() => {
    toast.classList.add('show');
    toastTimeout = setTimeout(() => toast.classList.remove('show'), PAID_UNDO_TOAST_MS);
  });
}
