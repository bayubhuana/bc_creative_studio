import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ==========================================
// 1. ENVIRONMENT & DIRECTORY CONFIGURATION
// ==========================================
export const IS_VERCEL = Boolean(process.env.VERCEL);
export const DATA_DIR = IS_VERCEL ? path.join('/tmp', 'pilih-foto-data') : path.join(__dirname, 'data');
export const CACHE_DIR = IS_VERCEL ? path.join('/tmp', 'pilih-foto-cache') : path.join(__dirname, 'data', 'thumb-cache');

export const GALLERIES_FILE = path.join(DATA_DIR, 'galleries.json');
export const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
export const FILES_CACHE_FILE = path.join(DATA_DIR, 'files_cache.json');

const DEFAULT_EDITOR_KEY = (process.env.EDITOR_KEY || 'admin').trim();
const DEFAULT_WA = (process.env.EDITOR_WA || '').trim();

// In-Memory State for sub-millisecond reads (< 1 ms)
const memoryState = {
  galleries: null,
  settings: null,
  filesCache: null,
  isInitialized: false
};

// Micro-batching debounce timers for cloud uploads
const cloudDebounceTimers = new Map();
const DEBOUNCE_DELAY_MS = 2000;

// Cached OAuth2 Access Token for Firebase & Google Cloud
let cachedOAuth = {
  token: null,
  expiresAt: 0
};

// ==========================================
// 2. HELPER FUNCTIONS
// ==========================================
// Normalizer to handle Firebase RTDB converting arrays to numeric keyed objects (e.g. {"0": {...}})
export function normalizeArray(data) {
  if (Array.isArray(data)) return data;
  if (data && typeof data === 'object') return Object.values(data);
  return [];
}

// ==========================================
// 3. CREDENTIAL PARSER (MULTI-BACKEND FAIL-SAFE)
// ==========================================
export function getFirebaseConfig() {
  try {
    let rtdbUrl = (process.env.FIREBASE_DATABASE_URL || '').trim();
    if (rtdbUrl) {
      rtdbUrl = rtdbUrl.replace(/\/+$/, '');
    }

    const databaseSecret = (process.env.FIREBASE_DATABASE_SECRET || '').trim();

    let rawBucket = (process.env.FIREBASE_STORAGE_BUCKET || process.env.GCS_BUCKET || '').trim();
    if (rawBucket.startsWith('gs://')) {
      rawBucket = rawBucket.slice(5);
    }
    rawBucket = rawBucket.replace(/\/+$/, '');

    let clientEmail = (process.env.FIREBASE_CLIENT_EMAIL || '').trim();
    let privateKey = (process.env.FIREBASE_PRIVATE_KEY || '').trim();
    let projectId = (process.env.FIREBASE_PROJECT_ID || '').trim();
    let apiKey = (process.env.FIREBASE_API_KEY || '').trim();

    // Check if full service account JSON was provided
    const serviceAccountJson = (process.env.FIREBASE_SERVICE_ACCOUNT_KEY || process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON || '').trim();
    if (serviceAccountJson) {
      try {
        const parsed = JSON.parse(serviceAccountJson);
        if (parsed.client_email) clientEmail = parsed.client_email;
        if (parsed.private_key) privateKey = parsed.private_key;
        if (parsed.project_id) projectId = parsed.project_id;
        if (!rawBucket && parsed.project_id) {
          rawBucket = `${parsed.project_id}.firebasestorage.app`;
        }
      } catch (jsonErr) {
        console.warn('[Storage] Warning: Failed to parse FIREBASE_SERVICE_ACCOUNT_KEY JSON:', jsonErr.message);
      }
    }

    if (privateKey) {
      privateKey = privateKey.replace(/\\n/g, '\n');
    }

    if (!rawBucket && projectId) {
      rawBucket = `${projectId}.firebasestorage.app`;
    }

    const hasServiceAccount = Boolean(clientEmail && privateKey);
    const hasApiKey = Boolean(apiKey);
    const hasSecret = Boolean(databaseSecret);

    const isRtdb = Boolean(rtdbUrl);
    const isStorage = Boolean(rawBucket && (hasServiceAccount || hasApiKey));

    return {
      rtdbUrl,
      databaseSecret,
      bucket: rawBucket,
      clientEmail,
      privateKey,
      projectId,
      apiKey,
      hasServiceAccount,
      hasApiKey,
      hasSecret,
      isRtdb,
      isStorage
    };
  } catch (err) {
    console.warn('[Storage] Exception in getFirebaseConfig:', err.message);
    return null;
  }
}

