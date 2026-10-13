/* studio-core.js */
(function() {
  window.StudioApp = window.StudioApp || {};

  let toastTimer = null;

  const esc = (str) => {
    if (str === null || str === undefined) return '';
    return String(str).replace(/[&<>"']/g, (s) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    }[s]));
  };

  const detectToastType = (text, explicitType) => {
    if (explicitType && explicitType !== 'auto') return explicitType;
    const s = String(text || '').toLowerCase();
    if (/gagal|error|tidak valid|ditolak|kesalahan|tidak dapat|❌/.test(s)) return 'error';
    if (/maksimal|batas|dikunci|perhatian|belum tersedia|dilewati|⚠️/.test(s)) return 'warning';
    if (/memuat|sinkronisasi|mengecek|menyiapkan|mencoba|⏳/.test(s)) return 'info';
    return 'success';
  };

  const TOAST_ICONS = {
    success: '<svg viewBox="0 0 20 20" fill="none" width="18" height="18"><path d="M16.667 5L7.5 14.167 3.333 10" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    error: '<svg viewBox="0 0 20 20" fill="none" width="18" height="18"><circle cx="10" cy="10" r="7.5" stroke="currentColor" stroke-width="2"/><path d="M10 6.5v4M10 13.5h.01" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
    warning: '<svg viewBox="0 0 20 20" fill="none" width="18" height="18"><path d="M8.575 3.217L1.517 15a1.667 1.667 0 001.425 2.5h14.116a1.667 1.667 0 001.425-2.5L11.425 3.217a1.667 1.667 0 00-2.85 0z" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M10 8v3.5M10 14.2h.01" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
    info: '<svg viewBox="0 0 20 20" fill="none" width="18" height="18"><circle cx="10" cy="10" r="7.5" stroke="currentColor" stroke-width="2"/><path d="M10 9.5v4M10 6.5h.01" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>'
  };

  const toast = (text, type = 'auto') => {
    if (!text) return;
    let el = document.getElementById('st-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'st-toast';
      el.className = 'st-toast';
      el.setAttribute('role', 'status');
      el.setAttribute('aria-live', 'polite');
      document.body.appendChild(el);
    }

    const resolvedType = detectToastType(text, type);
    const cleanText = String(text).replace(/^[✅❌⚠️⏳🔄✨🔒🎉]+\s*/, '');

    el.className = `st-toast st-toast--${resolvedType}`;
    el.innerHTML = `
      <span class="st-toast__icon">${TOAST_ICONS[resolvedType] || TOAST_ICONS.info}</span>
      <span class="st-toast__text">${esc(cleanText)}</span>
      <button type="button" class="st-toast__close" aria-label="Tutup notifikasi">✕</button>
    `;

    const closeBtn = el.querySelector('.st-toast__close');
    if (closeBtn) {
      closeBtn.onclick = () => {
        el.classList.remove('st-show');
        if (toastTimer) clearTimeout(toastTimer);
      };
    }

    // Trigger reflow agar animasi ulang terasa responsif
    void el.offsetWidth;
    el.classList.add('st-show');

    if (toastTimer) clearTimeout(toastTimer);
    const duration = resolvedType === 'error' ? 4500 : 3400;
    toastTimer = setTimeout(() => el.classList.remove('st-show'), duration);
  };

  const confirmDialog = (opts) => {
    const options = typeof opts === 'string' ? { message: opts } : (opts || {});
    const title = options.title || 'Konfirmasi Tindakan';
    const message = options.message || 'Apakah Anda yakin ingin melanjutkan?';
    const confirmText = options.confirmText || 'Ya, Lanjutkan';
    const cancelText = options.cancelText || 'Batal';
    const variant = options.variant || (options.danger ? 'danger' : 'warning');

    return new Promise((resolve) => {
      let wrap = document.getElementById('st-confirm-wrap');
      if (!wrap) {
        wrap = document.createElement('div');
        wrap.id = 'st-confirm-wrap';
        document.body.appendChild(wrap);
      }

      const iconSvg = variant === 'danger' ? TOAST_ICONS.error : TOAST_ICONS.warning;

      wrap.innerHTML = `
        <div class="st-dialog-backdrop st-open" id="st-confirm-backdrop"></div>
        <div class="st-dialog st-confirm-dialog st-open" role="alertdialog" aria-modal="true" aria-labelledby="st-confirm-title" aria-describedby="st-confirm-desc">
          <div class="st-confirm-header">
            <div class="st-confirm-icon st-confirm-icon--${esc(variant)}">${iconSvg}</div>
            <div>
              <h3 id="st-confirm-title" class="st-confirm-title">${esc(title)}</h3>
              <p id="st-confirm-desc" class="st-confirm-message">${esc(message)}</p>
            </div>
          </div>
          <div class="st-confirm-actions">
            <button type="button" class="st-btn st-btn-outline" id="st-confirm-cancel">${esc(cancelText)}</button>
            <button type="button" class="st-btn ${variant === 'danger' ? 'st-btn-danger' : 'st-btn-primary'}" id="st-confirm-ok">${esc(confirmText)}</button>
          </div>
        </div>
      `;

      const cleanup = (result) => {
        document.removeEventListener('keydown', onKey);
        wrap.innerHTML = '';
        resolve(result);
      };

      const onKey = (e) => {
        if (e.key === 'Escape') cleanup(false);
      };
      document.addEventListener('keydown', onKey);

      document.getElementById('st-confirm-cancel').onclick = () => cleanup(false);
      document.getElementById('st-confirm-backdrop').onclick = () => cleanup(false);
      const okBtn = document.getElementById('st-confirm-ok');
      okBtn.onclick = () => cleanup(true);
      setTimeout(() => okBtn.focus(), 20);
    });
  };

  const copyText = async (text, msg = 'Disalin!') => {
    if (!text) return false;
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        if (msg) toast(msg, 'success');
        return true;
      }
    } catch (e) {}

    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      ta.style.top = '0';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      if (msg) toast(msg, 'success');
      return true;
    } catch (err) {
      toast('Gagal menyalin teks', 'error');
      return false;
    }
  };

  const extractFolderId = (input) => {
    if (!input) return null;
    input = input.trim();
    if (/^[A-Za-z0-9_-]{10,}$/.test(input)) return input;
    try {
      const url = new URL(input);
      if (url.hostname.includes('drive.google.com')) {
        const m = url.pathname.match(/\/folders\/([A-Za-z0-9_-]+)/);
        if (m) return m[1];
        const idParam = url.searchParams.get('id');
        if (idParam && /^[A-Za-z0-9_-]{10,}$/.test(idParam)) return idParam;
      }
    } catch (e) {}
    return null;
  };

  const parseJsonLoose = (rawText) => {
    const trimmed = (rawText || '').trim();
    if (!trimmed) return { ok: true, _empty: true };
    try {
      return JSON.parse(trimmed);
    } catch (firstErr) {
      // Ekstrak blok JSON jika ada PHP notice/warning atau teks lain di luar JSON
      const firstBrace = trimmed.indexOf('{');
      const firstBracket = trimmed.indexOf('[');
      let start = -1;
      if (firstBrace !== -1 && firstBracket !== -1) start = Math.min(firstBrace, firstBracket);
      else start = firstBrace !== -1 ? firstBrace : firstBracket;

      if (start !== -1) {
        const lastBrace = trimmed.lastIndexOf('}');
        const lastBracket = trimmed.lastIndexOf(']');
        const end = Math.max(lastBrace, lastBracket);
        if (end > start) {
          try {
            return JSON.parse(trimmed.slice(start, end + 1));
          } catch (secondErr) {}
        }
      }
      return null;
    }
  };

  const apiFetch = async (path, options = {}) => {
    const config = window.StudioConfig || {};
    let resolvedPath = path;
    const rawMethod = (options.method || 'GET').toUpperCase();
    let effectiveMethod = rawMethod;
    const headers = {
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    };

    if (config.role === 'client') {
      const token = sessionStorage.getItem('st_token') || localStorage.getItem('st_token');
      if (token) headers['X-Studio-Token'] = token;
    } else {
      if (config.isAdmin && config.nonce) {
        headers['X-WP-Nonce'] = config.nonce;
      }
      const key = localStorage.getItem('st_editor_key');
      if (key) headers['X-Studio-Key'] = key;
    }

    // Tunneling untuk kompatibilitas penuh dengan firewall/WAF shared hosting (LiteSpeed/ModSecurity)
    if (rawMethod === 'DELETE' && /^\/editor\/galleries\/\d+$/.test(resolvedPath)) {
      resolvedPath = resolvedPath + '/delete';
      effectiveMethod = 'POST';
    } else if (rawMethod === 'PUT' || rawMethod === 'PATCH' || rawMethod === 'DELETE') {
      effectiveMethod = 'POST';
      headers['X-HTTP-Method-Override'] = rawMethod;
    }

    const url = (config.apiBase || '') + resolvedPath;
    const fetchOpts = {
      cache: 'no-store',
      ...options,
      method: effectiveMethod,
      headers: { ...headers, ...(options.headers || {}) }
    };

    let res;
    let rawText = '';
    const maxAttempts = rawMethod === 'GET' ? 2 : 1;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        res = await fetch(url, fetchOpts);
        rawText = await res.text();
        if (attempt < maxAttempts && (res.status === 502 || res.status === 503 || res.status === 504)) {
          await new Promise(r => setTimeout(r, 500));
          continue;
        }
        break;
      } catch (netErr) {
        if (attempt < maxAttempts) {
          await new Promise(r => setTimeout(r, 500));
          continue;
        }
        throw new Error('Koneksi ke server terputus. Periksa jaringan internet Anda.');
      }
    }

    const data = parseJsonLoose(rawText);
    if (data === null) {
      if (res.status === 403 || res.status === 405) {
        throw new Error(`Permintaan ditolak oleh keamanan server (HTTP ${res.status}). Silakan muat ulang halaman.`);
      }
      if (res.status >= 500) {
        throw new Error(`Server sedang mengalami gangguan (HTTP ${res.status}). Silakan coba lagi sebentar.`);
      }
      throw new Error(`Respons server tidak dapat dibaca (HTTP ${res.status}). Silakan muat ulang halaman.`);
    }

    if (!res.ok) {
      const err = new Error(data.message || data.error || `Terjadi kesalahan (HTTP ${res.status})`);
      err.status = res.status;
      err.code = data.code || '';
      throw err;
    }
    return data;
  };

  const openDialog = (id) => {
    const d = document.getElementById(id);
    const bd = document.getElementById(id + '-backdrop');
    if (d) d.classList.add('st-open');
    if (bd) {
      bd.classList.add('st-open');
      bd.onclick = () => closeDialog(id);
    }
  };

  const closeDialog = (id) => {
    const d = document.getElementById(id);
    const bd = document.getElementById(id + '-backdrop');
    if (d) d.classList.remove('st-open');
    if (bd) bd.classList.remove('st-open');
  };

  StudioApp.esc = esc;
  StudioApp.toast = toast;
  StudioApp.confirmDialog = confirmDialog;
  StudioApp.copyText = copyText;
  StudioApp.extractFolderId = extractFolderId;
  StudioApp.apiFetch = apiFetch;
  StudioApp.openDialog = openDialog;
  StudioApp.closeDialog = closeDialog;
})();
