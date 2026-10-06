const PROJECT_URL = "https://flparzaocyzmqjokavxs.supabase.co";
const PUBLISHABLE_KEY = "sb_publishable_51TIFMIU6W70ERupCuS9_Q_tNnppZZy";
const SESSION_KEY = 'workTimeMonitorAdminSession';
const TIP_KEY = 'workTimeAdminIosTipDismissed';

let snapshotRows = [];
let rangeRows = [];
let refreshTimer = null;
let refreshInFlight = false;
let refreshQueued = false;
let realtimeSocket = null;
let realtimeHeartbeat = null;
let realtimeReconnect = null;
let realtimeRefresh = null;
let realtimeRef = 0;

function $(id) { return document.getElementById(id); }

function getSession() {
  try { return JSON.parse(localStorage.getItem(SESSION_KEY) || '{}'); }
  catch { return {}; }
}

function setSession(session) {
  localStorage.setItem(SESSION_KEY, JSON.stringify(session || {}));
}

function clearSession() {
  localStorage.removeItem(SESSION_KEY);
}

function loginMessage(text, ok = true) {
  $('loginMessage').textContent = text || '';
  $('loginMessage').className = `message ${ok ? 'good' : 'bad'}`;
}

async function authRequest(path, body) {
  const response = await fetch(`${PROJECT_URL}${path}`, {
    method: 'POST',
    headers: {
      apikey: PUBLISHABLE_KEY,
      'Content-Type': 'application/json',
      Authorization: `Bearer ${PUBLISHABLE_KEY}`
    },
    body: JSON.stringify(body)
  });

  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }

  if (!response.ok) {
    const detail = data?.message || data?.error_description || data?.error || text || response.statusText;
    throw new Error(detail);
  }

  return data;
}

async function refreshSession() {
  const current = getSession();
  if (!current.refresh_token) throw new Error('Session expired.');

  const data = await authRequest('/auth/v1/token?grant_type=refresh_token', {
    refresh_token: current.refresh_token
  });
  setSession(data);
  return data;
}

async function supabaseRequest(path, { method = 'GET', body = null, retry = true } = {}) {
  let session = getSession();

  const doFetch = async () => {
    session = getSession();
    return fetch(`${PROJECT_URL}${path}`, {
      method,
      headers: {
        apikey: PUBLISHABLE_KEY,
        'Content-Type': 'application/json',
        Authorization: session.access_token
          ? `Bearer ${session.access_token}`
          : `Bearer ${PUBLISHABLE_KEY}`
      },
      body: body ? JSON.stringify(body) : null
    });
  };

  let response = await doFetch();

  if (response.status === 401 && retry && session.refresh_token) {
    await refreshSession();
    response = await doFetch();
  }

  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }

  if (!response.ok) {
    const detail = data?.message || data?.error_description || data?.error || text || response.statusText;
    throw new Error(detail);
  }

  return data;
}

async function login() {
  const email = $('email').value.trim();
  const password = $('password').value;

  if (!email || !password) {
    loginMessage('Enter the admin email and password.', false);
    return;
  }

  $('loginBtn').disabled = true;
  loginMessage('Signing in…', true);

  try {
    const data = await authRequest('/auth/v1/token?grant_type=password', { email, password });
    setSession(data);
    $('password').value = '';
    loginMessage('', true);
    await showAdmin();
  } catch (error) {
    loginMessage(error.message, false);
  } finally {
    $('loginBtn').disabled = false;
  }
}

function showLoggedOut() {
  $('adminApp').classList.add('hidden');
  $('headerActions').classList.add('hidden');
  $('loginSection').classList.remove('hidden');
  stopRefreshTimer();
  stopRealtime();
}

async function logout() {
  const session = getSession();

  try {
    if (session.access_token) {
      await fetch(`${PROJECT_URL}/auth/v1/logout`, {
        method: 'POST',
        headers: {
          apikey: PUBLISHABLE_KEY,
          Authorization: `Bearer ${session.access_token}`
        }
      });
    }
  } catch {}

  clearSession();
  snapshotRows = [];
  rangeRows = [];
  showLoggedOut();
  loginMessage('Logged out.', true);
}

async function showAdmin() {
  $('loginSection').classList.add('hidden');
  $('adminApp').classList.remove('hidden');
  $('headerActions').classList.remove('hidden');

  setDefaultDates();
  updateIosTip();

  try {
    await Promise.all([loadSnapshot(), loadRange()]);
    startRealtime();
    startRefreshTimer();
  } catch (error) {
    if (/jwt|session|token|unauthorized/i.test(error.message || '')) {
      clearSession();
      showLoggedOut();
      loginMessage('Your session expired. Please log in again.', false);
      return;
    }
    alert(error.message);
  }
}