export function isRtdbReady() {
  const cfg = getFirebaseConfig();
  return Boolean(cfg && cfg.isRtdb);
}

export function isFirebaseStorageReady() {
  const cfg = getFirebaseConfig();
  return Boolean(cfg && cfg.isStorage);
}

export function isFirebaseReady() {
  const cfg = getFirebaseConfig();
  return Boolean(cfg && (cfg.isRtdb || cfg.isStorage));
}

// ==========================================
// 4. ZERO-DEPENDENCY GOOGLE OAUTH2 TOKEN
// ==========================================
async function getGoogleAccessToken(cfg) {
  if (!cfg || !cfg.hasServiceAccount) return null;

  const now = Math.floor(Date.now() / 1000);
  if (cachedOAuth.token && cachedOAuth.expiresAt > now + 60) {
    return cachedOAuth.token;
  }

  try {
    const header = { alg: 'RS256', typ: 'JWT' };
    const claimSet = {
      iss: cfg.clientEmail,
      scope: 'https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/firebase.database https://www.googleapis.com/auth/devstorage.read_write',
      aud: 'https://oauth2.googleapis.com/token',
      exp: now + 3600,
      iat: now
    };

    const encodedHeader = Buffer.from(JSON.stringify(header)).toString('base64url');
    const encodedClaimSet = Buffer.from(JSON.stringify(claimSet)).toString('base64url');
    const signatureInput = `${encodedHeader}.${encodedClaimSet}`;

    const signer = crypto.createSign('RSA-SHA256');
    signer.update(signatureInput);
    const signature = signer.sign(cfg.privateKey, 'base64url');
    const jwt = `${signatureInput}.${signature}`;

    const resp = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: jwt
      }),
      signal: AbortSignal.timeout(5000)
    });

    if (!resp.ok) {
      const errText = await resp.text();
      console.warn(`[Storage] OAuth2 token request failed (HTTP ${resp.status}): ${errText}`);
      return null;
    }

    const data = await resp.json();
    if (data.access_token) {
      cachedOAuth = {
        token: data.access_token,
        expiresAt: now + (data.expires_in || 3600)
      };
      return data.access_token;
    }
    return null;
  } catch (err) {
    console.warn('[Storage] Failed to generate Google OAuth2 token:', err.message);
    return null;
  }
}

// ==========================================
// 5. FIREBASE REALTIME DATABASE REST CLIENT
// ==========================================
async function fetchFromRtdb(key) {
  const cfg = getFirebaseConfig();
  if (!cfg || !cfg.isRtdb) return null;

  try {
    let url = `${cfg.rtdbUrl}/data/${encodeURIComponent(key)}.json`;
    const headers = {};

    if (cfg.hasServiceAccount) {
      const token = await getGoogleAccessToken(cfg);
      if (token) {
        headers['Authorization'] = `Bearer ${token}`;
      } else if (cfg.hasSecret) {
        url += `?auth=${encodeURIComponent(cfg.databaseSecret)}`;
      }
    } else if (cfg.hasSecret) {
      url += `?auth=${encodeURIComponent(cfg.databaseSecret)}`;
    }

    const resp = await fetch(url, { headers, signal: AbortSignal.timeout(5000) });
    if (resp.status === 404) return null;
    if (!resp.ok) {
      console.warn(`[Storage] RTDB GET /data/${key}.json returned HTTP ${resp.status}`);
      return null;
    }

    const data = await resp.json();
    if (data === null) return null;
    return data;
  } catch (err) {
    console.warn(`[Storage] RTDB fetch for ${key} failed:`, err.message);
    return null;
  }
}

async function saveToRtdb(key, data) {
  const cfg = getFirebaseConfig();
  if (!cfg || !cfg.isRtdb) return false;

  try {
    let url = `${cfg.rtdbUrl}/data/${encodeURIComponent(key)}.json`;
    const headers = { 'Content-Type': 'application/json' };

    if (cfg.hasServiceAccount) {
      const token = await getGoogleAccessToken(cfg);
      if (token) {
        headers['Authorization'] = `Bearer ${token}`;
      } else if (cfg.hasSecret) {
        url += `?auth=${encodeURIComponent(cfg.databaseSecret)}`;
      }
    } else if (cfg.hasSecret) {
      url += `?auth=${encodeURIComponent(cfg.databaseSecret)}`;
    }

    const payload = JSON.stringify(data);
    const resp = await fetch(url, {
      method: 'PUT',
      headers,
      body: payload,
      signal: AbortSignal.timeout(6000)
    });

    if (!resp.ok) {
      const errText = await resp.text();
      console.warn(`[Storage] RTDB PUT /data/${key}.json returned HTTP ${resp.status}: ${errText}`);
      return false;
    }

    return true;
  } catch (err) {
    console.warn(`[Storage] RTDB save for ${key} failed:`, err.message);
    return false;
  }
}

