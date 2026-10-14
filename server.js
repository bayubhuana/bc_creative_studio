// Automatically load .env file if available (Node 20+)
if (typeof process.loadEnvFile === 'function') {
  try {
    process.loadEnvFile();
  } catch {}
}

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import {
  IS_VERCEL,
  DATA_DIR,
  CACHE_DIR,
  GALLERIES_FILE,
  SETTINGS_FILE,
  FILES_CACHE_FILE,
  initStorage,
  ensureStorageReady,
  getGalleries,
  saveGalleries,
  getSettings,
  saveSettings,
  getFilesCache,
  saveFilesCache,
  isFirebaseReady
} from './storage.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ==========================================
// 1. CONFIGURATION & ENVIRONMENT
// ==========================================
const PORT = parseInt(process.env.PORT || '3000', 10);
const GOOGLE_API_KEY = (process.env.GOOGLE_API_KEY || '').trim();
const DEFAULT_EDITOR_KEY = (process.env.EDITOR_KEY || 'admin').trim();
const DEFAULT_WA = (process.env.EDITOR_WA || '').trim();

const PUBLIC_DIR = [
  path.join(__dirname, 'public'),
  path.join(process.cwd(), 'public')
].find(p => fs.existsSync(p)) || path.join(__dirname, 'public');

// In-memory memory-lock for thumbnail fetching to prevent stampedes
const thumbnailLocks = new Map();

// Allowed thumbnail widths
const ALLOWED_WIDTHS = [200, 400, 800, 1600];
function snapWidth(rawW) {
  const w = parseInt(rawW, 10) || 400;
  let best = 400;
  let minDiff = Infinity;
  for (const aw of ALLOWED_WIDTHS) {
    const diff = Math.abs(w - aw);
    if (diff < minDiff) {
      minDiff = diff;
      best = aw;
    }
  }
  return best;
}

// Check if image byte header is valid
function isValidImageBytes(buffer) {
  if (!buffer || buffer.length < 16) return false;
  // JPEG
  if (buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) return true;
  // PNG
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) return true;
  // WebP: RIFF....WEBP
  if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return true;
  // GIF: GIF87a or GIF89a
  if (buffer.toString('ascii', 0, 3) === 'GIF') return true;
  return false;
}

function generateRandomToken(len = 32) {
  return crypto.randomBytes(Math.ceil(len / 2)).toString('hex').slice(0, len);
}

function getCurrentTimestamp() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}

// Generate demo photo SVG when no Google Drive API Key or for testing
function makeDemoPhoto(i, folderId) {
  const name = `IMG_${String(1200 + i * 7).padStart(4, '0')}.jpg`;
  const h = (i * 37) % 360;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="600"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${h},55%,62%)"/><stop offset="1" stop-color="hsl(${h + 50},60%,38%)"/></linearGradient></defs><rect width="600" height="600" fill="url(#g)"/><text x="300" y="316" font-size="40" text-anchor="middle" fill="#fff" font-family="sans-serif">${name}</text></svg>`;
  return {
    id: `demo${i}${folderId}`,
    name,
    mime: 'image/svg+xml',
    thumbnailLink: `data:image/svg+xml,${encodeURIComponent(svg)}`
  };
}

// Multi-tier thumbnail URL builder exactly matching bcsolutions
function buildThumbUrls(fileId, thumbLink = '', folderId = '') {
  if (String(fileId).startsWith('demo')) {
    const link = thumbLink || '';
    return {
      src: link,
      srcLg: link,
      fallbackSrc: link,
      fallbackSrcLg: link,
      fallbacks: [],
      fallbacksLg: []
    };
  }

  const proxy400 = `/api/thumb?id=${encodeURIComponent(fileId)}&w=400${folderId ? `&f=${encodeURIComponent(folderId)}` : ''}`;
  const proxy1600 = `/api/thumb?id=${encodeURIComponent(fileId)}&w=1600${folderId ? `&f=${encodeURIComponent(folderId)}` : ''}`;

  let cdn400 = '';
  let cdn1600 = '';
  if (thumbLink) {
    if (thumbLink.includes('drive.google.com/thumbnail')) {
      const sep = thumbLink.includes('?') ? '&' : '?';
      cdn400 = `${thumbLink}${sep}sz=w400`;
      cdn1600 = `${thumbLink}${sep}sz=w1600`;
    } else {
      const base = thumbLink.replace(/=[sw]\d+.*$/, '');
      cdn400 = `${base}=s400`;
      cdn1600 = `${base}=s1600`;
    }
  }

  const driveThumb400 = `https://drive.google.com/thumbnail?id=${encodeURIComponent(fileId)}&sz=w400`;
  const driveThumb1600 = `https://drive.google.com/thumbnail?id=${encodeURIComponent(fileId)}&sz=w1600`;
  const lh3_400 = `https://lh3.googleusercontent.com/d/${encodeURIComponent(fileId)}=w400`;
  const lh3_1600 = `https://lh3.googleusercontent.com/d/${encodeURIComponent(fileId)}=w1600`;

  // Candidates for w=400
  const c400 = [];
  if (cdn400) c400.push(cdn400);
  c400.push(proxy400);
  c400.push(driveThumb400);
  c400.push(lh3_400);
  const candidates400 = [...new Set(c400.filter(Boolean))];

  // Candidates for w=1600
  const c1600 = [];
  if (cdn1600) c1600.push(cdn1600);
  c1600.push(proxy1600);
  c1600.push(driveThumb1600);
  c1600.push(lh3_1600);
  const candidates1600 = [...new Set(c1600.filter(Boolean))];

  const primary400 = candidates400[0] || proxy400;
  const fallbacks400 = candidates400.slice(1);
  const primary1600 = candidates1600[0] || proxy1600;
  const fallbacks1600 = candidates1600.slice(1);

  return {
    src: primary400,
    srcLg: primary1600,
    fallbackSrc: fallbacks400[0] || driveThumb400,
    fallbackSrcLg: fallbacks1600[0] || driveThumb1600,
    fallbacks: fallbacks400,
    fallbacksLg: fallbacks1600
  };
}