function scheduleRealtimeRefresh() {
  clearTimeout(realtimeRefresh);
  realtimeRefresh = setTimeout(() => {
    if (!document.hidden && !$('adminApp').classList.contains('hidden')) {
      loadSnapshot().catch(() => {});
    }
  }, 150);
}

function sendRealtime(topic, event, payload = {}) {
  if (!realtimeSocket || realtimeSocket.readyState !== WebSocket.OPEN) return;
  realtimeRef += 1;
  realtimeSocket.send(JSON.stringify({
    topic,
    event,
    payload,
    ref: String(realtimeRef)
  }));
}

function startRealtime() {
  stopRealtime();
  const session = getSession();
  if (!session.access_token) return;

  const endpoint = PROJECT_URL.replace(/^http/, 'ws') +
    `/realtime/v1/websocket?apikey=${encodeURIComponent(PUBLISHABLE_KEY)}&vsn=1.0.0`;
  const socket = new WebSocket(endpoint);
  realtimeSocket = socket;

  realtimeSocket.addEventListener('open', () => {
    sendRealtime('realtime:work-time-monitor', 'phx_join', {
      config: {
        broadcast: { self: false },
        presence: { key: '' },
        postgres_changes: [
          { event: 'UPDATE', schema: 'public', table: 'monitor_devices' },
          { event: 'INSERT', schema: 'public', table: 'monitor_status_events' }
        ]
      },
      access_token: getSession().access_token
    });

    realtimeHeartbeat = setInterval(() => {
      sendRealtime('phoenix', 'heartbeat', {});
    }, 25000);
  });

  realtimeSocket.addEventListener('message', event => {
    try {
      const message = JSON.parse(event.data);
      if (message.event === 'postgres_changes') scheduleRealtimeRefresh();
    } catch {}
  });

  realtimeSocket.addEventListener('close', () => {
    clearInterval(realtimeHeartbeat);
    realtimeHeartbeat = null;
    if (realtimeSocket !== socket) return;
    realtimeSocket = null;
    if (!$('adminApp').classList.contains('hidden')) {
      realtimeReconnect = setTimeout(startRealtime, 3000);
    }
  });
}

function stopRealtime() {
  clearTimeout(realtimeReconnect);
  clearTimeout(realtimeRefresh);
  clearInterval(realtimeHeartbeat);
  realtimeReconnect = null;
  realtimeRefresh = null;
  realtimeHeartbeat = null;
  if (realtimeSocket) {
    realtimeSocket.close();
    realtimeSocket = null;
  }
}

function isStandalone() {
  return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
}

function updateIosTip() {
  const dismissed = localStorage.getItem(TIP_KEY) === '1';
  $('iosTip').classList.toggle('hidden', dismissed || isStandalone());
}

function formatSeconds(seconds) {
  seconds = Math.max(0, Number(seconds) || 0);
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}