// ==========================================
// 6. CLOUD STORAGE REST CLIENT (FAIL-SAFE)
// ==========================================
async function downloadFromGcs(remotePath) {
  const cfg = getFirebaseConfig();
  if (!cfg || !cfg.isStorage) return null;

  try {
    let url = '';
    const headers = {};

    if (cfg.hasServiceAccount) {
      const token = await getGoogleAccessToken(cfg);
      if (!token) return null;
      url = `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(cfg.bucket)}/o/${encodeURIComponent(remotePath)}?alt=media`;
      headers['Authorization'] = `Bearer ${token}`;
    } else if (cfg.hasApiKey) {
      url = `https://firebasestorage.googleapis.com/v0/b/${encodeURIComponent(cfg.bucket)}/o/${encodeURIComponent(remotePath)}?alt=media&key=${encodeURIComponent(cfg.apiKey)}`;
    } else {
      return null;
    }

    const resp = await fetch(url, { headers, signal: AbortSignal.timeout(6000) });
    if (resp.status === 404) return null;
    if (!resp.ok) {
      console.warn(`[Storage] GCS download for ${remotePath} returned HTTP ${resp.status}`);
      return null;
    }

    return await resp.text();
  } catch (err) {
    console.warn(`[Storage] GCS download for ${remotePath} failed:`, err.message);
    return null;
  }
}

async function uploadToGcs(remotePath, contentString) {
  const cfg = getFirebaseConfig();
  if (!cfg || !cfg.isStorage) return false;

  try {
    let url = '';
    const headers = { 'Content-Type': 'application/json' };

    if (cfg.hasServiceAccount) {
      const token = await getGoogleAccessToken(cfg);
      if (!token) return false;
      url = `https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(cfg.bucket)}/o?uploadType=media&name=${encodeURIComponent(remotePath)}`;
      headers['Authorization'] = `Bearer ${token}`;
    } else if (cfg.hasApiKey) {
      url = `https://firebasestorage.googleapis.com/v0/b/${encodeURIComponent(cfg.bucket)}/o?name=${encodeURIComponent(remotePath)}&key=${encodeURIComponent(cfg.apiKey)}`;
    } else {
      return false;
    }

    const resp = await fetch(url, {
      method: 'POST',
      headers,
      body: contentString,
      signal: AbortSignal.timeout(8000)
    });

    if (!resp.ok) {
      const errText = await resp.text();
      console.warn(`[Storage] GCS upload for ${remotePath} returned HTTP ${resp.status}: ${errText}`);
      return false;
    }

    return true;
  } catch (err) {
    console.warn(`[Storage] GCS upload for ${remotePath} failed:`, err.message);
    return false;
  }
}

// ==========================================
// 7. MICRO-BATCHING DEBOUNCED SYNC QUEUE
// ==========================================
function queueCloudSync(filename, data) {
  if (!isFirebaseReady()) return;

  const timerKey = filename;
  if (cloudDebounceTimers.has(timerKey)) {
    clearTimeout(cloudDebounceTimers.get(timerKey));
  }

  const timer = setTimeout(async () => {
    cloudDebounceTimers.delete(timerKey);
    try {
      const key = filename.replace(/\.json$/, '');
      if (isRtdbReady()) {
        await saveToRtdb(key, data);
      } else if (isFirebaseStorageReady()) {
        const jsonStr = JSON.stringify(data, null, 2);
        const remotePath = `data/${filename}`;
        await uploadToGcs(remotePath, jsonStr);
      }
    } catch (e) {
      console.warn(`[Storage] Debounced upload for ${filename} caught exception:`, e.message);
    }
  }, DEBOUNCE_DELAY_MS);

  cloudDebounceTimers.set(timerKey, timer);
}

// ==========================================
// 8. LOCAL STORAGE & SEEDING HELPERS
// ==========================================
function readJsonFile(filePath, defaultValue) {
  try {
    if (!fs.existsSync(filePath)) return defaultValue;
    const content = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(content);
  } catch (err) {
    console.error(`[Storage] Error reading ${filePath}:`, err.message);
    return defaultValue;
  }
}

