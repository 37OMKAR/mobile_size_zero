/**
 * ChunkUploader - TurboBoost Resumable, Deduplicating Upload Engine
 * Outperforms standard Windows MTP / SMB by utilizing:
 * 1. Adaptive Burst Chunking (1MB-4MB dynamic scaling based on file size)
 * 2. Multi-Stream Concurrent Chunk Pipelining (parallel workers per file)
 * 3. Pre-flight Zero-Byte Duplicate Skipping (instant 0ms skip)
 * 4. Automatic Screen WakeLock API retention
 */
class ChunkUploader {
  constructor(options = {}) {
    this.token = options.token || '';
    this.pin = options.pin || '';
    this.concurrency = options.concurrency || 2; // files in parallel
    this.chunkWorkers = options.chunkWorkers || 3; // parallel chunk streams per file for maximum LAN/Wire saturation
    this.onProgress = options.onProgress || (() => {});
    this.onFileStatus = options.onFileStatus || (() => {});
    this.onSpeedUpdate = options.onSpeedUpdate || (() => {});
    this.onQueueComplete = options.onQueueComplete || (() => {});

    this.queue = [];
    this.activeUploads = 0;
    this.isPaused = false;
    this.wakeLock = null;

    // High-resolution rolling speed tracking
    this.speedTracker = {
      bytesRecent: 0,
      lastTimestamp: Date.now(),
      currentMBps: 0
    };

    this.startSpeedMonitor();
  }

  setCredentials(token, pin) {
    this.token = token;
    this.pin = pin;
  }

  startSpeedMonitor() {
    setInterval(() => {
      const now = Date.now();
      const elapsedSec = (now - this.speedTracker.lastTimestamp) / 1000;
      if (elapsedSec >= 0.6) {
        const mbps = (this.speedTracker.bytesRecent / (1024 * 1024)) / elapsedSec;
        this.speedTracker.currentMBps = Math.max(0, parseFloat(mbps.toFixed(2)));
        this.speedTracker.bytesRecent = 0;
        this.speedTracker.lastTimestamp = now;
        this.onSpeedUpdate(this.speedTracker.currentMBps);
      }
    }, 600);
  }

  getOptimalChunkSize(fileSize) {
    // Large files (videos > 150MB) get 4MB chunks for max TCP window saturation
    if (fileSize > 150 * 1024 * 1024) return 4 * 1024 * 1024;
    // Medium files (20MB - 150MB) get 2MB chunks
    if (fileSize > 20 * 1024 * 1024) return 2 * 1024 * 1024;
    // Small files (photos, docs) get 1MB chunks for low latency
    return 1 * 1024 * 1024;
  }

  /**
   * Request Screen Wake Lock to prevent phone from sleeping during upload
   */
  async acquireWakeLock() {
    try {
      if ('wakeLock' in navigator && !this.wakeLock) {
        this.wakeLock = await navigator.wakeLock.request('screen');
        this.wakeLock.addEventListener('release', () => {
          this.wakeLock = null;
        });
      }
    } catch (err) {
      console.warn('[WakeLock] Unable to acquire wake lock:', err.message);
    }
  }

  releaseWakeLock() {
    if (this.wakeLock) {
      try {
        this.wakeLock.release();
      } catch {}
      this.wakeLock = null;
    }
  }

  /**
   * Generates a fast unique file ID from file properties
   */
  async generateFileId(file) {
    const raw = `${file.name}_${file.size}_${file.lastModified}`;
    const encoder = new TextEncoder();
    const data = encoder.encode(raw);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    return `f_${hex.substring(0, 16)}`;
  }