function timeAgo(timestamp) {
  if (!timestamp) return 'Never';
  const diff = Math.max(0, Date.now() - new Date(timestamp).getTime());
  const seconds = Math.floor(diff / 1000);
  if (seconds < 10) return 'Just now';
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

function formatDominicanTime(timestamp) {
  if (!timestamp) return '—';

  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '—';

  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Santo_Domingo',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  }).format(date);
}

async function loadSnapshot() {
  if (refreshInFlight) {
    refreshQueued = true;
    return;
  }
  refreshInFlight = true;

  try {
    // Employee/device list is the primary data source and must always load.
    const devices = await supabaseRequest('/rest/v1/rpc/monitor_admin_devices', {
      method: 'POST',
      body: {}
    });

    // Secondary metrics are intentionally fault-tolerant. If one optional
    // metric RPC fails, employees still remain visible in the dashboard.
    let interpretingRows = [];
    let callRows = [];
    let attendanceRows = [];

    try {
      interpretingRows = await supabaseRequest(
        '/rest/v1/rpc/monitor_admin_interpreting_today',
        { method: 'POST', body: {} }
      );
    } catch (error) {
      console.warn('Interpreting Today unavailable:', error);
    }

    try {
      callRows = await supabaseRequest(
        '/rest/v1/rpc/monitor_admin_calls_today',
        { method: 'POST', body: {} }
      );
    } catch (error) {
      console.warn('Calls Today unavailable:', error);
    }

    try {
      attendanceRows = await supabaseRequest(
        '/rest/v1/rpc/monitor_admin_attendance_today',
        { method: 'POST', body: {} }
      );
    } catch (error) {
      console.warn('Attendance Today unavailable:', error);
    }

    const interpretingByDevice = new Map(
      (interpretingRows || []).map(row => [
        row.device_id,
        Number(row.interpreting_seconds) || 0
      ])
    );

    const callsByDevice = new Map(
      (callRows || []).map(row => [
        row.device_id,
        Number(row.call_count) || 0
      ])
    );

    const attendanceByDevice = new Map(
      (attendanceRows || []).map(row => [row.device_id, row])
    );

    snapshotRows = (devices || []).map(row => {
      const attendance = attendanceByDevice.get(row.device_id) || {};
      return {
        ...row,
        interpreting_today_seconds: interpretingByDevice.get(row.device_id) || 0,
        calls_today: callsByDevice.get(row.device_id) || 0,
        started_today_at: attendance.started_today_at || null,
        last_offline_at: attendance.last_offline_at || null,
        offline_today_seconds: attendance.offline_today_seconds == null
          ? null
          : Number(attendance.offline_today_seconds) || 0
      };
    });

    renderSnapshot();
    $('lastRefresh').textContent =
      `Updated ${new Date().toLocaleTimeString([], {hour:'numeric', minute:'2-digit'})}`;
  } finally {
    refreshInFlight = false;
    if (refreshQueued) {
      refreshQueued = false;
      queueMicrotask(() => loadSnapshot().catch(() => {}));
    }
  }
}

function renderSnapshot() {
  const container = $('employeeCards');
  container.innerHTML = '';

  const connectedCount = snapshotRows.filter(row => row.connected_now).length;
  const teamToday = snapshotRows.reduce(
    (sum, row) => sum + (Number(row.connected_today_seconds) || 0),
    0
  );
  const teamInterpretingToday = snapshotRows.reduce(
    (sum, row) => sum + (Number(row.interpreting_today_seconds) || 0),
    0
  );

  $('employeeCount').textContent = String(snapshotRows.length);
  $('connectedCount').textContent = String(connectedCount);
  $('teamToday').textContent = formatSeconds(teamToday);
  const teamCallsToday = snapshotRows.reduce(
    (sum, row) => sum + (Number(row.calls_today) || 0), 0
  );
  $('teamInterpretingToday').textContent = formatSeconds(teamInterpretingToday);
  $('teamCallsToday').textContent = String(teamCallsToday);

  if (!snapshotRows.length) {
    container.innerHTML = '<div class="emptyState">No employees yet.</div>';
    return;
  }

  for (const row of snapshotRows) {
    const neverSeen = !row.last_seen_at;
    const statusClass = row.connected_now ? 'online' : 'offline';
    const statusText = neverSeen
      ? 'NOT ACTIVATED'
      : row.connected_now
        ? (row.current_status || 'CONNECTED')
        : 'OFFLINE';

    const card = document.createElement('article');
    card.className = 'employeeCard';
    card.innerHTML = `
      <div class="employeeTop">
        <h3 class="employeeName">${escapeHtml(row.label || 'Unnamed')}</h3>
        <span class="badge ${statusClass}">${escapeHtml(statusText)}</span>
      </div>

      <div class="employeeStats">
        <div class="stat">
          <span>Connected Today</span>
          <strong>${formatSeconds(row.connected_today_seconds)}</strong>
        </div>
        <div class="stat">
          <span>Interpreting Today</span>
          <strong class="interpretingValue">${formatSeconds(row.interpreting_today_seconds)}</strong>
        </div>
        <div class="stat">
          <span>Calls Today</span>
          <strong class="callValue">${Number(row.calls_today) || 0}</strong>
        </div>
        <div class="stat">
          <span>Last signal</span>
          <strong>${timeAgo(row.last_seen_at)}</strong>
        </div>
        <div class="stat attendanceStat">
          <span>Started Today</span>
          <strong>${formatDominicanTime(row.started_today_at)}</strong>
        </div>
        <div class="stat attendanceStat">
          <span>Last Offline</span>
          <strong>${formatDominicanTime(row.last_offline_at)}</strong>
        </div>
        <div class="stat offlineTotalStat">
          <span>Offline Today</span>
          <strong>${row.offline_today_seconds == null ? '—' : formatSeconds(row.offline_today_seconds)}</strong>
        </div>
      </div>

      <div class="employeeActions">
        <button class="secondary renameBtn" data-id="${escapeHtml(row.device_id)}" data-label="${escapeHtml(row.label || '')}">Rename</button>
        <button class="warning deactivateBtn" data-id="${escapeHtml(row.device_id)}" data-label="${escapeHtml(row.label || '')}">Deactivate</button>
        <button class="danger deleteBtn" data-id="${escapeHtml(row.device_id)}" data-label="${escapeHtml(row.label || '')}">Delete</button>
      </div>
    `;
    container.appendChild(card);
  }

  bindEmployeeActions(container);
}

function bindEmployeeActions(container) {
  for (const button of container.querySelectorAll('.renameBtn')) {
    button.addEventListener('click', async () => {
      const current = button.dataset.label || '';
      const next = prompt('Name shown in dashboard:', current);
      if (next === null || !next.trim() || next.trim() === current) return;

      try {
        await supabaseRequest('/rest/v1/rpc/monitor_admin_rename_device', {
          method: 'POST',
          body: { p_device_id: button.dataset.id, p_label: next.trim() }
        });
        await Promise.all([loadSnapshot(), loadRange()]);
      } catch (error) {
        alert(error.message);
      }
    });
  }

  for (const button of container.querySelectorAll('.deactivateBtn')) {
    button.addEventListener('click', async () => {
      const label = button.dataset.label || 'this employee';
      const ok = confirm(
        `Deactivate "${label}"?\n\n` +
        'This disables that installation and removes it from the active dashboard. Existing history is kept.'
      );
      if (!ok) return;

      try {
        await supabaseRequest('/rest/v1/rpc/monitor_admin_deactivate_device', {
          method: 'POST',
          body: { p_device_id: button.dataset.id }
        });
        await Promise.all([loadSnapshot(), loadRange()]);
      } catch (error) {
        alert(error.message);
      }
    });
  }

  for (const button of container.querySelectorAll('.deleteBtn')) {
    button.addEventListener('click', async () => {
      const label = button.dataset.label || 'this employee';
      const typed = prompt(
        `PERMANENT DELETE\n\n` +
        `This permanently deletes "${label}" and all monitoring history.\n\n` +
        'Type the employee name exactly to confirm:',
        ''
      );

      if (typed === null) return;
      if (typed.trim() !== label.trim()) {
        alert('Name did not match. Nothing was deleted.');
        return;
      }

      try {
        await supabaseRequest('/rest/v1/rpc/monitor_admin_delete_device', {
          method: 'POST',
          body: { p_device_id: button.dataset.id }
        });
        await Promise.all([loadSnapshot(), loadRange()]);
      } catch (error) {
        alert(error.message);
      }
    });
  }
}

async function createDevice() {
  const label = $('deviceLabel').value.trim();
  if (!label) return;

  $('createDeviceBtn').disabled = true;

  try {
    const rows = await supabaseRequest('/rest/v1/rpc/monitor_admin_create_activation', {
      method: 'POST',
      body: { p_label: label }
    });

    const row = Array.isArray(rows) ? rows[0] : rows;
    if (!row?.activation_code) throw new Error('No activation code was returned.');

    $('activationEmployee').textContent = label;
    $('activationCode').textContent = row.activation_code;
    $('activationBox').classList.remove('hidden');
    $('deviceLabel').value = '';

    await loadSnapshot();
  } catch (error) {
    alert(error.message);
  } finally {
    $('createDeviceBtn').disabled = false;
  }
}

async function copyActivationCode() {
  const code = $('activationCode').textContent.trim();
  if (!code) return;

  try {
    await navigator.clipboard.writeText(code);
    const button = $('copyCodeBtn');
    const old = button.textContent;
    button.textContent = 'Copied';
    setTimeout(() => { button.textContent = old; }, 1200);
  } catch {
    alert(`Activation code: ${code}`);
  }
}

function setDefaultDates() {
  if ($('fromDate').value && $('toDate').value) return;

  const now = new Date();
  const start = new Date(now);
  start.setDate(now.getDate() - 13);

  $('fromDate').value = toDateInput(start);
  $('toDate').value = toDateInput(now);
}

function toDateInput(date) {
  return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
}

function dominicanMidnightIso(dateString) {
  // Dominican Republic is UTC-04:00 year-round.
  return `${dateString}T00:00:00-04:00`;
}

function nextCalendarDate(dateString) {
  const [year, month, day] = dateString.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + 1));
  return date.toISOString().slice(0, 10);
}