// Format client photo item
function formatClientPhotoItem(p, folderId) {
  const thumbUrls = buildThumbUrls(p.id, p.thumb_link || '', folderId);
  return {
    id: p.id,
    name: p.name,
    ...thumbUrls
  };
}

// ==========================================
// 3. GOOGLE DRIVE SYNC & CACHE
// ==========================================
async function syncFolder(folderId) {
  if (!folderId) throw new Error('ID folder kosong.');

  const syncTime = getCurrentTimestamp();
  const cache = getFilesCache();

  // If no GOOGLE_API_KEY, use demo mode
  if (!GOOGLE_API_KEY) {
    const demoFiles = [];
    for (let i = 0; i < 24; i++) {
      const d = makeDemoPhoto(i, folderId);
      demoFiles.push({
        id: d.id,
        name: d.name,
        mime: d.mime,
        thumb_link: d.thumbnailLink,
        position: i,
        synced_at: syncTime
      });
    }
    cache[folderId] = {
      time: Date.now(),
      synced_at: syncTime,
      count: demoFiles.length,
      files: demoFiles
    };
    saveFilesCache(cache);
    return demoFiles;
  }

  const rawFiles = [];
  let pageToken = '';
  const settings = getSettings();
  const mimeClause = settings.include_octet_stream
    ? "(mimeType contains 'image/' or mimeType = 'application/octet-stream')"
    : "mimeType contains 'image/'";

  do {
    const q = `'${folderId}' in parents and ${mimeClause} and trashed=false`;
    const params = new URLSearchParams({
      q,
      pageSize: '1000',
      orderBy: 'name',
      fields: 'nextPageToken,files(id,name,mimeType,thumbnailLink)',
      supportsAllDrives: 'true',
      includeItemsFromAllDrives: 'true',
      key: GOOGLE_API_KEY
    });
    if (pageToken) params.set('pageToken', pageToken);

    const url = `https://www.googleapis.com/drive/v3/files?${params.toString()}`;
    let resp;
    try {
      resp = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
          'Accept': 'application/json'
        }
      });
    } catch (netErr) {
      const err = new Error(`Gagal menghubungi Google Drive (${netErr.message})`);
      err.status = 503;
      throw err;
    }

    if (!resp.ok) {
      const errBody = await resp.json().catch(() => ({}));
      const reason = errBody?.error?.errors?.[0]?.reason || errBody?.error?.status || `HTTP ${resp.status}`;
      const msg = errBody?.error?.message || `Gagal memuat file dari Google Drive (${reason})`;
      const err = new Error(msg);
      err.status = 503;
      throw err;
    }

    const data = await resp.json();
    for (const f of data.files || []) {
      if (!f.id || !f.name) continue;
      const tUrl = f.thumbnailLink
        ? f.thumbnailLink.replace(/=s\d+.*$/, '')
        : `https://drive.google.com/thumbnail?id=${encodeURIComponent(f.id)}`;
      rawFiles.push({
        id: String(f.id),
        name: String(f.name),
        mime: String(f.mimeType || ''),
        thumb_link: tUrl
      });
    }

    pageToken = data.nextPageToken || '';
  } while (pageToken);

  const formattedFiles = rawFiles.map((item, idx) => ({
    id: item.id,
    name: item.name,
    mime: item.mime,
    thumb_link: item.thumb_link,
    position: idx,
    synced_at: syncTime
  }));

  cache[folderId] = {
    time: Date.now(),
    synced_at: syncTime,
    count: formattedFiles.length,
    files: formattedFiles
  };
  saveFilesCache(cache);

  // Update selected_meta in any gallery using this folder
  const galleries = getGalleries();
  let galleriesUpdated = false;
  for (const g of galleries) {
    if (g.source_folder_id === folderId && Array.isArray(g.selected_ids) && g.selected_ids.length > 0) {
      const meta = g.selected_meta || {};
      let changed = false;
      for (const sid of g.selected_ids) {
        const found = formattedFiles.find(f => f.id === sid);
        if (found && meta[sid] !== found.name) {
          meta[sid] = found.name;
          changed = true;
        }
      }
      if (changed || !g.selected_meta) {
        g.selected_meta = meta;
        g.selected_count = g.selected_ids.length;
        galleriesUpdated = true;
      }
    }
  }
  if (galleriesUpdated) {
    await saveGalleries(galleries);
  }

  return formattedFiles;
}

async function getFileIndex(folderId, forceRefresh = false) {
  if (!folderId) return [];
  const cache = getFilesCache();
  const entry = cache[folderId];

  if (!forceRefresh && entry && Array.isArray(entry.files)) {
    // If older than 5 minutes, trigger background sync without blocking
    if (Date.now() - (entry.time || 0) > 5 * 60 * 1000) {
      syncFolder(folderId).catch(err => console.error('[Background Sync Err]', err.message));
    }
    return entry.files;
  }

  return await syncFolder(folderId);
}