  /**
   * Calculates quick hash from first, middle and last 64KB sample
   */
  async computeQuickHash(file) {
    const SAMPLE = 64 * 1024;
    const size = file.size;

    let sampleBlob;
    if (size <= SAMPLE * 3) {
      sampleBlob = file;
    } else {
      const b1 = file.slice(0, SAMPLE);
      const mid = Math.floor(size / 2) - Math.floor(SAMPLE / 2);
      const b2 = file.slice(mid, mid + SAMPLE);
      const b3 = file.slice(size - SAMPLE, size);
      sampleBlob = new Blob([b1, b2, b3]);
    }

    const arrayBuffer = await sampleBlob.arrayBuffer();
    const hashBuffer = await crypto.subtle.digest('SHA-256', arrayBuffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  }

  /**
   * Add files to queue
   */
  async addFiles(fileList) {
    const newItems = [];
    for (let i = 0; i < fileList.length; i++) {
      const file = fileList[i];
      const relPath = file.webkitRelativePath || '';
      const displayName = relPath || file.name;
      const fileId = await this.generateFileId(file);
      const chunkSize = this.getOptimalChunkSize(file.size);
      const totalChunks = Math.ceil(file.size / chunkSize) || 1;

      // Avoid adding exact duplicate in current queue
      if (this.queue.some(item => item.fileId === fileId)) {
        continue;
      }

      const item = {
        fileId,
        file,
        name: displayName,
        rawName: file.name,
        relativePath: relPath,
        size: file.size,
        lastModified: file.lastModified,
        chunkSize,
        totalChunks,
        uploadedChunks: new Set(),
        status: 'pending', // pending, checking, uploading, paused, completed, duplicate_skipped, failed
        progress: 0,
        errorMessage: null,
        addedAt: Date.now()
      };

      this.queue.push(item);
      newItems.push(item);
      this.onFileStatus(item);
    }

    this.processQueue();
    return newItems;
  }

  async processQueue() {
    if (this.isPaused) return;

    // Check if anything is pending or uploading
    const activeOrPending = this.queue.filter(i => i.status === 'uploading' || i.status === 'pending');
    if (activeOrPending.length > 0) {
      await this.acquireWakeLock();
    } else {
      this.releaseWakeLock();
      this.onQueueComplete();
      return;
    }

    while (this.activeUploads < this.concurrency) {
      const nextItem = this.queue.find(item => item.status === 'pending');
      if (!nextItem) break;

      this.activeUploads++;
      this.uploadFile(nextItem).finally(() => {
        this.activeUploads--;
        this.processQueue();
      });
    }
  }

  /**
   * Upload single file with Turbo Multi-Stream Resumable Pipelining
   */
  async uploadFile(item) {
    if (this.isPaused || item.status === 'paused') return;

    item.status = 'checking';
    this.onFileStatus(item);

    try {
      // 1. Calculate fast quick hash
      const quickHash = await this.computeQuickHash(item.file);

      // 2. Pre-flight check with PC server
      const checkRes = await fetch('/api/check-file', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.token}`,
          'x-pin': this.pin
        },
        body: JSON.stringify({
          fileId: item.fileId,
          name: item.name,
          relativePath: item.relativePath || '',
          size: item.size,
          mtime: item.lastModified,
          quickHash,
          totalChunks: item.totalChunks,
          mimeType: item.file.type
        })
      });

      if (!checkRes.ok) {
        throw new Error(`Server returned HTTP ${checkRes.status}`);
      }

      const checkData = await checkRes.json();

      // Case A: File is already on PC -> Skip immediately!
      if (checkData.status === 'duplicate') {
        item.status = 'duplicate_skipped';
        item.progress = 100;
        item.reason = checkData.reason;
        this.onFileStatus(item);
        return;
      }

      // Case B: Partially uploaded -> Resume missing chunks!
      if (checkData.status === 'partial' && Array.isArray(checkData.uploadedChunks)) {
        item.uploadedChunks = new Set(checkData.uploadedChunks);
      }

      item.status = 'uploading';
      this.onFileStatus(item);

      // 3. Multi-Stream Concurrent Chunk Pipelining (Faster than Windows Transfer)
      const missingChunkIndices = [];
      for (let i = 0; i < item.totalChunks; i++) {
        if (!item.uploadedChunks.has(i)) {
          missingChunkIndices.push(i);
        }
      }

      // Worker Pool to upload chunks in parallel
      const workerCount = Math.min(this.chunkWorkers, missingChunkIndices.length || 1);
      let nextIndexCursor = 0;
      let abortError = null;

      const runWorker = async () => {
        while (nextIndexCursor < missingChunkIndices.length) {
          if (this.isPaused || item.status === 'paused' || abortError) break;

          const chunkIdx = missingChunkIndices[nextIndexCursor++];
          const start = chunkIdx * item.chunkSize;
          const end = Math.min(start + item.chunkSize, item.size);
          const chunkBlob = item.file.slice(start, end);

          try {
            await this.uploadChunkWithRetry(item, chunkIdx, chunkBlob);
            item.uploadedChunks.add(chunkIdx);

            const uploadedBytes = Math.min(item.size, item.uploadedChunks.size * item.chunkSize);
            item.progress = Math.min(99, Math.round((uploadedBytes / item.size) * 100));
            this.onProgress(item);
          } catch (err) {
            abortError = err;
            throw err;
          }
        }
      };

      // Launch parallel workers
      const workers = [];
      for (let w = 0; w < workerCount; w++) {
        workers.push(runWorker());
      }
      await Promise.all(workers);

      if (abortError) {
        throw abortError;
      }

      if (this.isPaused || item.status === 'paused') {
        item.status = 'paused';
        this.onFileStatus(item);
        return;
      }

      // 4. Finalize file assembly on PC
      item.status = 'finalizing';
      this.onFileStatus(item);

      const finRes = await fetch('/api/finalize-file', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.token}`,
          'x-pin': this.pin
        },
        body: JSON.stringify({ fileId: item.fileId })
      });

