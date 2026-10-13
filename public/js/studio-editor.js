/* studio-editor.js */
(function() {
  const { apiFetch, esc, openDialog, closeDialog, toast, confirmDialog, copyText, extractFolderId } = window.StudioApp;

  let galleries = [], currentPhotos = [], currentCur = 0;
  let activeGalleryId = null, currentCsvUrl = null, pollTimer = null;
  let linkDebounce = null, resultLinkDebounce = null;

  const $ = id => document.getElementById(id);

  function getEditorKey() {
    try {
      const url = new URL(window.location.href);
      const key = url.searchParams.get('key');
      if (key) {
        localStorage.setItem('st_editor_key', key);
        url.searchParams.delete('key');
        window.history.replaceState({}, document.title, url.pathname + url.search + url.hash);
      }
    } catch (e) {}
    if (window.StudioConfig && window.StudioConfig.isAdmin) return 'admin';
    return localStorage.getItem('st_editor_key');
  }

  async function init() {
    const key = getEditorKey();
    if (!key && !(window.StudioConfig && window.StudioConfig.isAdmin)) {
      return renderError('Link tidak valid atau sesi berakhir. Mintalah link editor terbaru dari admin.');
    }

    renderApp();
    await loadGalleries();

    if (window.StudioConfig && window.StudioConfig.isAdmin) {
      loadAdminPanel();
    }

    pollTimer = setInterval(() => {
      loadGalleries(true);
    }, 15000);
  }

  function renderError(msg) {
    if (pollTimer) clearInterval(pollTimer);
    $('st-app').innerHTML = `
      <div class="st-container" style="padding: 64px 16px; text-align: center;">
        <div style="background: var(--st-surface); border: 1px solid var(--st-border); border-radius: var(--st-radius-xl); padding: 32px; max-width: 520px; margin: 0 auto;">
          <h2 style="color: #ff4d4f; margin-bottom: 12px;">Akses Ditolak</h2>
          <p class="st-text-muted" style="margin: 0 auto;">${esc(msg)}</p>
        </div>
      </div>
    `;
  }

  function renderApp() {
    $('st-app').innerHTML = `
      <header class="st-header-section">
        <div class="st-container" style="display: flex; flex-direction: column; gap: var(--st-space-3);">
          <h1 id="st-title">Dashboard Editor</h1>
          <p class="st-text-muted" style="margin-bottom: 0;">Pantau dan kelola pilihan foto dari klien.</p>
          <div style="display: flex; gap: var(--st-space-2); margin-top: 8px; flex-wrap: wrap;">
            <button class="st-btn st-btn-primary" id="st-settingsBtn">💬 Pengaturan WA</button>
          </div>
        </div>
      </header>

      <div class="st-container" id="st-adminPanel" style="display: none; margin-bottom: 24px;"></div>

      <main class="st-container st-editor-main" id="st-main">
        <div id="st-listPanel" class="st-editor-list-panel">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: var(--st-space-4); flex-wrap: wrap; gap: var(--st-space-3);">
            <h2 style="margin: 0;">Daftar Galeri</h2>
            <div style="display: flex; gap: var(--st-space-2);">
              <button class="st-btn st-btn-primary" style="height: 36px; font-size: 14px;" id="st-newGalleryBtn">+ Galeri Baru</button>
              <button class="st-btn st-btn-outline" style="height: 36px; font-size: 14px;" id="st-refreshBtn">↻ Refresh</button>
            </div>
          </div>
          <div id="st-clientsList">Memuat...</div>
        </div>

        <div id="st-detailPanel" class="st-editor-detail-panel" style="display: none;">
          <div style="display: flex; align-items: center; justify-content: space-between; gap: var(--st-space-3); margin-bottom: var(--st-space-3); flex-wrap: wrap;">
            <div style="display: flex; align-items: center; gap: var(--st-space-3); flex-wrap: wrap;">
              <button class="st-btn st-btn-outline" id="st-closeDetailBtn" style="height: 36px; font-size: 14px; padding: 0 14px;">← Tutup</button>
              <div>
                <h2 id="st-detailTitle" style="margin: 0;">Detail Galeri</h2>
                <small id="st-detailSyncInfo" class="st-text-muted" style="font-size: 12px;"></small>
              </div>
            </div>
            <div style="display: flex; gap: 8px; flex-wrap: wrap;">
              <button class="st-btn st-btn-outline" id="st-warmThumbsBtn" style="height: 36px; font-size: 13px; padding: 0 14px;">⚡ Siapkan Thumbnail</button>
              <button class="st-btn st-btn-outline" id="st-refreshDetailBtn" style="height: 36px; font-size: 13px; padding: 0 14px;">↻ Muat Ulang Foto</button>
            </div>
          </div>
          <div id="st-detailContent"></div>
        </div>
      </main>

      <!-- Dialog Atur Galeri -->
      <div id="st-manageDlg-backdrop" class="st-dialog-backdrop"></div>
      <div id="st-manageDlg" class="st-dialog">
        <h2 id="st-manageTitle">Atur Galeri</h2>
        <form id="st-manageForm">
          <input type="hidden" id="st-mId">
          <div class="st-form-group">
            <label for="st-mName">Nama Klien / Judul Galeri</label>
            <input type="text" id="st-mName" class="st-form-control" required placeholder="mis. Andi & Siska Wedding">
          </div>
          <div class="st-form-group">
            <label for="st-mLink">Link / ID Folder Mentah (Google Drive)</label>
            <input type="text" id="st-mLink" class="st-form-control" required placeholder="Paste link atau ID folder mentah...">
            <div style="margin-top: 8px; font-size: 14px;" id="st-mLinkResult"></div>
          </div>
          <div class="st-form-group">
            <label for="st-mResultLink">Link / ID Folder Hasil Edit (Opsional)</label>
            <input type="text" id="st-mResultLink" class="st-form-control" placeholder="Paste link folder hasil akhir (kosongkan jika belum ada)...">
            <div style="margin-top: 8px; font-size: 14px;" id="st-mResultLinkResult"></div>
          </div>
          <div class="st-form-group">
            <label for="st-mLimit">Batas Maksimal Foto</label>
            <input type="number" id="st-mLimit" class="st-form-control" min="0" placeholder="0 = tanpa batas">
          </div>
          <div id="st-mTokenSection" class="st-form-group" style="display: none; padding-top: 8px; border-top: 1px solid var(--st-border);">
            <div style="display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap;">
              <small class="st-text-muted">Jika link klien bocor, Anda dapat mereset token link klien:</small>
              <button type="button" class="st-btn st-btn-outline" style="height: 32px; font-size: 13px;" id="st-mRegenTokenBtn">🔑 Buat Ulang Link Klien</button>
            </div>
          </div>
          <div style="display: flex; gap: var(--st-space-2); justify-content: flex-end; margin-top: var(--st-space-5); flex-wrap: wrap;">
            <button type="button" class="st-btn st-btn-outline" style="color: #ff4d4f; border-color: #ff4d4f; margin-right: auto; display: none;" id="st-mDeleteBtn">Hapus</button>
            <button type="button" class="st-btn st-btn-outline" id="st-mCancelBtn">Batal</button>
            <button type="submit" class="st-btn st-btn-primary" id="st-mSubmit">Simpan</button>
          </div>
        </form>
      </div>

      <!-- Dialog Pengaturan WA Editor -->
      <div id="st-settingsDlg-backdrop" class="st-dialog-backdrop"></div>
      <div id="st-settingsDlg" class="st-dialog">
        <h2>Pengaturan WhatsApp</h2>
        <form id="st-settingsForm">
          <div class="st-form-group">
            <label for="st-sWa">Nomor WA Editor</label>
            <input type="text" id="st-sWa" class="st-form-control" placeholder="mis. 6281234567890">
            <small class="st-text-muted">Awali dengan kode negara (62) tanpa + atau 0. Kosongkan untuk menonaktifkan tombol WA di klien.</small>
          </div>
          <div style="display: flex; gap: var(--st-space-2); justify-content: flex-end; margin-top: var(--st-space-4);">
            <button type="button" class="st-btn st-btn-outline" id="st-sCancelBtn">Batal</button>
            <button type="submit" class="st-btn st-btn-primary" id="st-sSubmit">Simpan</button>
          </div>
        </form>
      </div>

      <!-- Lightbox Editor -->
      <div id="st-lb" class="st-lightbox" role="dialog" aria-modal="true" aria-label="Pratinjau foto">
        <div class="st-lightbox-header">
          <button class="st-lightbox-nav" style="position: static; transform: none; background: transparent;" id="st-lbCloseBtn" aria-label="Tutup">✕</button>
        </div>
        <div class="st-lightbox-content" id="st-lbContent">
          <button class="st-lightbox-nav st-lightbox-prev" id="st-lbPrevBtn" aria-label="Sebelumnya">‹</button>
          <img id="st-lbimg" class="st-lightbox-img" alt="">
          <button class="st-lightbox-nav st-lightbox-next" id="st-lbNextBtn" aria-label="Berikutnya">›</button>
        </div>
        <div class="st-lightbox-footer">
          <span id="st-lbname" style="font-weight: 600;"></span>
          <a id="st-lbDriveBtn" href="#" target="_blank" rel="noopener noreferrer" class="st-btn st-btn-outline" style="height: 36px; font-size: 14px;">📥 Unduh Asli</a>
        </div>
      </div>
    `;

    bindEvents();
  }

  function formatSyncRelative(mysqlDateStr) {
    if (!mysqlDateStr) return 'Belum pernah disinkronkan';
    const d = new Date(mysqlDateStr.replace(' ', 'T'));
    if (isNaN(d.getTime())) return `Terakhir sinkron: ${mysqlDateStr}`;
    const diffSec = Math.max(0, Math.floor((Date.now() - d.getTime()) / 1000));
    if (diffSec < 60) return 'Terakhir sinkron baru saja';
    const diffMin = Math.floor(diffSec / 60);
    if (diffMin < 60) return `Terakhir sinkron ${diffMin} menit lalu`;
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return `Terakhir sinkron ${diffHr} jam lalu`;
    return `Terakhir sinkron ${d.toLocaleString('id-ID')}`;
  }

  async function loadAdminPanel() {
    try {
      const res = await apiFetch('/editor/key');
      const box = $('st-adminPanel');
      if (!box) return;
      box.style.display = 'block';
      box.innerHTML = `
        <div style="background: var(--st-surface); border: 1px solid var(--st-border); border-radius: var(--st-radius-md); padding: 16px;">
          <h3 style="margin-top:0; margin-bottom:8px;">Akses Editor (Khusus Admin)</h3>
          <p class="st-text-muted" style="margin-bottom:12px;">Berikan link ini kepada editor. Mereka tidak perlu login WordPress.</p>
          <div class="st-link-box">
            <input type="text" readonly value="${esc(res.url)}" style="width:100%; background:transparent; border:none; color:var(--st-text); outline:none;" id="st-editorLinkInput">
          </div>
          <div style="display:flex; gap:8px; flex-wrap:wrap;">
            <button class="st-btn st-btn-outline" style="height:32px; font-size:13px;" id="st-copyEditorLinkBtn">Salin Link Editor</button>
            <button class="st-btn st-btn-outline" style="height:32px; font-size:13px; color:#ff4d4f; border-color:#ff4d4f;" id="st-rotateKeyBtn">Rotasi Kunci</button>
            <button class="st-btn st-btn-outline" style="height:32px; font-size:13px;" id="st-diagBtn">🔍 Cek Diagnostik Drive</button>
          </div>
          <div id="st-diagResult" style="display:none; margin-top:12px; padding:12px; background:var(--st-bg); border:1px solid var(--st-border); border-radius:var(--st-radius-sm); font-size:13px; overflow-x:auto;"></div>
        </div>
      `;

      $('st-copyEditorLinkBtn').onclick = () => {
        copyText(res.url, 'Link editor disalin!');
      };

      $('st-rotateKeyBtn').onclick = async () => {
        const ok = await confirmDialog({
          title: 'Rotasi Kunci Editor?',
          message: 'Link editor yang lama akan hangus. Semua editor yang sedang menggunakan link lama harus membuka link baru.',
          confirmText: 'Ya, Rotasi Kunci',
          cancelText: 'Batal',
          variant: 'danger'
        });
        if (!ok) return;
        try {
          const resRotate = await apiFetch('/editor/key/rotate', { method: 'POST' });
          if (resRotate.key) {
            localStorage.setItem('st_editor_key', resRotate.key);
          }
          toast('Kunci berhasil dirotasi. Silakan salin link yang baru.', 'success');
          loadAdminPanel();
        } catch (e) {
          toast(e.message, 'error');
        }
      };

      $('st-diagBtn').onclick = async () => {
        const out = $('st-diagResult');
        out.style.display = 'block';
        out.textContent = 'Menjalankan diagnostik Google Drive API...';
        try {
          const d = await apiFetch('/editor/diagnostics');
          const lt = d.filesListTest || {};
          const gt = d.filesGetTest || {};
          const env = d.environment || {};
          out.innerHTML = `
            <div style="display:grid; gap:6px;">
              <div><strong>API Key Terdefinisi:</strong> ${d.keyDefined ? '✅ Ya' : '❌ Tidak (Mode Demo)'} | <strong>Folder Uji:</strong> <code>${esc(d.testedFolderId || '-')}</code></div>
              <div><strong>files.list:</strong> HTTP ${esc(lt.httpStatus ?? '-')} (${esc(lt.durationMs ?? '-')} ms) — File: ${esc(lt.fileCount ?? 0)} ${lt.errorReason ? `| ❌ Reason: <code>${esc(lt.errorReason)}</code> (${esc(lt.errorMessage || '')})` : '✅ OK'}</div>
              <div><strong>files.get:</strong> ${gt.fileId ? `ID <code>${esc(gt.fileId)}</code> → HTTP ${esc(gt.httpStatus)} (${esc(gt.durationMs)} ms) — Nama: <strong>${esc(gt.name || '-')}</strong> (${esc(gt.mimeType || '-')}) ${gt.errorReason ? `| ❌ <code>${esc(gt.errorReason)}</code>` : '✅ OK'}` : 'Belum ada sampel file'}</div>
              <div class="st-text-muted">PHP ${esc(env.phpVersion)} | DB v${esc(env.dbVersion)} | cURL ${esc(env.curlVersion)} | ObjectCache: ${env.extObjectCache ? 'Ya' : 'Tidak'} | Disk Cache: ${esc(env.cacheFileCount)} file (${esc(env.cacheSizeMb)} MB)</div>
            </div>
          `;
        } catch (e) {
          out.innerHTML = `<span style="color:#ff4d4f;">Gagal memuat diagnostik: ${esc(e.message)}</span>`;
        }
      };
    } catch (e) {
      console.error(e);
    }
  }

  async function loadGalleries(isBackground = false) {
    try {
      galleries = await apiFetch('/editor/galleries');
      renderGalleries();
    } catch (e) {
      if (e.status === 401 && !(window.StudioConfig && window.StudioConfig.isAdmin)) {
        localStorage.removeItem('st_editor_key');
        renderError('Kunci editor tidak valid atau telah dirotasi oleh Admin. Mintalah link editor terbaru.');
        return;
      }
      if (!isBackground && $('st-clientsList')) {
        $('st-clientsList').textContent = e.message;
      }
    }
  }

  function renderGalleries() {
    const list = $('st-clientsList');
    if (!list) return;
    if (!galleries.length) {
      list.innerHTML = '<p class="st-text-muted">Belum ada galeri. Klik "+ Galeri Baru" untuk memulai.</p>';
      return;
    }

    list.innerHTML = '';
    galleries.forEach(g => {
      const card = document.createElement('div');
      const isActive = activeGalleryId && String(activeGalleryId) === String(g.id);
      card.className = 'st-client-card' + (isActive ? ' st-client-card--active' : '');

      let statusBadge = '';
      if (g.status === 'submitted') statusBadge = '<span class="st-badge-status st-status-submitted">Terkirim 🔒</span>';
      else if (g.status === 'draft') statusBadge = '<span class="st-badge-status st-status-draft">Draft</span>';
      else if (g.status === 'reopened') statusBadge = '<span class="st-badge-status st-status-reopened">Dibuka Kembali</span>';
      else statusBadge = '<span class="st-badge-status st-status-unstarted">Belum Mulai</span>';

      const dateStr = g.updated_at ? new Date(g.updated_at.replace(' ', 'T')).toLocaleString('id-ID') : '-';
      const limitStr = Number(g.max_select) > 0 ? ` / ${g.max_select}` : '';
      const countNum = Number(g.selected_count) || 0;

      card.innerHTML = `
        <div class="st-client-card-header">
          <h3 class="st-client-card-title">${esc(g.title)} ${g.result_folder_id ? '<span title="Folder hasil edit tersedia">✅</span>' : ''}</h3>
          ${statusBadge}
        </div>
        <div class="st-text-muted" style="font-size: 14px; display: grid; gap: 4px;">
          <span>Terpilih: <strong>${countNum}${limitStr}</strong> foto</span>
          <span>Update: ${esc(dateStr)}</span>
        </div>
        <div style="display: flex; gap: var(--st-space-2); margin-top: var(--st-space-2); flex-wrap: wrap;">
          <button type="button" class="st-btn st-btn-primary st-view-btn" data-id="${g.id}" ${countNum === 0 ? 'disabled' : ''}>Lihat Pilihan (${countNum})</button>
          <button type="button" class="st-btn st-btn-outline st-edit-btn" data-id="${g.id}">Atur</button>
          <button type="button" class="st-btn st-btn-outline st-copy-btn" data-link="${esc(g.link)}">Salin Link Klien</button>
          ${g.status === 'submitted' ? `<button type="button" class="st-btn st-btn-outline st-reopen-btn" data-id="${g.id}">Buka Akses</button>` : ''}
        </div>
      `;
      list.appendChild(card);
    });

    list.querySelectorAll('.st-view-btn').forEach(b => {
      b.onclick = () => viewGallery(b.dataset.id, false);
    });
    list.querySelectorAll('.st-edit-btn').forEach(b => {
      b.onclick = () => openManageDialog(b.dataset.id);
    });
    list.querySelectorAll('.st-copy-btn').forEach(b => {
      b.onclick = () => {
        const link = b.dataset.link;
        if (!link) return toast('Link tidak tersedia. Pastikan page Studio Client sudah dibuat.');
        copyText(link, 'Link klien disalin!');
      };
    });
    list.querySelectorAll('.st-reopen-btn').forEach(b => {
      b.onclick = () => reopenGallery(b.dataset.id);
    });
  }

  // --- Manage Gallery ---
  let validatedFolderId = null;
  let validatedResultFolderId = '';

  function openManageDialog(id) {
    if (linkDebounce) clearTimeout(linkDebounce);
    if (resultLinkDebounce) clearTimeout(resultLinkDebounce);

    validatedFolderId = null;
    validatedResultFolderId = '';
    $('st-mLinkResult').innerHTML = '';
    $('st-mLink').value = '';
    $('st-mResultLinkResult').innerHTML = '';
    $('st-mResultLink').value = '';

    if (id && id !== 'new') {
      const g = galleries.find(x => String(x.id) === String(id));
      if (!g) return;
      $('st-manageTitle').textContent = 'Atur Galeri: ' + g.title;
      $('st-mId').value = g.id;
      $('st-mName').value = g.title;
      $('st-mLimit').value = g.max_select || 0;
      $('st-mDeleteBtn').style.display = 'inline-flex';
      $('st-mTokenSection').style.display = 'block';

      if (g.source_folder_id) {
        validatedFolderId = g.source_folder_id;
        $('st-mLink').value = `https://drive.google.com/drive/folders/${g.source_folder_id}`;
        $('st-mLinkResult').innerHTML = `✅ ID Folder: <strong>${esc(g.source_folder_id)}</strong>`;
      }
      if (g.result_folder_id) {
        validatedResultFolderId = g.result_folder_id;
        $('st-mResultLink').value = `https://drive.google.com/drive/folders/${g.result_folder_id}`;
        $('st-mResultLinkResult').innerHTML = `✅ ID Folder: <strong>${esc(g.result_folder_id)}</strong>`;
      }
    } else {
      $('st-manageTitle').textContent = 'Buat Galeri Baru';
      $('st-mId').value = '';
      $('st-mName').value = '';
      $('st-mLimit').value = 0;
      $('st-mDeleteBtn').style.display = 'none';
      $('st-mTokenSection').style.display = 'none';
    }
    openDialog('st-manageDlg');
  }

  async function checkDriveLink(val, outEl, isOptional = false) {
    const trimmed = (val || '').trim();
    if (!trimmed) {
      if (isOptional) {
        outEl.innerHTML = '<span class="st-text-muted">Folder hasil edit dikosongkan.</span>';
        return '';
      }
      outEl.innerHTML = '<span style="color:#ff4d4f">❌ Link/ID wajib diisi</span>';
      return null;
    }

    const ext = extractFolderId(trimmed);
    if (!ext) {
      outEl.innerHTML = '<span style="color:#ff4d4f">❌ Format Link/ID Google Drive tidak valid</span>';
      return null;
    }

    outEl.innerHTML = '⏳ Mengecek folder...';
    try {
      const d = await apiFetch('/editor/drive/resolve', {
        method: 'POST',
        body: JSON.stringify({ input: ext })
      });
      outEl.innerHTML = `✅ <strong>${esc(d.name)}</strong> — ${d.photoCount} foto`;
      return d.folderId;
    } catch (err) {
      outEl.innerHTML = `<span style="color:#ff4d4f">❌ Error: ${esc(err.message)}</span>`;
      return null;
    }
  }

  async function reopenGallery(id) {
    const ok = await confirmDialog({
      title: 'Buka Kembali Akses Klien?',
      message: 'Klien akan dapat mengubah dan mengirim ulang pilihan fotonya.',
      confirmText: 'Ya, Buka Akses',
      cancelText: 'Batal',
      variant: 'warning'
    });
    if (!ok) return;
    try {
      await apiFetch(`/editor/galleries/${id}/reopen`, { method: 'POST' });
      toast('Akses klien berhasil dibuka kembali', 'success');
      await loadGalleries();
      if (activeGalleryId && String(activeGalleryId) === String(id)) {
        viewGallery(id, false);
      }
    } catch (e) {
      toast(e.message, 'error');
    }
  }

  async function regenerateClientToken() {
    const id = $('st-mId').value;
    if (!id) return;
    const ok = await confirmDialog({
      title: 'Buat Ulang Link Klien?',
      message: 'Link klien yang lama tidak akan bisa diakses lagi. Pastikan Anda mengirimkan link baru kepada klien.',
      confirmText: 'Ya, Buat Ulang',
      cancelText: 'Batal',
      variant: 'warning'
    });
    if (!ok) return;
    try {
      const res = await apiFetch(`/editor/galleries/${id}/regenerate-token`, { method: 'POST' });
      await loadGalleries();
      if (res.link) {
        await copyText(res.link, 'Link klien baru berhasil dibuat & disalin!');
      } else {
        toast('Token klien berhasil diperbarui', 'success');
      }
    } catch (e) {
      toast(e.message, 'error');
    }
  }

  async function deleteGallery() {
    const id = $('st-mId').value;
    if (!id) return;
    const ok = await confirmDialog({
      title: 'Hapus Galeri Ini?',
      message: 'Galeri beserta seluruh data pilihan foto klien akan dihapus secara permanen.',
      confirmText: 'Ya, Hapus Galeri',
      cancelText: 'Batal',
      variant: 'danger'
    });
    if (!ok) return;
    try {
      await apiFetch(`/editor/galleries/${id}`, { method: 'DELETE' });
      toast('Galeri berhasil dihapus', 'success');
      closeDialog('st-manageDlg');
      if (activeGalleryId && String(activeGalleryId) === String(id)) {
        closeDetailPanel();
      }
      loadGalleries();
    } catch (e) {
      toast(e.message, 'error');
    }
  }

  function closeDetailPanel() {
    activeGalleryId = null;
    $('st-detailPanel').style.display = 'none';
    $('st-listPanel').style.display = 'block';
    renderGalleries();
  }

  // --- Detail View (B7, B9, D8, D9, D10) ---
  function getImageCandidates(pItem, isLg = false) {
    const list = [];
    const main = isLg ? (pItem.srcLg || pItem.src) : pItem.src;
    const fallback = isLg ? (pItem.fallbackSrcLg || pItem.fallbackSrc) : pItem.fallbackSrc;
    const fallbacksList = isLg ? (pItem.fallbacksLg || pItem.fallbacks) : pItem.fallbacks;

    if (main) list.push(main);
    if (Array.isArray(fallbacksList)) {
      fallbacksList.forEach(u => {
        if (u && !list.includes(u)) list.push(u);
      });
    }
    if (fallback && !list.includes(fallback)) list.push(fallback);

    if (!String(pItem.id).startsWith('demo')) {
      const sz = isLg ? 1600 : 400;
      const gThumb = `https://drive.google.com/thumbnail?id=${encodeURIComponent(pItem.id)}&sz=w${sz}`;
      if (!list.includes(gThumb)) list.push(gThumb);
    }
    return list;
  }

  function renderDetailData(id, data) {
    $('st-detailTitle').textContent = data.title;
    if ($('st-detailSyncInfo')) {
      $('st-detailSyncInfo').textContent = formatSyncRelative(data.syncedAt);
    }
    currentPhotos = Array.isArray(data.photos) ? data.photos : [];

    const noteHtml = data.note
      ? `<div class="st-banner">📝 <div><strong>Catatan Klien:</strong> ${esc(data.note)}</div></div>`
      : '';

    if (!currentPhotos.length) {
      $('st-detailContent').innerHTML = `
        ${noteHtml}
        <div class="st-banner">Belum ada foto yang dipilih oleh klien pada galeri ini.</div>
      `;
      return;
    }

    const missingCount = currentPhotos.filter(p => p.nameMissing || !p.name).length;
    const missingBannerHtml = missingCount > 0 ? `
      <div class="st-banner" style="justify-content: space-between; flex-wrap: wrap; border-color: #fbbf24; color: #fbbf24;">
        <span>⚠️ ${missingCount} foto belum memiliki nama asli dari Google Drive.</span>
        <button type="button" class="st-btn st-btn-outline" id="st-resyncNamesBtn" style="height: 34px; font-size: 13px; padding: 0 14px; border-color: #fbbf24; color: #fbbf24;">🔄 Muat Ulang Nama</button>
      </div>
    ` : '';

    // B9: Ekspor CSV memuat nama_file,id (kosongkan nama bila nameMissing, jangan isi ID di kolom nama)
    const csv = 'nama_file,id\n' + currentPhotos.map(p => {
      const cleanName = (p.nameMissing || !p.name) ? '' : String(p.name);
      return `"${cleanName.replace(/"/g, '""')}","${String(p.id).replace(/"/g, '""')}"`;
    }).join('\n');

    const validNames = currentPhotos.filter(p => !p.nameMissing && p.name).map(p => p.name);

    if (currentCsvUrl) {
      URL.revokeObjectURL(currentCsvUrl);
    }
    const csvBlob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    currentCsvUrl = URL.createObjectURL(csvBlob);

    $('st-detailContent').innerHTML = `
      ${noteHtml}
      ${missingBannerHtml}
      <div style="display: flex; gap: 8px; margin-bottom: 16px; flex-wrap: wrap; align-items: center;">
        <span class="st-text-muted" style="font-size: 14px; margin-right: 4px;">Total: <strong>${currentPhotos.length}</strong> foto</span>
        <a href="${currentCsvUrl}" download="pilihan_${esc(id)}.csv" class="st-btn st-btn-outline" style="height: 34px; font-size: 13px; padding: 0 14px;">📥 Unduh CSV</a>
        <button type="button" class="st-btn st-btn-outline" id="st-copyNamesBtn" style="height: 34px; font-size: 13px; padding: 0 14px;">📋 Salin Nama File</button>
        <button type="button" class="st-btn st-btn-outline" id="st-copyCsvBtn" style="height: 34px; font-size: 13px; padding: 0 14px;">📋 Salin CSV</button>
      </div>
      <div class="st-photo-grid st-editor-photo-grid" id="st-editorGrid" style="margin-top: 16px;"></div>
    `;

    if ($('st-resyncNamesBtn')) {
      $('st-resyncNamesBtn').onclick = () => resyncGalleryNames(id);
    }

    $('st-copyNamesBtn').onclick = () => {
      if (!validNames.length) {
        toast('Nama file belum tersedia. Klik "Muat Ulang Nama" terlebih dahulu.');
        return;
      }
      const msg = missingCount > 0
        ? `${validNames.length} nama file disalin (${missingCount} nama belum tersedia dilewati)`
        : `${validNames.length} nama file disalin!`;
      copyText(validNames.join('\n'), msg);
    };
    $('st-copyCsvBtn').onclick = () => copyText(csv, 'Data CSV disalin!');

    const gridEl = $('st-editorGrid');
    const frag = document.createDocumentFragment();

    currentPhotos.forEach((p, i) => {
      const card = document.createElement('div');
      card.className = 'st-photo-card';
      card.dataset.i = i;
      card.tabIndex = 0;

      const retryWrap = document.createElement('div');
      retryWrap.className = 'st-img-retry-wrap';
      retryWrap.innerHTML = `<span>Gagal memuat pratinjau</span><button type="button" class="st-retry-img-btn" data-i="${i}">↻ Muat ulang</button>`;

      const candidates = getImageCandidates(p, false);
      const img = document.createElement('img');
      img.width = 400;
      img.height = 400;
      img.referrerPolicy = 'no-referrer';
      img.alt = p.name || '(nama belum tersedia)';
      img.loading = i < 8 ? 'eager' : 'lazy';
      img.decoding = 'async';

      let attempt = 0;
      img.onload = () => {
        card.classList.remove('st-img-error');
        card.classList.add('st-img-loaded');
      };
      img.onerror = () => {
        attempt++;
        if (attempt < candidates.length) {
          img.src = candidates[attempt];
        } else {
          card.classList.add('st-img-error');
        }
      };
      img.src = candidates[0] || p.src;

      const overlay = document.createElement('div');
      overlay.className = 'st-photo-card__overlay';
      overlay.style.opacity = '1';

      const displayLabel = (!p.nameMissing && p.name) ? p.name : '(nama belum tersedia)';
      const badgeName = document.createElement('div');
      badgeName.className = 'st-badge-name' + ((p.nameMissing || !p.name) ? ' st-badge-name--missing' : '');
      badgeName.style.opacity = '1';
      badgeName.style.bottom = '8px';
      badgeName.title = displayLabel;
      badgeName.textContent = displayLabel;

      const zoomBtn = document.createElement('button');
      zoomBtn.type = 'button';
      zoomBtn.className = 'st-zoom-btn';
      zoomBtn.setAttribute('aria-label', 'Perbesar');
      zoomBtn.tabIndex = -1;
      zoomBtn.textContent = '⤢';

      card.append(img, retryWrap, overlay, badgeName, zoomBtn);
      card.onkeydown = (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          openLb(i);
        }
      };
      frag.appendChild(card);
    });

    gridEl.appendChild(frag);
    gridEl.onclick = (e) => {
      const retryBtn = e.target.closest('.st-retry-img-btn');
      if (retryBtn) {
        e.stopPropagation();
        const card = retryBtn.closest('.st-photo-card');
        const idx = parseInt(card.dataset.i, 10);
        const p = currentPhotos[idx];
        const img = card.querySelector('img');
        if (img && p) {
          card.classList.remove('st-img-error');
          const candidates = getImageCandidates(p, false);
          let attempt = 0;
          img.onerror = () => {
            attempt++;
            if (attempt < candidates.length) {
              img.src = candidates[attempt] + (candidates[attempt].includes('?') ? '&' : '?') + '_t=' + Date.now();
            } else {
              card.classList.add('st-img-error');
            }
          };
          const first = candidates[0] || p.src;
          img.src = first + (first.includes('?') ? '&' : '?') + '_t=' + Date.now();
        }
        return;
      }
      const card = e.target.closest('.st-photo-card');
      if (card) {
        openLb(parseInt(card.dataset.i, 10));
      }
    };
  }

  async function viewGallery(id, forceRefresh = false) {
    activeGalleryId = id;
    renderGalleries();

    if (window.innerWidth < 900) {
      $('st-listPanel').style.display = 'none';
    } else {
      $('st-listPanel').style.display = 'block';
    }
    $('st-detailPanel').style.display = 'block';
    $('st-detailContent').innerHTML = '<p class="st-text-muted">Memuat foto pilihan klien...</p>';

    try {
      const query = forceRefresh ? '?refresh=1' : '';
      const data = await apiFetch(`/editor/galleries/${id}${query}`);
      renderDetailData(id, data);
    } catch (e) {
      $('st-detailContent').innerHTML = `<div class="st-banner" style="border-color:#ff4d4f; color:#ff4d4f;">Error: ${esc(e.message)}</div>`;
    }
  }

  async function resyncGalleryNames(id) {
    const btn = $('st-resyncNamesBtn');
    if (btn) {
      btn.disabled = true;
      btn.textContent = '⏳ Memuat ulang nama...';
    }
    try {
      const data = await apiFetch(`/editor/galleries/${id}/resync`, { method: 'POST' });
      renderDetailData(id, data);
      await loadGalleries(true);
      toast(data.missingNameCount === 0 ? 'Semua nama file berhasil dimuat!' : 'Sinkronisasi selesai.');
    } catch (e) {
      toast(e.message);
      if (btn) {
        btn.disabled = false;
        btn.textContent = '🔄 Muat Ulang Nama';
      }
    }
  }

  function openLb(i) {
    if (!currentPhotos.length) return;
    currentCur = i;
    $('st-lb').classList.add('st-open');
    showLb();
  }
  window.StudioApp.editorOpenLb = openLb;

  function showLb() {
    const p = currentPhotos[currentCur];
    if (!p) return;
    const lbImg = $('st-lbimg');
    lbImg.referrerPolicy = 'no-referrer';
    const candidates = getImageCandidates(p, true);
    let attempt = 0;
    lbImg.onerror = () => {
      attempt++;
      if (attempt < candidates.length) {
        lbImg.src = candidates[attempt];
      }
    };
    lbImg.src = candidates[0] || p.srcLg || p.src;
    const displayLabel = (!p.nameMissing && p.name) ? p.name : '(nama belum tersedia)';
    lbImg.alt = displayLabel;
    $('st-lbname').textContent = `${displayLabel} (${currentCur + 1} / ${currentPhotos.length})`;

    const dlBtn = $('st-lbDriveBtn');
    if (dlBtn) {
      if (String(p.id).startsWith('demo')) {
        dlBtn.style.display = 'none';
      } else {
        dlBtn.style.display = 'inline-flex';
        dlBtn.href = `https://drive.google.com/uc?export=download&id=${encodeURIComponent(p.id)}`;
      }
    }
  }

  function bindEvents() {
    $('st-refreshBtn').onclick = () => {
      toast('Memuat ulang daftar galeri...');
      loadGalleries();
      if (activeGalleryId) viewGallery(activeGalleryId, false);
    };
    $('st-refreshDetailBtn').onclick = () => {
      if (activeGalleryId) {
        toast('Sinkronisasi ulang folder Google Drive...');
        resyncGalleryNames(activeGalleryId);
      }
    };
    $('st-warmThumbsBtn').onclick = async () => {
      if (!activeGalleryId) return;
      const btn = $('st-warmThumbsBtn');
      const orig = btn.textContent;
      btn.disabled = true;
      btn.textContent = '⏳ Menyiapkan...';
      try {
        const res = await apiFetch(`/editor/galleries/${activeGalleryId}/warm-thumbs`, { method: 'POST' });
        toast(`Thumbnail siap: ${res.cached}/${res.total} foto${res.remaining > 0 ? ' (sisanya berjalan di latar belakang)' : ''}`);
        viewGallery(activeGalleryId, false);
      } catch (e) {
        toast(e.message);
      } finally {
        btn.disabled = false;
        btn.textContent = orig;
      }
    };
    $('st-newGalleryBtn').onclick = () => openManageDialog('new');

    $('st-mLink').addEventListener('input', e => {
      validatedFolderId = null;
      if (linkDebounce) clearTimeout(linkDebounce);
      const val = e.target.value;
      linkDebounce = setTimeout(async () => {
        validatedFolderId = await checkDriveLink(val, $('st-mLinkResult'), false);
      }, 400);
    });

    $('st-mResultLink').addEventListener('input', e => {
      validatedResultFolderId = null;
      if (resultLinkDebounce) clearTimeout(resultLinkDebounce);
      const val = e.target.value;
      resultLinkDebounce = setTimeout(async () => {
        validatedResultFolderId = await checkDriveLink(val, $('st-mResultLinkResult'), true);
      }, 400);
    });

    $('st-mCancelBtn').onclick = () => closeDialog('st-manageDlg');
    $('st-mDeleteBtn').onclick = deleteGallery;
    $('st-mRegenTokenBtn').onclick = regenerateClientToken;

    $('st-manageForm').onsubmit = async (e) => {
      e.preventDefault();
      if (linkDebounce) clearTimeout(linkDebounce);
      if (resultLinkDebounce) clearTimeout(resultLinkDebounce);

      $('st-mSubmit').disabled = true;
      try {
        const id = $('st-mId').value;

        if (!validatedFolderId) {
          validatedFolderId = await checkDriveLink($('st-mLink').value, $('st-mLinkResult'), false);
        }
        if (!validatedFolderId) {
          throw new Error('Folder sumber wajib diisi dan valid');
        }

        const rawResultVal = ($('st-mResultLink').value || '').trim();
        if (!rawResultVal) {
          validatedResultFolderId = '';
        } else if (!validatedResultFolderId) {
          validatedResultFolderId = await checkDriveLink(rawResultVal, $('st-mResultLinkResult'), true);
          if (validatedResultFolderId === null) {
            throw new Error('Link/ID Folder Hasil Edit tidak valid');
          }
        }

        const body = {
          title: $('st-mName').value.trim(),
          max_select: parseInt($('st-mLimit').value, 10) || 0,
          folder_id: validatedFolderId,
          source_folder_id: validatedFolderId,
          result_folder_id: validatedResultFolderId
        };

        if (id) {
          const existing = galleries.find(x => String(x.id) === String(id));
          if (existing && existing.source_folder_id !== validatedFolderId && Number(existing.selected_count) > 0) {
            const ok = await confirmDialog({
              title: 'Folder Mentah Diubah!',
              message: 'Pilihan foto klien yang sudah ada pada galeri ini akan di-reset. Apakah Anda yakin ingin melanjutkan?',
              confirmText: 'Ya, Reset & Simpan',
              cancelText: 'Batal',
              variant: 'danger'
            });
            if (!ok) {
              return;
            }
          }
          await apiFetch(`/editor/galleries/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
          toast('Galeri berhasil disimpan', 'success');
        } else {
          await apiFetch('/editor/galleries', { method: 'POST', body: JSON.stringify(body) });
          toast('Galeri berhasil dibuat', 'success');
        }

        closeDialog('st-manageDlg');
        await loadGalleries();
        if (id && activeGalleryId && String(activeGalleryId) === String(id)) {
          viewGallery(id, false);
        }
      } catch (err) {
        toast(err.message, 'error');
      } finally {
        $('st-mSubmit').disabled = false;
      }
    };

    $('st-settingsBtn').onclick = async () => {
      try {
        const res = await apiFetch('/editor/settings');
        $('st-sWa').value = res.whatsapp || '';
        openDialog('st-settingsDlg');
      } catch (e) {
        toast(e.message);
      }
    };

    $('st-sCancelBtn').onclick = () => closeDialog('st-settingsDlg');

    $('st-settingsForm').onsubmit = async (e) => {
      e.preventDefault();
      $('st-sSubmit').disabled = true;
      try {
        const wa = $('st-sWa').value.replace(/[^0-9]/g, '');
        await apiFetch('/editor/settings', { method: 'PATCH', body: JSON.stringify({ whatsapp: wa }) });
        toast('Pengaturan WA disimpan');
        closeDialog('st-settingsDlg');
      } catch (err) {
        toast(err.message);
      } finally {
        $('st-sSubmit').disabled = false;
      }
    };

    $('st-closeDetailBtn').onclick = closeDetailPanel;

    const stepLb = d => {
      if (!currentPhotos.length) return;
      currentCur = (currentCur + d + currentPhotos.length) % currentPhotos.length;
      showLb();
    };
    $('st-lbPrevBtn').onclick = () => stepLb(-1);
    $('st-lbNextBtn').onclick = () => stepLb(1);
    $('st-lbCloseBtn').onclick = () => $('st-lb').classList.remove('st-open');

    let touchStartX = 0;
    $('st-lbContent').addEventListener('touchstart', e => {
      touchStartX = e.touches[0].clientX;
    }, { passive: true });
    $('st-lbContent').addEventListener('touchend', e => {
      const dx = e.changedTouches[0].clientX - touchStartX;
      if (Math.abs(dx) > 50) stepLb(dx > 0 ? -1 : 1);
    }, { passive: true });

    document.addEventListener('keydown', e => {
      if (!$('st-lb').classList.contains('st-open')) return;
      if (e.key === 'ArrowLeft') stepLb(-1);
      if (e.key === 'ArrowRight') stepLb(1);
      if (e.key === 'Escape') $('st-lb').classList.remove('st-open');
    });
  }

  init();
})();

