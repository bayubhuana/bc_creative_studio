/* studio-zip.js - Direct-to-Client In-Browser Batch Photo Downloader (0% Server RAM) */
(function() {
  window.StudioZip = window.StudioZip || {};

  // Standard CRC32 table for zero-dependency native zip fallback
  let crcTable = null;
  function getCrcTable() {
    if (crcTable) return crcTable;
    crcTable = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) {
        c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      }
      crcTable[i] = c;
    }
    return crcTable;
  }

  function crc32(buf) {
    const table = getCrcTable();
    let crc = 0xffffffff;
    for (let i = 0; i < buf.length; i++) {
      crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  // Format DOS Date/Time for standard zip headers
  function getDosTime(date) {
    const d = date || new Date();
    const time = ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xffff;
    const dt = (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xffff;
    return { time, date: dt };
  }

  // Ultra-fast streaming zero-dependency native ZIP builder (STORE mode, 0 compression)
  async function buildNativeZipBlob(entries, onProgress) {
    const encoder = new TextEncoder();
    const dosTime = getDosTime();
    const localHeaders = [];
    const centralHeaders = [];
    let currentOffset = 0;

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      const nameBytes = encoder.encode(entry.name);
      const dataBytes = new Uint8Array(entry.data);
      const fileCrc = crc32(dataBytes);
      const size = dataBytes.length;

      // Local file header (30 bytes + name length)
      const localHdr = new Uint8Array(30 + nameBytes.length);
      const lv = new DataView(localHdr.buffer);
      lv.setUint32(0, 0x04034b50, true); // Local header signature
      lv.setUint16(4, 20, true);         // Version needed: 2.0
      lv.setUint16(6, 0x0800, true);     // General purpose bit flag: UTF-8 filename
      lv.setUint16(8, 0, true);          // Compression method: 0 (STORE)
      lv.setUint16(10, dosTime.time, true);
      lv.setUint16(12, dosTime.date, true);
      lv.setUint32(14, fileCrc, true);
      lv.setUint32(18, size, true);      // Compressed size
      lv.setUint32(22, size, true);      // Uncompressed size
      lv.setUint16(26, nameBytes.length, true);
      lv.setUint16(28, 0, true);         // Extra field length
      localHdr.set(nameBytes, 30);

      // Central directory header (46 bytes + name length)
      const centralHdr = new Uint8Array(46 + nameBytes.length);
      const cv = new DataView(centralHdr.buffer);
      cv.setUint32(0, 0x02014b50, true); // Central header signature
      cv.setUint16(4, 20, true);         // Version made by
      cv.setUint16(6, 20, true);         // Version needed
      cv.setUint16(8, 0x0800, true);     // Flags: UTF-8
      cv.setUint16(10, 0, true);         // Method: 0 (STORE)
      cv.setUint16(12, dosTime.time, true);
      cv.setUint16(14, dosTime.date, true);
      cv.setUint32(16, fileCrc, true);
      cv.setUint32(20, size, true);
      cv.setUint32(24, size, true);
      cv.setUint16(28, nameBytes.length, true);
      cv.setUint16(30, 0, true);         // Extra length
      cv.setUint16(32, 0, true);         // Comment length
      cv.setUint16(34, 0, true);         // Disk number start
      cv.setUint16(36, 0, true);         // Internal attrs
      cv.setUint32(38, 0, true);         // External attrs
      cv.setUint32(42, currentOffset, true); // Local header offset
      centralHdr.set(nameBytes, 46);

      localHeaders.push(localHdr, dataBytes);
      centralHeaders.push(centralHdr);
      currentOffset += localHdr.length + dataBytes.length;

      if (onProgress) {
        onProgress({ percent: Math.round(((i + 1) / entries.length) * 100) });
      }
    }

    const centralDirOffset = currentOffset;
    let centralDirSize = 0;
    centralHeaders.forEach(h => centralDirSize += h.length);

    // End of central directory record (22 bytes)
    const eocd = new Uint8Array(22);
    const ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054b50, true); // EOCD signature
    ev.setUint16(4, 0, true);          // Disk number
    ev.setUint16(6, 0, true);          // Disk with central dir
    ev.setUint16(8, entries.length, true);  // Entries on this disk
    ev.setUint16(10, entries.length, true); // Total entries
    ev.setUint32(12, centralDirSize, true);  // Central dir size
    ev.setUint32(16, centralDirOffset, true);// Central dir offset
    ev.setUint16(20, 0, true);         // Comment length

    const allParts = [...localHeaders, ...centralHeaders, eocd];
    return new Blob(allParts, { type: 'application/zip' });
  }

  // Get candidate direct CDN URLs for a photo item
  function getDirectCdnUrls(photo) {
    const list = [];
    const pid = String(photo.id || '');
    if (!pid.startsWith('demo')) {
      // Primary: Google Fife CDN full original size with official CORS *
      list.push(`https://lh3.googleusercontent.com/d/${encodeURIComponent(pid)}=s0`);
      // Secondary: Google Drive thumbnail high-res
      list.push(`https://drive.google.com/thumbnail?id=${encodeURIComponent(pid)}&sz=w2500`);
    }
    if (photo.srcLg) list.push(photo.srcLg);
    if (photo.src) list.push(photo.src);
    return list;
  }

  // Clean filename helper
  function sanitizeFilename(name, fallbackIndex) {
    let clean = (name || '').trim().replace(/[\\/:*?"<>|]/g, '_');
    if (!clean) clean = `foto_${String(fallbackIndex + 1).padStart(3, '0')}.jpg`;
    if (!/\.[a-zA-Z0-9]{3,4}$/.test(clean)) clean += '.jpg';
    return clean;
  }

  // Trigger download of a Blob in the browser
  function triggerBlobDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 1000);
  }

  // Format bytes for human readable display
  function formatBytes(bytes) {
    if (!bytes || bytes <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    const val = (bytes / Math.pow(1024, i)).toFixed(1);
    return `${val} ${units[i]}`;
  }

  // ----------------------------------------------------
  // MAIN METHOD: Download All Selected Photos as ZIP
  // ----------------------------------------------------
  async function downloadGalleryZip(options = {}) {
    const {
      title = 'Galeri',
      note = '',
      photos = [],
      onProgress = () => {},
      signal = null,
      concurrency = 3
    } = options;

    if (!photos || !photos.length) {
      throw new Error('Tidak ada foto untuk diunduh.');
    }

    const total = photos.length;
    let completedCount = 0;
    let totalLoadedBytes = 0;
    const downloadedEntries = [];
    const usedNames = new Set();

    // Prepare distinct filenames
    const preparedPhotos = photos.map((p, idx) => {
      let baseName = sanitizeFilename(p.name, idx);
      let finalName = baseName;
      let dup = 1;
      while (usedNames.has(finalName.toLowerCase())) {
        const dotIdx = baseName.lastIndexOf('.');
        const namePart = dotIdx !== -1 ? baseName.slice(0, dotIdx) : baseName;
        const extPart = dotIdx !== -1 ? baseName.slice(dotIdx) : '.jpg';
        finalName = `${namePart} (${dup})${extPart}`;
        dup++;
      }
      usedNames.add(finalName.toLowerCase());
      return {
        ...p,
        cleanName: finalName,
        index: idx
      };
    });

    onProgress({
      phase: 'downloading',
      percent: 0,
      current: 0,
      total,
      loadedBytes: 0,
      currentName: 'Memulai pengunduhan langsung dari Google CDN...'
    });

    // Concurrency worker queue
    let queueIndex = 0;
    async function worker() {
      while (queueIndex < preparedPhotos.length) {
        if (signal && signal.aborted) throw new Error('Pengunduhan dibatalkan oleh pengguna.');
        const item = preparedPhotos[queueIndex++];
        const candidates = getDirectCdnUrls(item);
        let arrayBuffer = null;
        let lastErr = null;

        onProgress({
          phase: 'downloading',
          percent: Math.round((completedCount / total) * 95),
          current: completedCount,
          total,
          loadedBytes: totalLoadedBytes,
          currentName: item.cleanName
        });

        // Try candidate CDN URLs directly to Google
        for (const url of candidates) {
          if (signal && signal.aborted) throw new Error('Pengunduhan dibatalkan oleh pengguna.');
          try {
            const resp = await fetch(url, {
              signal,
              referrerPolicy: 'no-referrer',
              mode: 'cors'
            });
            if (resp.ok) {
              const buf = await resp.arrayBuffer();
              if (buf && buf.byteLength > 100) {
                arrayBuffer = buf;
                totalLoadedBytes += buf.byteLength;
                break;
              }
            }
          } catch (err) {
            lastErr = err;
            if (signal && signal.aborted) throw new Error('Pengunduhan dibatalkan oleh pengguna.');
          }
        }

        if (!arrayBuffer) {
          console.warn(`[StudioZip] Gagal memuat foto ${item.cleanName}:`, lastErr?.message || 'Error CDN');
          // If a photo completely fails to fetch from CDN, create placeholder or skip
          continue;
        }

        downloadedEntries.push({
          name: item.cleanName,
          data: arrayBuffer
        });

        completedCount++;
        onProgress({
          phase: 'downloading',
          percent: Math.round((completedCount / total) * 95),
          current: completedCount,
          total,
          loadedBytes: totalLoadedBytes,
          currentName: item.cleanName
        });
      }
    }

    // Run parallel workers
    const activeWorkers = [];
    const poolSize = Math.max(1, Math.min(concurrency, total));
    for (let w = 0; w < poolSize; w++) {
      activeWorkers.push(worker());
    }
    await Promise.all(activeWorkers);

    if (signal && signal.aborted) throw new Error('Pengunduhan dibatalkan oleh pengguna.');

    if (downloadedEntries.length === 0) {
      throw new Error('Gagal mengunduh foto dari Google Drive CDN. Periksa izin akses folder atau koneksi internet.');
    }

    // Add info_klien.txt manifest inside zip
    const manifestText = [
      '========================================',
      'RINGKASAN PILIHAN FOTO KLIEN',
      '========================================',
      `Galeri        : ${title}`,
      `Tanggal Unduh : ${new Date().toLocaleString('id-ID')}`,
      `Total Berkas  : ${downloadedEntries.length} dari ${total} foto berhasil diunduh`,
      note ? `Catatan Klien : ${note}\n` : '',
      '----------------------------------------',
      'Daftar Berkas Terpilih:',
      ...downloadedEntries.map((e, idx) => `${idx + 1}. ${e.name} (${formatBytes(e.data.byteLength)})`),
      '========================================',
      'Dibuat oleh Studio Photo Picker'
    ].filter(Boolean).join('\n');

    const encoder = new TextEncoder();
    downloadedEntries.push({
      name: 'ringkasan_pilihan.txt',
      data: encoder.encode(manifestText).buffer
    });

    onProgress({
      phase: 'packing',
      percent: 96,
      current: completedCount,
      total,
      loadedBytes: totalLoadedBytes,
      currentName: 'Mengemas berkas ZIP di browser...'
    });

    // Build ZIP: Use JSZip if available in window, otherwise use native builder
    let zipBlob = null;
    if (typeof window.JSZip === 'function') {
      const zip = new window.JSZip();
      downloadedEntries.forEach(entry => {
        zip.file(entry.name, entry.data, { binary: true });
      });
      zipBlob = await zip.generateAsync({
        type: 'blob',
        compression: 'STORE' // Store mode for instant packing and 0 CPU waste
      }, meta => {
        if (onProgress) {
          onProgress({
            phase: 'packing',
            percent: 95 + Math.round((meta.percent / 100) * 5),
            current: completedCount,
            total,
            loadedBytes: totalLoadedBytes,
            currentName: 'Menyelesaikan kompresi ZIP...'
          });
        }
      });
    } else {
      zipBlob = await buildNativeZipBlob(downloadedEntries, meta => {
        if (onProgress) {
          onProgress({
            phase: 'packing',
            percent: 95 + Math.round((meta.percent / 100) * 5),
            current: completedCount,
            total,
            loadedBytes: totalLoadedBytes,
            currentName: 'Menyelesaikan kompresi ZIP...'
          });
        }
      });
    }

    if (signal && signal.aborted) throw new Error('Pengunduhan dibatalkan oleh pengguna.');

    const cleanTitle = (title || 'Galeri').replace(/[^a-zA-Z0-9_\-\s]/g, '').trim().replace(/\s+/g, '_');
    const zipName = `Pilihan_${cleanTitle}.zip`;

    onProgress({
      phase: 'complete',
      percent: 100,
      current: completedCount,
      total,
      loadedBytes: totalLoadedBytes,
      currentName: `Selesai! Mengunduh ${zipName}`
    });

    triggerBlobDownload(zipBlob, zipName);
    return {
      success: true,
      count: downloadedEntries.length - 1, // minus manifest
      totalBytes: totalLoadedBytes,
      zipName
    };
  }

  // ----------------------------------------------------
  // SECONDARY METHOD: Direct Multi-File Downloads
  // ----------------------------------------------------
  async function downloadFilesDirect(options = {}) {
    const {
      photos = [],
      onProgress = () => {},
      signal = null,
      delayMs = 350
    } = options;

    if (!photos || !photos.length) throw new Error('Tidak ada foto untuk diunduh.');

    for (let i = 0; i < photos.length; i++) {
      if (signal && signal.aborted) throw new Error('Pengunduhan dibatalkan.');
      const p = photos[i];
      const filename = sanitizeFilename(p.name, i);
      const url = `https://lh3.googleusercontent.com/d/${encodeURIComponent(p.id)}=d`;

      onProgress({
        phase: 'downloading',
        percent: Math.round(((i + 1) / photos.length) * 100),
        current: i + 1,
        total: photos.length,
        currentName: filename
      });

      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      document.body.appendChild(a);
      a.click();
      setTimeout(() => document.body.removeChild(a), 2000);

      if (i < photos.length - 1) {
        await new Promise(r => setTimeout(r, delayMs));
      }
    }
  }

  window.StudioZip.downloadGalleryZip = downloadGalleryZip;
  window.StudioZip.downloadFilesDirect = downloadFilesDirect;
  window.StudioZip.formatBytes = formatBytes;
})();