function writeJsonFile(filePath, data) {
  try {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
    return true;
  } catch (err) {
    console.error(`[Storage] Error writing ${filePath}:`, err.message);
    return false;
  }
}

function seedFileIfMissing(targetPath, fallbackData) {
  if (fs.existsSync(targetPath)) return;
  const fileName = path.basename(targetPath);
  const seedCandidates = [
    path.join(process.cwd(), 'data', fileName),
    path.join(__dirname, 'data', fileName),
    path.join(__dirname, '..', 'data', fileName)
  ];
  const seedPath = seedCandidates.find(p => fs.existsSync(p));
  if (seedPath) {
    try {
      const dir = path.dirname(targetPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.copyFileSync(seedPath, targetPath);
      return;
    } catch {}
  }
  writeJsonFile(targetPath, fallbackData);
}

// ==========================================
// 9. INITIALIZATION & COLD-START SYNC
// ==========================================
export function initStorage() {
  if (memoryState.isInitialized) return;

  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
  }

  // 1. Seed local files if not present
  seedFileIfMissing(GALLERIES_FILE, []);
  seedFileIfMissing(SETTINGS_FILE, {
    editor_key: DEFAULT_EDITOR_KEY,
    whatsapp: DEFAULT_WA,
    include_octet_stream: false
  });
  seedFileIfMissing(FILES_CACHE_FILE, {});

  // 2. Load into In-Memory State for instant sub-millisecond access
  memoryState.galleries = normalizeArray(readJsonFile(GALLERIES_FILE, []));
  memoryState.settings = readJsonFile(SETTINGS_FILE, {
    editor_key: DEFAULT_EDITOR_KEY,
    whatsapp: DEFAULT_WA,
    include_octet_stream: false
  });
  memoryState.filesCache = readJsonFile(FILES_CACHE_FILE, {});
  memoryState.isInitialized = true;

  // 3. Status Reporting & Cold Start
  if (isRtdbReady()) {
    const cfg = getFirebaseConfig();
    const authType = cfg.hasServiceAccount ? 'Service Account (Private Key)' : (cfg.hasSecret ? 'Database Secret' : 'Public/Test Mode');
    console.log(`[Storage] Firebase Realtime Database is READY (Auth: ${authType}, URL: ${cfg.rtdbUrl})`);
    syncFromCloud().catch(err => {
      console.warn('[Storage] Background RTDB cold-start sync warning:', err.message);
    });
  } else if (isFirebaseStorageReady()) {
    const cfg = getFirebaseConfig();
    console.log(`[Storage] Firebase Cloud Storage is READY (Bucket: ${cfg.bucket})`);
    syncFromCloud().catch(err => {
      console.warn('[Storage] Background GCS cold-start sync warning:', err.message);
    });
  } else {
    console.log(`[Storage] Cloud database not configured. Running in Local Storage (${IS_VERCEL ? '/tmp' : './data'}) Fallback mode.`);
  }
}