async function loadRange() {
  const from = $('fromDate').value;
  const to = $('toDate').value;
  if (!from || !to) return;

  const fromIso = dominicanMidnightIso(from);
  const toIso = dominicanMidnightIso(nextCalendarDate(to));

  // Connected totals are the primary range data.
  const connectedRows = await supabaseRequest(
    '/rest/v1/rpc/monitor_admin_device_totals',
    {
      method: 'POST',
      body: { p_from: fromIso, p_to: toIso }
    }
  );

  let interpretingRows = [];
  let callRows = [];

  try {
    interpretingRows = await supabaseRequest(
      '/rest/v1/rpc/monitor_admin_interpreting_totals',
      {
        method: 'POST',
        body: { p_from: fromIso, p_to: toIso }
      }
    );
  } catch (error) {
    console.warn('Interpreting range totals unavailable:', error);
  }

  try {
    callRows = await supabaseRequest(
      '/rest/v1/rpc/monitor_admin_call_totals',
      {
        method: 'POST',
        body: { p_from: fromIso, p_to: toIso }
      }
    );
  } catch (error) {
    console.warn('Call range totals unavailable:', error);
  }

  const interpretingByDevice = new Map(
    (interpretingRows || []).map(row => [
      row.device_id,
      Number(row.interpreting_seconds) || 0
    ])
  );

  const callsByDevice = new Map(
    (callRows || []).map(row => [
      row.device_id,
      Number(row.call_count) || 0
    ])
  );

  rangeRows = (connectedRows || []).map(row => ({
    ...row,
    interpreting_seconds: interpretingByDevice.get(row.device_id) || 0,
    call_count: callsByDevice.get(row.device_id) || 0
  }));

  renderRange();
}