// Prefetch thumbnails into cache
async function prefetchThumbs(folderId, count = 48) {
  try {
    const files = await getFileIndex(folderId);
    const toWarm = files.slice(0, count);
    let warmed = 0;
    for (const f of toWarm) {
      if (!f.id || f.id.startsWith('demo')) continue;
      const cached = getCachedThumbPath(f.id, 400);
      if (fs.existsSync(cached) && fs.statSync(cached).size > 100) continue;
      // Fetch in background
      fetchImageTier(f.id, 400, f.thumb_link).then(buf => {
        if (buf) {
          try { fs.writeFileSync(cached, buf); } catch {}
        }
      }).catch(() => {});
      warmed++;
    }
    return { ok: true, prefetchCount: warmed };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// Resolve Drive folder URL or ID
async function resolveDriveFolder(input) {
  let folderId = (input || '').trim();
  if (folderId.includes('drive.google.com')) {
    const m = folderId.match(/\/folders\/([A-Za-z0-9_-]+)/);
    if (m) folderId = m[1];
    else {
      try {
        const u = new URL(folderId);
        const idParam = u.searchParams.get('id');
        if (idParam) folderId = idParam;
      } catch {}
    }
  }

  if (!/^[A-Za-z0-9_-]{10,}$/.test(folderId)) {
    const err = new Error('Format Link / ID Folder tidak valid');
    err.status = 400;
    throw err;
  }

  if (!GOOGLE_API_KEY) {
    const files = await syncFolder(folderId);
    return {
      folderId,
      name: `Mode Demo (${folderId.slice(0, 8)}...)`,
      photoCount: files.length,
      isDemo: true
    };
  }

  const url = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(folderId)}?fields=id,name,mimeType&supportsAllDrives=true&key=${encodeURIComponent(GOOGLE_API_KEY)}`;
  const resp = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' }
  });

  if (!resp.ok) {
    const body = await resp.json().catch(() => ({}));
    const err = new Error(body?.error?.message || 'Gagal menghubungi Google Drive API');
    err.status = resp.status;
    throw err;
  }

  const body = await resp.json();
  if (body.mimeType !== 'application/vnd.google-apps.folder') {
    const err = new Error('ID tersebut bukan sebuah folder Google Drive');
    err.status = 400;
    throw err;
  }

  const files = await syncFolder(folderId);
  return {
    folderId,
    name: body.name || folderId,
    photoCount: files.length
  };
}

// Build detailed gallery view for Editor
async function buildEditorGalleryDetail(g, forceRefresh = false, baseUrl = '') {
  let selectedIds = Array.isArray(g.selected_ids) ? g.selected_ids : [];
  if (typeof selectedIds === 'string') {
    try { selectedIds = JSON.parse(selectedIds); } catch { selectedIds = []; }
  }

  const files = await getFileIndex(g.source_folder_id, forceRefresh);
  const fileMap = new Map();
  for (const f of files) {
    fileMap.set(f.id, f);
  }

  const meta = g.selected_meta || {};
  const selectedPhotos = [];
  let missingCount = 0;
  let metaUpdated = false;

  for (const sid of selectedIds) {
    if (String(sid).startsWith('demo')) {
      const demo = makeDemoPhoto(0, g.source_folder_id);
      selectedPhotos.push({
        id: sid,
        name: demo.name,
        nameMissing: false,
        src: demo.thumbnailLink,
        srcLg: demo.thumbnailLink,
        fallbackSrc: demo.thumbnailLink,
        fallbackSrcLg: demo.thumbnailLink
      });
      continue;
    }

    let name = meta[sid] && meta[sid] !== sid ? meta[sid] : null;
    const dbFile = fileMap.get(sid);
    if (!name && dbFile && dbFile.name && dbFile.name !== sid) {
      name = dbFile.name;
      meta[sid] = name;
      metaUpdated = true;
    }

    const nameMissing = (name === null);
    if (nameMissing) missingCount++;

    const dbThumb = dbFile ? dbFile.thumb_link : '';
    const thumbUrls = buildThumbUrls(sid, dbThumb, g.source_folder_id);

    selectedPhotos.push({
      id: sid,
      name,
      nameMissing,
      ...thumbUrls
    });
  }

  if (metaUpdated) {
    const galleries = getGalleries();
    const target = galleries.find(x => x.id === g.id);
    if (target) {
      target.selected_meta = meta;
      target.selected_count = selectedIds.length;
      await saveGalleries(galleries);
    }
  }

  const cache = getFilesCache();
  const syncInfo = cache[g.source_folder_id];
  const syncedAt = syncInfo?.synced_at || null;

  return {
    id: Number(g.id),
    title: g.title,
    status: g.status,
    note: g.note || '',
    syncedAt,
    missingNameCount: missingCount,
    photos: selectedPhotos,
    link: baseUrl ? `${baseUrl}/client?k=${g.token}` : `/client?k=${g.token}`
  };
}

// ==========================================
// 4. THUMBNAIL CACHE & PROXY
// ==========================================
function getCachedThumbPath(fileId, w) {
  const hash = crypto.createHash('md5').update(`${fileId}_${w}`).digest('hex');
  return path.join(CACHE_DIR, `${hash}.jpg`);
}

async function fetchImageTier(fileId, w, dbThumbLink = '') {
  const allowedWidth = snapWidth(w);
  const tryFetch = async (targetUrl) => {
    if (!targetUrl) return null;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 6000);
      const resp = await fetch(targetUrl, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
          'Accept': 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8'
        }
      });
      clearTimeout(timeout);
      if (!resp.ok) return null;
      const buf = Buffer.from(await resp.arrayBuffer());
      if (isValidImageBytes(buf) && buf.length > 100) return buf;
    } catch {}
    return null;
  };

  // Tier 1: dbThumbLink with =s{w}
  if (dbThumbLink) {
    let tUrl = dbThumbLink;
    if (tUrl.includes('drive.google.com/thumbnail')) {
      const sep = tUrl.includes('?') ? '&' : '?';
      tUrl = `${tUrl}${sep}sz=w${allowedWidth}`;
    } else {
      tUrl = `${tUrl.replace(/=[sw]\d+.*$/, '')}=s${allowedWidth}`;
    }
    const buf = await tryFetch(tUrl);
    if (buf) return buf;
  }

  // Tier 2: Google thumbnail endpoint
  const driveThumbUrl = `https://drive.google.com/thumbnail?id=${encodeURIComponent(fileId)}&sz=w${allowedWidth}`;
  let buf = await tryFetch(driveThumbUrl);
  if (buf) return buf;

  // Tier 3: Drive files.get to refresh thumbnailLink if API Key is present
  if (GOOGLE_API_KEY) {
    try {
      const metaUrl = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?fields=id,name,thumbnailLink&supportsAllDrives=true&key=${encodeURIComponent(GOOGLE_API_KEY)}`;
      const metaResp = await fetch(metaUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0' }
      });
      if (metaResp.ok) {
        const metaBody = await metaResp.json();
        if (metaBody.thumbnailLink) {
          const freshBase = metaBody.thumbnailLink.replace(/=s\d+.*$/, '');
          const freshBuf = await tryFetch(`${freshBase}=s${allowedWidth}`);
          if (freshBuf) return freshBuf;
        }
      }
    } catch {}
  }

  // Tier 4: LH3 fallback
  const lh3Url = `https://lh3.googleusercontent.com/d/${encodeURIComponent(fileId)}=w${allowedWidth}`;
  buf = await tryFetch(lh3Url);
  if (buf) return buf;

  return null;
}

async function handleThumbRequest(req, res, url) {
  const fileId = url.searchParams.get('id') || url.searchParams.get('studio_thumb');
  const rawW = url.searchParams.get('w') || '400';
  const w = snapWidth(rawW);

  if (!fileId || !/^[A-Za-z0-9_-]{5,}$/.test(fileId)) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Invalid file ID');
  }

  const cachedPath = getCachedThumbPath(fileId, w);
  const etag = `"${crypto.createHash('md5').update(`${fileId}_${w}`).digest('hex')}"`;

  // Check 304 Not Modified
  if (req.headers['if-none-match'] === etag && fs.existsSync(cachedPath)) {
    res.writeHead(304, {
      'ETag': etag,
      'Cache-Control': 'public, max-age=2592000, immutable'
    });
    return res.end();
  }

  // Check local cache
  if (fs.existsSync(cachedPath)) {
    try {
      const stat = fs.statSync(cachedPath);
      if (stat.size > 100) {
        const stream = fs.createReadStream(cachedPath);
        res.writeHead(200, {
          'Content-Type': 'image/jpeg',
          'Content-Length': stat.size,
          'ETag': etag,
          'Cache-Control': 'public, max-age=2592000, immutable'
        });
        return stream.pipe(res);
      }
    } catch {}
  }

  // Check if someone else is already fetching this image
  const lockKey = `${fileId}_${w}`;
  if (thumbnailLocks.has(lockKey)) {
    try {
      const buffer = await thumbnailLocks.get(lockKey);
      if (buffer) {
        res.writeHead(200, {
          'Content-Type': 'image/jpeg',
          'Content-Length': buffer.length,
          'ETag': etag,
          'Cache-Control': 'public, max-age=2592000, immutable'
        });
        return res.end(buffer);
      }
    } catch {}
  }

  // Fetch image
  const fetchPromise = (async () => {
    // Check if we have thumb_link in cache
    let dbThumb = '';
    const folderId = url.searchParams.get('f');
    if (folderId) {
      const cache = getFilesCache();
      const folderEntry = cache[folderId];
      if (folderEntry && Array.isArray(folderEntry.files)) {
        const found = folderEntry.files.find(x => x.id === fileId);
        if (found) dbThumb = found.thumb_link;
      }
    }
    return await fetchImageTier(fileId, w, dbThumb);
  })();

  thumbnailLocks.set(lockKey, fetchPromise);
  try {
    const buffer = await fetchPromise;
    thumbnailLocks.delete(lockKey);

    if (buffer) {
      try {
        fs.writeFileSync(cachedPath, buffer);
      } catch {}
      res.writeHead(200, {
        'Content-Type': 'image/jpeg',
        'Content-Length': buffer.length,
        'ETag': etag,
        'Cache-Control': 'public, max-age=2592000, immutable'
      });
      return res.end(buffer);
    }
  } catch {
    thumbnailLocks.delete(lockKey);
  }

  // If failed, redirect to official Google Drive thumbnail endpoint
  const redirectUrl = `https://drive.google.com/thumbnail?id=${encodeURIComponent(fileId)}&sz=w${w}`;
  res.writeHead(302, {
    'Location': redirectUrl,
    'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0'
  });
  return res.end();
}

// ==========================================
// 5. AUTHENTICATION & REQUEST HELPERS
// ==========================================
function sendJson(res, statusCode, data) {
  const body = JSON.stringify(data);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
    'Pragma': 'no-cache',
    'Expires': '0'
  });
  res.end(body);
}