// Asynchronously sync from cloud backend at boot time
export async function syncFromCloud() {
  if (!isFirebaseReady()) return false;

  try {
    // --------------------------------------------------
    // Priority 1: Firebase Realtime Database (RTDB)
    // --------------------------------------------------
    if (isRtdbReady()) {
      // 1. Galleries Sync
      const rtdbGalleries = await fetchFromRtdb('galleries');
      if (rtdbGalleries !== null) {
        const parsed = normalizeArray(rtdbGalleries);
        memoryState.galleries = parsed;
        writeJsonFile(GALLERIES_FILE, parsed);
        console.log(`[Storage] Successfully synced ${parsed.length} galleries from Firebase Realtime Database`);
      } else {
        // Cold-start seed to cloud if remote is empty
        if (memoryState.galleries && memoryState.galleries.length > 0) {
          queueCloudSync('galleries.json', memoryState.galleries);
        }
      }

      // 2. Settings Sync
      const rtdbSettings = await fetchFromRtdb('settings');
      if (rtdbSettings !== null && typeof rtdbSettings === 'object') {
        memoryState.settings = { ...(memoryState.settings || {}), ...rtdbSettings };
        writeJsonFile(SETTINGS_FILE, memoryState.settings);
      } else {
        if (memoryState.settings) {
          queueCloudSync('settings.json', memoryState.settings);
        }
      }

      // 3. Files Cache Sync
      const rtdbCache = await fetchFromRtdb('files_cache');
      if (rtdbCache !== null && typeof rtdbCache === 'object') {
        memoryState.filesCache = { ...(memoryState.filesCache || {}), ...rtdbCache };
        writeJsonFile(FILES_CACHE_FILE, memoryState.filesCache);
      }

      return true;
    }

    // --------------------------------------------------
    // Priority 2: Firebase Cloud Storage (GCS)
    // --------------------------------------------------
    if (isFirebaseStorageReady()) {
      // 1. Galleries Sync
      const cloudGalleriesText = await downloadFromGcs('data/galleries.json');
      if (cloudGalleriesText) {
        try {
          const parsed = JSON.parse(cloudGalleriesText);
          if (Array.isArray(parsed)) {
            memoryState.galleries = normalizeArray(parsed);
            writeJsonFile(GALLERIES_FILE, memoryState.galleries);
            console.log(`[Storage] Successfully synced ${memoryState.galleries.length} galleries from Firebase Cloud Storage`);
          }
        } catch (e) {
          console.warn('[Storage] Failed to parse cloud galleries JSON:', e.message);
        }
      } else {
        if (memoryState.galleries && memoryState.galleries.length > 0) {
          queueCloudSync('galleries.json', memoryState.galleries);
        }
      }

      // 2. Settings Sync
      const cloudSettingsText = await downloadFromGcs('data/settings.json');
      if (cloudSettingsText) {
        try {
          const parsed = JSON.parse(cloudSettingsText);
          if (parsed && typeof parsed === 'object') {
            memoryState.settings = parsed;
            writeJsonFile(SETTINGS_FILE, parsed);
          }
        } catch (e) {
          console.warn('[Storage] Failed to parse cloud settings JSON:', e.message);
        }
      } else {
        if (memoryState.settings) {
          queueCloudSync('settings.json', memoryState.settings);
        }
      }

      // 3. Files Cache Sync
      const cloudCacheText = await downloadFromGcs('data/files_cache.json');
      if (cloudCacheText) {
        try {
          const parsed = JSON.parse(cloudCacheText);
          if (parsed && typeof parsed === 'object') {
            memoryState.filesCache = parsed;
            writeJsonFile(FILES_CACHE_FILE, parsed);
          }
        } catch (e) {}
      }

      return true;
    }

    return false;
  } catch (err) {
    console.warn('[Storage] syncFromCloud error:', err.message);
    return false;
  }
}

// ==========================================
// 10. PUBLIC STORAGE METHODS (IN-MEMORY + CLOUD)
// ==========================================
export function getGalleries() {
  if (!memoryState.isInitialized) initStorage();
  return memoryState.galleries || [];
}

export function saveGalleries(galleries) {
  if (!memoryState.isInitialized) initStorage();
  const valid = normalizeArray(galleries);
  memoryState.galleries = valid;

  // 1. Write to local file immediately (< 1 ms response)
  writeJsonFile(GALLERIES_FILE, valid);

  // 2. Queue debounced cloud upload (micro-batching 2s debounce)
  queueCloudSync('galleries.json', valid);

  return true;
}

export function getSettings() {
  if (!memoryState.isInitialized) initStorage();
  const current = memoryState.settings || {};
  return {
    editor_key: (current.editor_key && current.editor_key.trim()) ? current.editor_key.trim() : DEFAULT_EDITOR_KEY,
    whatsapp: (current.whatsapp && current.whatsapp.trim()) ? current.whatsapp.trim() : DEFAULT_WA,
    include_octet_stream: Boolean(current.include_octet_stream)
  };
}

export function saveSettings(settings) {
  if (!memoryState.isInitialized) initStorage();
  const updated = { ...(memoryState.settings || {}), ...settings };
  memoryState.settings = updated;

  writeJsonFile(SETTINGS_FILE, updated);
  queueCloudSync('settings.json', updated);

  return true;
}

export function getFilesCache() {
  if (!memoryState.isInitialized) initStorage();
  return memoryState.filesCache || {};
}

export function saveFilesCache(cache) {
  if (!memoryState.isInitialized) initStorage();
  const valid = (cache && typeof cache === 'object') ? cache : {};
  memoryState.filesCache = valid;

  writeJsonFile(FILES_CACHE_FILE, valid);
  queueCloudSync('files_cache.json', valid);

  return true;
}

// Auto-initialize storage on module load
initStorage();