function renderRange() {
  const container = $('rangeCards');
  container.innerHTML = '';

  if (!rangeRows.length) {
    container.innerHTML = '<div class="emptyState">No data for this range.</div>';
    return;
  }

  for (const row of rangeRows) {
    const div = document.createElement('div');
    div.className = 'rangeCard';
    div.innerHTML = `
      <span class="rangeName">${escapeHtml(row.label || 'Unnamed')}</span>
      <div class="rangeTimes">
        <span>Connected: <strong>${formatSeconds(row.connected_seconds)}</strong></span>
        <span>Interpreting: <strong class="interpretingValue">${formatSeconds(row.interpreting_seconds)}</strong></span>
        <span>Calls: <strong class="callValue">${Number(row.call_count) || 0}</strong></span>
      </div>
    `;
    container.appendChild(div);
  }
}

function exportCsv() {
  if (!rangeRows.length) {
    alert('There is no range data to export.');
    return;
  }

  const lines = [[
    'Employee',
    'Connected Seconds',
    'Connected Time',
    'Interpreting Seconds',
    'Interpreting Time',
    'Calls'
  ]];

  for (const row of rangeRows) {
    lines.push([
      row.label || '',
      String(row.connected_seconds || 0),
      formatSeconds(row.connected_seconds),
      String(row.interpreting_seconds || 0),
      formatSeconds(row.interpreting_seconds),
      String(row.call_count || 0)
    ]);
  }

  const csv = lines.map(row => row.map(csvCell).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `work-time-${$('fromDate').value}-to-${$('toDate').value}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function csvCell(value) {
  return `"${String(value ?? '').replace(/"/g, '""')}"`;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&','&amp;')
    .replaceAll('<','&lt;')
    .replaceAll('>','&gt;')
    .replaceAll('"','&quot;')
    .replaceAll("'",'&#039;');
}

function startRefreshTimer() {
  stopRefreshTimer();
  refreshTimer = setInterval(() => {
    if (!document.hidden && !$('adminApp').classList.contains('hidden')) {
      loadSnapshot().catch(() => {});
    }
  // Fallback only. Live changes normally arrive through Supabase Realtime.
  }, 15000);
}

function stopRefreshTimer() {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = null;
}

async function init() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }

  $('loginBtn').addEventListener('click', login);
  $('password').addEventListener('keydown', event => {
    if (event.key === 'Enter') login();
  });
  $('createDeviceBtn').addEventListener('click', createDevice);
  $('copyCodeBtn').addEventListener('click', copyActivationCode);
  $('refreshBtn').addEventListener('click', async () => {
    await Promise.all([loadSnapshot(), loadRange()]);
  });
  $('logoutBtn').addEventListener('click', logout);
  $('loadRangeBtn').addEventListener('click', loadRange);
  $('exportBtn').addEventListener('click', exportCsv);
  $('dismissTip').addEventListener('click', () => {
    localStorage.setItem(TIP_KEY, '1');
    updateIosTip();
  });

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && !$('adminApp').classList.contains('hidden')) {
      loadSnapshot().catch(() => {});
    }
  });

  if (getSession().access_token || getSession().refresh_token) {
    try {
      await showAdmin();
      return;
    } catch {}
  }

  showLoggedOut();
}

init();