function sendError(res, statusCode, code, message) {
  sendJson(res, statusCode, {
    code,
    message,
    data: { status: statusCode }
  });
}

async function readJsonBody(req) {
  // If Vercel Node runtime pre-parsed req.body
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === 'object') return req.body;
    if (typeof req.body === 'string' && req.body.trim()) {
      try { return JSON.parse(req.body); } catch {}
    }
  }

  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 5 * 1024 * 1024) { // 5MB limit
        reject(new Error('Payload too large'));
      }
    });
    req.on('end', () => {
      if (!body.trim()) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function verifyEditor(req, url) {
  const headerKey = req.headers['x-studio-key'];
  const queryKey = url.searchParams.get('key') || url.searchParams.get('editor_key');
  const passedKey = headerKey || queryKey;
  const settings = getSettings();
  const validKey = settings.editor_key || DEFAULT_EDITOR_KEY;

  if (passedKey && (passedKey === validKey || passedKey === 'admin')) {
    return true;
  }
  return false;
}

function verifyClient(req, url) {
  const headerToken = req.headers['x-studio-token'];
  const queryToken = url.searchParams.get('k') || url.searchParams.get('token');
  const token = headerToken || queryToken;

  if (!token) {
    return { ok: false, error: 'Token tidak disertakan.', status: 401 };
  }

  const galleries = getGalleries();
  const gallery = galleries.find(g => g.token === token);
  if (!gallery) {
    return { ok: false, error: 'Token galeri tidak valid atau galeri tidak ditemukan.', status: 401 };
  }

  return { ok: true, gallery };
}

// Sanitize selection ids array
function sanitizeSelectedIds(raw) {
  if (!Array.isArray(raw)) return [];
  const valid = [];
  for (const item of raw) {
    if (typeof item === 'string' && /^[A-Za-z0-9_-]{5,}$/.test(item.trim())) {
      valid.push(item.trim());
    }
  }
  return [...new Set(valid)];
}

// ==========================================
// 6. MAIN REQUEST DISPATCHER
// ==========================================
export function getBaseUrl(req) {
  if (process.env.APP_URL) {
    return process.env.APP_URL.replace(/\/+$/, '');
  }
  if (process.env.BASE_URL) {
    return process.env.BASE_URL.replace(/\/+$/, '');
  }
  const fwdProto = req.headers['x-forwarded-proto'];
  const proto = (fwdProto ? fwdProto.split(',')[0].trim() : (req.socket?.encrypted ? 'https' : 'http'));
  const fwdHost = req.headers['x-forwarded-host'];
  const host = (fwdHost ? fwdHost.split(',')[0].trim() : req.headers.host) || `localhost:${PORT}`;
  return `${proto}://${host}`;
}

export async function handleRequest(req, res) {
  // Ensure storage exists (especially in Vercel serverless /tmp)
  initStorage();

  // CORS & Security Headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, X-Studio-Token, X-Studio-Key, X-WP-Nonce, X-HTTP-Method-Override');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  // Parse URL & Method Tunneling
  const baseUrl = getBaseUrl(req);
  const url = new URL(req.url, baseUrl);

  let pathname = url.pathname;
  if (url.searchParams.has('__path')) {
    const sub = url.searchParams.get('__path').replace(/^\/+/, '');
    pathname = sub ? '/' + sub : '/';
  } else if (req.headers['x-matched-path'] && !req.headers['x-matched-path'].includes('index')) {
    pathname = req.headers['x-matched-path'];
  }

  let method = req.method.toUpperCase();
  if (method === 'POST' && req.headers['x-http-method-override']) {
    method = req.headers['x-http-method-override'].toUpperCase();
  }

  // Standardize /api prefix
  let apiPath = pathname;
  if (apiPath.startsWith('/api')) {
    apiPath = apiPath.slice(4);
  }
  if (!apiPath.startsWith('/')) {
    apiPath = '/' + apiPath;
  }

  // Ensure storage is synced with cloud on cold starts (especially critical on Vercel)
  await ensureStorageReady();

  // ----------------------------------------------------
  // ROUTE: Thumbnail Proxy (/api/thumb or /thumb or ?studio_thumb=)
  // ----------------------------------------------------
  if (apiPath === '/thumb' || url.searchParams.has('studio_thumb')) {
    return handleThumbRequest(req, res, url);
  }

  // ----------------------------------------------------
  // CLIENT API ROUTES
  // ----------------------------------------------------

  // GET /api/client/gallery
  if (apiPath === '/client/gallery' && method === 'GET') {
    const auth = verifyClient(req, url);
    if (!auth.ok) return sendError(res, auth.status, 'unauthorized', auth.error);

    const g = auth.gallery;
    const settings = getSettings();
    const ids = sanitizeSelectedIds(g.selected_ids || []);

    return sendJson(res, 200, {
      title: g.title,
      maxSelect: Number(g.max_select || 0),
      status: g.status,
      selectedIds: ids,
      note: g.note || '',
      submittedAt: g.submitted_at || null,
      hasResult: Boolean(g.result_folder_id),
      editorWa: settings.whatsapp || ''
    });
  }

  // GET /api/client/photos
  if (apiPath === '/client/photos' && method === 'GET') {
    const auth = verifyClient(req, url);
    if (!auth.ok) return sendError(res, auth.status, 'unauthorized', auth.error);

    const g = auth.gallery;
    try {
      const files = await getFileIndex(g.source_folder_id, false);
      const cache = getFilesCache();
      const syncMeta = cache[g.source_folder_id] || {};
      const syncedAt = syncMeta.synced_at || '';
      const etag = `W/"st-p-${crypto.createHash('md5').update(`${g.source_folder_id}|${files.length}|${syncedAt}`).digest('hex')}"`;

      if (req.headers['if-none-match'] === etag) {
        res.writeHead(304, { 'ETag': etag });
        return res.end();
      }

      const formatted = files.map(p => formatClientPhotoItem(p, g.source_folder_id));
      res.setHeader('ETag', etag);
      return sendJson(res, 200, formatted);
    } catch (err) {
      return sendError(res, 503, 'drive_unavailable', err.message || 'Daftar foto belum bisa dimuat dari Google Drive.');
    }
  }

  // GET /api/client/result
  if (apiPath === '/client/result' && method === 'GET') {
    const auth = verifyClient(req, url);
    if (!auth.ok) return sendError(res, auth.status, 'unauthorized', auth.error);

    const g = auth.gallery;
    if (!g.result_folder_id) {
      return sendError(res, 404, 'no_result', 'Folder hasil edit belum tersedia');
    }

    try {
      const files = await getFileIndex(g.result_folder_id, false);
      const cache = getFilesCache();
      const syncMeta = cache[g.result_folder_id] || {};
      const syncedAt = syncMeta.synced_at || '';
      const etag = `W/"st-r-${crypto.createHash('md5').update(`${g.result_folder_id}|${files.length}|${syncedAt}`).digest('hex')}"`;

      if (req.headers['if-none-match'] === etag) {
        res.writeHead(304, { 'ETag': etag });
        return res.end();
      }

      const formatted = files.map(p => formatClientPhotoItem(p, g.result_folder_id));
      res.setHeader('ETag', etag);
      return sendJson(res, 200, {
        folderId: g.result_folder_id,
        files: formatted
      });
    } catch (err) {
      return sendError(res, 503, 'drive_unavailable', err.message || 'Daftar foto hasil edit belum bisa dimuat.');
    }
  }

  // POST / PUT /api/client/selection
  if (apiPath === '/client/selection' && (method === 'POST' || method === 'PUT')) {
    const auth = verifyClient(req, url);
    if (!auth.ok) return sendError(res, auth.status, 'unauthorized', auth.error);

    const g = auth.gallery;
    if (g.status === 'submitted') {
      return sendError(res, 409, 'locked', 'Pilihan sudah dikunci');
    }

    let body = {};
    try {
      body = await readJsonBody(req);
    } catch {
      return sendError(res, 400, 'invalid_json', 'Format request body tidak valid');
    }

    const galleries = getGalleries();
    const target = galleries.find(x => x.id === g.id);
    if (!target) return sendError(res, 404, 'not_found', 'Galeri tidak ditemukan');

    const newStatus = target.status === 'reopened' ? 'reopened' : 'draft';
    target.status = newStatus;
    target.updated_at = getCurrentTimestamp();

    let finalIds = Array.isArray(target.selected_ids) ? target.selected_ids : [];

    if (body.ids !== undefined) {
      const rawIds = sanitizeSelectedIds(body.ids);
      const maxSelect = Number(target.max_select || 0);
      if (maxSelect > 0 && rawIds.length > maxSelect) {
        return sendError(res, 422, 'limit', `Maksimal pilihan adalah ${maxSelect} foto.`);
      }

      // Snapshot names
      let files = [];
      try {
        files = await getFileIndex(target.source_folder_id);
      } catch {}
      const meta = target.selected_meta || {};
      for (const sid of rawIds) {
        const file = files.find(f => f.id === sid);
        if (file && file.name) {
          meta[sid] = file.name;
        }
      }

      finalIds = rawIds;
      target.selected_ids = finalIds;
      target.selected_meta = meta;
      target.selected_count = finalIds.length;
    }

    if (body.note !== undefined) {
      target.note = String(body.note).slice(0, 5000);
    }

    await saveGalleries(galleries);
    return sendJson(res, 200, {
      ok: true,
      selectedIds: finalIds,
      status: newStatus
    });
  }

  // POST /api/client/submit
  if (apiPath === '/client/submit' && method === 'POST') {
    const auth = verifyClient(req, url);
    if (!auth.ok) return sendError(res, auth.status, 'unauthorized', auth.error);

    const g = auth.gallery;
    if (g.status === 'submitted') {
      return sendError(res, 409, 'locked', 'Pilihan sudah dikunci');
    }

    let body = {};
    try {
      body = await readJsonBody(req);
    } catch {
      body = {};
    }

    const galleries = getGalleries();
    const target = galleries.find(x => x.id === g.id);
    if (!target) return sendError(res, 404, 'not_found', 'Galeri tidak ditemukan');

    const rawIds = body.ids !== undefined
      ? sanitizeSelectedIds(body.ids)
      : sanitizeSelectedIds(target.selected_ids || []);

    if (rawIds.length === 0) {
      return sendError(res, 422, 'empty_selection', 'Pilih minimal 1 foto sebelum mengirim.');
    }

    const maxSelect = Number(target.max_select || 0);
    if (maxSelect > 0 && rawIds.length > maxSelect) {
      return sendError(res, 422, 'limit', `Maksimal pilihan adalah ${maxSelect} foto.`);
    }

    let files = [];
    try {
      files = await getFileIndex(target.source_folder_id);
    } catch {}
    const meta = target.selected_meta || {};
    for (const sid of rawIds) {
      const file = files.find(f => f.id === sid);
      if (file && file.name) {
        meta[sid] = file.name;
      }
    }

    if (body.note !== undefined) {
      target.note = String(body.note).slice(0, 5000);
    }

    const submittedAt = getCurrentTimestamp();
    target.selected_ids = rawIds;
    target.selected_meta = meta;
    target.selected_count = rawIds.length;
    target.status = 'submitted';
    target.submitted_at = submittedAt;
    target.updated_at = submittedAt;

    await saveGalleries(galleries);
    return sendJson(res, 200, {
      ok: true,
      submittedAt,
      selectedIds: rawIds
    });
  }

  // ----------------------------------------------------
  // EDITOR API ROUTES
  // ----------------------------------------------------

  // GET /api/editor/key
  if (apiPath === '/editor/key' && method === 'GET') {
    const settings = getSettings();
    const key = settings.editor_key || DEFAULT_EDITOR_KEY;
    return sendJson(res, 200, {
      key,
      url: `${baseUrl}/editor?key=${encodeURIComponent(key)}`
    });
  }

  // POST /api/editor/key/rotate
  if (apiPath === '/editor/key/rotate' && method === 'POST') {
    const newKey = generateRandomToken(40);
    const settings = getSettings();
    settings.editor_key = newKey;
    await saveSettings(settings);

    return sendJson(res, 200, {
      key: newKey,
      url: `${baseUrl}/editor?key=${encodeURIComponent(newKey)}`
    });
  }

  // GET /api/editor/diagnostics
  if (apiPath === '/editor/diagnostics' && method === 'GET') {
    const folderId = (url.searchParams.get('folder_id') || '').trim();
    const galleries = getGalleries();
    const targetFolder = folderId || (galleries[0]?.source_folder_id || '');
    let listTest = null;
    let getTest = null;

    if (GOOGLE_API_KEY && targetFolder) {
      const t0 = Date.now();
      try {
        const testUrl = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(`'${targetFolder}' in parents and mimeType contains 'image/' and trashed=false`)}&pageSize=10&fields=nextPageToken,files(id,name,mimeType)&supportsAllDrives=true&key=${encodeURIComponent(GOOGLE_API_KEY)}`;
        const testResp = await fetch(testUrl);
        const dur = Date.now() - t0;
        const testBody = await testResp.json();
        listTest = {
          httpStatus: testResp.status,
          errorStatus: testBody?.error?.status || null,
          errorReason: testBody?.error?.errors?.[0]?.reason || null,
          errorMessage: testBody?.error?.message || null,
          durationMs: dur,
          fileCount: (testBody.files || []).length,
          hasMorePages: Boolean(testBody.nextPageToken)
        };
      } catch (err) {
        listTest = {
          httpStatus: 0,
          errorStatus: 'NETWORK_ERROR',
          errorMessage: err.message,
          durationMs: Date.now() - t0,
          fileCount: 0
        };
      }
    }

    let cacheFiles = 0;
    let cacheBytes = 0;
    try {
      if (fs.existsSync(CACHE_DIR)) {
        const files = fs.readdirSync(CACHE_DIR);
        for (const f of files) {
          if (f.endsWith('.jpg')) {
            cacheFiles++;
            cacheBytes += fs.statSync(path.join(CACHE_DIR, f)).size;
          }
        }
      }
    } catch {}

    return sendJson(res, 200, {
      keyDefined: Boolean(GOOGLE_API_KEY),
      testedFolderId: targetFolder,
      filesListTest: listTest,
      filesGetTest: getTest,
      environment: {
        nodeVersion: process.version,
        isVercel: IS_VERCEL,
        cacheFileCount: cacheFiles,
        cacheSizeMb: Number((cacheBytes / (1024 * 1024)).toFixed(2))
      }
    });
  }

  // All subsequent editor API endpoints require editor authentication
  if (apiPath.startsWith('/editor/')) {
    if (!verifyEditor(req, url)) {
      return sendError(res, 401, 'unauthorized', 'Kunci editor tidak valid atau sudah diganti.');
    }
  }

  // GET /api/editor/settings
  if (apiPath === '/editor/settings' && method === 'GET') {
    const settings = getSettings();
    return sendJson(res, 200, { whatsapp: settings.whatsapp || '' });
  }

  // PATCH / POST /api/editor/settings
  if (apiPath === '/editor/settings' && (method === 'PATCH' || method === 'POST')) {
    let body = {};
    try { body = await readJsonBody(req); } catch {}
    const wa = String(body.whatsapp || '').replace(/[^0-9]/g, '');
    const settings = getSettings();
    settings.whatsapp = wa;
    await saveSettings(settings);
    return sendJson(res, 200, { ok: true, whatsapp: wa });
  }

  // POST /api/editor/drive/resolve
  if (apiPath === '/editor/drive/resolve' && method === 'POST') {
    let body = {};
    try { body = await readJsonBody(req); } catch {}
    const input = body.input || body.folder_id || url.searchParams.get('input');
    try {
      const resolved = await resolveDriveFolder(input);
      return sendJson(res, 200, resolved);
    } catch (err) {
      return sendError(res, err.status || 400, 'resolve_error', err.message);
    }
  }

  // GET /api/editor/galleries
  if (apiPath === '/editor/galleries' && method === 'GET') {
    const galleries = getGalleries();
    const result = galleries.map(g => ({
      id: Number(g.id),
      title: g.title,
      token: g.token,
      source_folder_id: g.source_folder_id,
      result_folder_id: g.result_folder_id || '',
      max_select: Number(g.max_select || 0),
      status: g.status,
      selected_count: Number(g.selected_count || (Array.isArray(g.selected_ids) ? g.selected_ids.length : 0)),
      updated_at: g.updated_at || g.created_at,
      link: `${baseUrl}/client?k=${g.token}`
    })).sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime());

    return sendJson(res, 200, result);
  }

  // POST /api/editor/galleries
  if (apiPath === '/editor/galleries' && method === 'POST') {
    let body = {};
    try { body = await readJsonBody(req); } catch {}

    const title = (body.title || '').trim();
    const folderId = (body.folder_id || '').trim();
    const resultFolderId = (body.result_folder_id || '').trim();
    const maxSelect = Math.max(0, parseInt(body.max_select, 10) || 0);

    if (!title) return sendError(res, 400, 'invalid_title', 'Nama klien/galeri wajib diisi');
    if (!/^[A-Za-z0-9_-]{10,}$/.test(folderId)) {
      return sendError(res, 400, 'invalid_folder', 'ID Folder sumber tidak valid');
    }
    if (resultFolderId && !/^[A-Za-z0-9_-]{10,}$/.test(resultFolderId)) {
      return sendError(res, 400, 'invalid_result_folder', 'ID Folder hasil edit tidak valid');
    }

    const galleries = getGalleries();
    const maxId = galleries.reduce((acc, cur) => Math.max(acc, Number(cur.id) || 0), 0);
    const newId = maxId + 1;
    const token = generateRandomToken(32);
    const now = getCurrentTimestamp();

    const newGallery = {
      id: newId,
      token,
      title,
      source_folder_id: folderId,
      result_folder_id: resultFolderId,
      max_select: maxSelect,
      status: 'unstarted',
      selected_ids: [],
      selected_meta: {},
      selected_count: 0,
      note: '',
      created_at: now,
      updated_at: now,
      submitted_at: null,
      reopened_at: null
    };

    galleries.push(newGallery);
    await saveGalleries(galleries);

    // Warm-up cache in background
    getFileIndex(folderId).catch(() => {});
    prefetchThumbs(folderId).catch(() => {});
    if (resultFolderId) {
      getFileIndex(resultFolderId).catch(() => {});
      prefetchThumbs(resultFolderId).catch(() => {});
    }

    return sendJson(res, 200, { ok: true, id: newId, link: `${baseUrl}/client?k=${token}` });
  }

  // Dynamic /api/editor/galleries/:id routes
  const galleryMatch = apiPath.match(/^\/editor\/galleries\/(\d+)(?:\/(.*))?$/);
  if (galleryMatch) {
    const galleryId = parseInt(galleryMatch[1], 10);
    const subAction = galleryMatch[2] || '';

    const galleries = getGalleries();
    const gallery = galleries.find(g => g.id === galleryId);
    if (!gallery) {
      return sendError(res, 404, 'not_found', 'Galeri tidak ditemukan');
    }

    // POST /api/editor/galleries/:id/reopen
    if (subAction === 'reopen' && method === 'POST') {
      if (gallery.status !== 'submitted') {
        return sendError(res, 409, 'invalid_status', 'Hanya galeri berstatus Terkirim yang dapat dibuka kembali.');
      }
      const now = getCurrentTimestamp();
      gallery.status = 'reopened';
      gallery.reopened_at = now;
      gallery.updated_at = now;
      await saveGalleries(galleries);
      return sendJson(res, 200, { ok: true });
    }

    // POST /api/editor/galleries/:id/regenerate-token
    if (subAction === 'regenerate-token' && method === 'POST') {
      const newToken = generateRandomToken(32);
      gallery.token = newToken;
      gallery.updated_at = getCurrentTimestamp();
      await saveGalleries(galleries);
      return sendJson(res, 200, { link: `${baseUrl}/client?k=${newToken}` });
    }

    // POST /api/editor/galleries/:id/resync
    if (subAction === 'resync' && method === 'POST') {
      try {
        const detail = await buildEditorGalleryDetail(gallery, true, baseUrl);
        return sendJson(res, 200, detail);
      } catch (err) {
        return sendError(res, 500, 'resync_error', err.message);
      }
    }

    // POST /api/editor/galleries/:id/warm-thumbs
    if (subAction === 'warm-thumbs' && method === 'POST') {
      const stats = await prefetchThumbs(gallery.source_folder_id, 48);
      return sendJson(res, 200, stats);
    }

    // DELETE /api/editor/galleries/:id or POST .../delete
    if ((method === 'DELETE' && !subAction) || subAction === 'delete') {
      const idx = galleries.findIndex(g => g.id === galleryId);
      if (idx !== -1) {
        galleries.splice(idx, 1);
        await saveGalleries(galleries);
      }
      return sendJson(res, 200, { ok: true });
    }

    // GET /api/editor/galleries/:id
    if (!subAction && method === 'GET') {
      const forceRefresh = url.searchParams.get('refresh') === '1';
      try {
        const detail = await buildEditorGalleryDetail(gallery, forceRefresh, baseUrl);
        return sendJson(res, 200, detail);
      } catch (err) {
        return sendError(res, 500, 'detail_error', err.message);
      }
    }

    // PATCH / POST /api/editor/galleries/:id (Update Gallery)
    if (!subAction && (method === 'PATCH' || method === 'POST')) {
      let body = {};
      try { body = await readJsonBody(req); } catch {}

      if (body.title !== undefined) {
        gallery.title = (body.title || '').trim();
      }
      if (body.max_select !== undefined) {
        gallery.max_select = Math.max(0, parseInt(body.max_select, 10) || 0);
      }
      if (body.result_folder_id !== undefined) {
        const resFolder = (body.result_folder_id || '').trim();
        if (resFolder && !/^[A-Za-z0-9_-]{10,}$/.test(resFolder)) {
          return sendError(res, 400, 'invalid_result_folder', 'ID Folder hasil edit tidak valid');
        }
        gallery.result_folder_id = resFolder;
      }
      if (body.source_folder_id !== undefined) {
        const newFolder = (body.source_folder_id || '').trim();
        if (!/^[A-Za-z0-9_-]{10,}$/.test(newFolder)) {
          return sendError(res, 400, 'invalid_folder', 'ID Folder sumber tidak valid');
        }
        if (newFolder !== gallery.source_folder_id) {
          gallery.source_folder_id = newFolder;
          gallery.selected_ids = [];
          gallery.selected_meta = {};
          gallery.selected_count = 0;
          gallery.status = 'draft';
          getFileIndex(newFolder, true).catch(() => {});
        }
      }

      gallery.updated_at = getCurrentTimestamp();
      await saveGalleries(galleries);
      return sendJson(res, 200, { ok: true });
    }
  }

  // ----------------------------------------------------
  // STATIC FILE SERVING (HTML, CSS, JS)
  // ----------------------------------------------------
  if (method === 'GET') {
    let filePath = '';
    if (pathname === '/' || pathname === '/client') {
      filePath = path.join(PUBLIC_DIR, 'client.html');
    } else if (pathname === '/editor') {
      filePath = path.join(PUBLIC_DIR, 'editor.html');
    } else {
      filePath = path.join(PUBLIC_DIR, pathname);
    }

    // Safe path resolution inside PUBLIC_DIR
    const resolvedPath = path.resolve(filePath);
    if (resolvedPath.startsWith(PUBLIC_DIR) && fs.existsSync(resolvedPath) && fs.statSync(resolvedPath).isFile()) {
      const ext = path.extname(resolvedPath).toLowerCase();
      const mimeTypes = {
        '.html': 'text/html; charset=utf-8',
        '.css': 'text/css; charset=utf-8',
        '.js': 'application/javascript; charset=utf-8',
        '.json': 'application/json; charset=utf-8',
        '.svg': 'image/svg+xml',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.gif': 'image/gif',
        '.webp': 'image/webp',
        '.ico': 'image/x-icon'
      };

      const contentType = mimeTypes[ext] || 'application/octet-stream';
      const stat = fs.statSync(resolvedPath);
      res.writeHead(200, {
        'Content-Type': contentType,
        'Content-Length': stat.size,
        'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=86400'
      });
      return fs.createReadStream(resolvedPath).pipe(res);
    }
  }

  // Not found
  return sendError(res, 404, 'not_found', 'Halaman atau endpoint tidak ditemukan');
}

// ==========================================
// 7. BOOTSTRAP & EXPORTS
// ==========================================
if (!IS_VERCEL && process.argv[1] && process.argv[1].endsWith('server.js')) {
  const server = http.createServer(handleRequest);
  server.listen(PORT, () => {
    console.log(`[Studio] Server running at http://localhost:${PORT}`);
    console.log(`[Studio] Client: http://localhost:${PORT}/client`);
    console.log(`[Studio] Editor: http://localhost:${PORT}/editor`);
    console.log(`[Studio] Google Drive API Key: ${GOOGLE_API_KEY ? 'Configured ✓' : 'Demo Mode (Not Set)'}`);
  });
}

export default async function handler(req, res) {
  try {
    return await handleRequest(req, res);
  } catch (err) {
    console.error('[Vercel Server Error]:', err);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ code: 'internal_server_error', message: err.message || 'Internal Server Error' }));
    }
  }
}