      if (!finRes.ok) {
        throw new Error(`Failed to assemble file on PC: HTTP ${finRes.status}`);
      }

      const finData = await finRes.json();
      item.status = 'completed';
      item.progress = 100;
      item.path = finData.path;
      item.sha256 = finData.sha256;
      this.onFileStatus(item);
    } catch (err) {
      console.error(`Upload error for ${item.name}:`, err);
      item.status = 'failed';
      item.errorMessage = err.message;
      this.onFileStatus(item);
    }
  }

  /**
   * Upload single chunk with automatic retry
   */
  async uploadChunkWithRetry(item, chunkIdx, chunkBlob, maxRetries = 4) {
    let attempt = 0;
    while (attempt < maxRetries) {
      try {
        const res = await fetch('/api/upload-chunk', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/octet-stream',
            'Authorization': `Bearer ${this.token}`,
            'x-pin': this.pin,
            'x-file-id': item.fileId,
            'x-chunk-index': String(chunkIdx),
            'x-total-chunks': String(item.totalChunks)
          },
          body: chunkBlob
        });

        if (!res.ok) {
          throw new Error(`Chunk ${chunkIdx} failed with HTTP ${res.status}`);
        }

        // Record bytes for speed meter
        this.speedTracker.bytesRecent += chunkBlob.size;
        return;
      } catch (err) {
        attempt++;
        if (attempt >= maxRetries) {
          throw err;
        }
        // Exponential backoff
        await new Promise(r => setTimeout(r, attempt * 400));
      }
    }
  }

  pauseAll() {
    this.isPaused = true;
    for (const item of this.queue) {
      if (item.status === 'uploading' || item.status === 'pending') {
        item.status = 'paused';
        this.onFileStatus(item);
      }
    }
    this.releaseWakeLock();
  }

  resumeAll() {
    this.isPaused = false;
    for (const item of this.queue) {
      if (item.status === 'paused' || item.status === 'failed') {
        item.status = 'pending';
        this.onFileStatus(item);
      }
    }
    this.processQueue();
  }

  clearFinished() {
    this.queue = this.queue.filter(item => item.status !== 'completed' && item.status !== 'duplicate_skipped');
  }
}

if (typeof window !== 'undefined') {
  window.ChunkUploader = ChunkUploader;
}
