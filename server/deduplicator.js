const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class Deduplicator {
  constructor(options = {}) {
    this.catalogFile = options.catalogFile || path.join(__dirname, '..', '.transfer-catalog.json');
    this.storageDir = options.storageDir || path.join(__dirname, '..', 'transferred_files');
    this.entries = []; // Array of catalog items
    this.metaMap = new Map(); // "name|size|mtime" -> entry
    this.sha256Map = new Map(); // "size|sha256" -> entry
    this.quickHashMap = new Map(); // "size|quickHash" -> entry
  }

  async init() {
    this.loadCatalog();
  }

  loadCatalog() {
    try {
      if (fs.existsSync(this.catalogFile)) {
        const raw = fs.readFileSync(this.catalogFile, 'utf8');
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          this.entries = parsed;
          this.rebuildIndices();
        }
      }
    } catch (err) {
      console.warn('[Deduplicator] Warning: Could not read catalog file, starting fresh:', err.message);
      this.entries = [];
    }
  }

  rebuildIndices() {
    this.metaMap.clear();
    this.sha256Map.clear();
    this.quickHashMap.clear();

    for (const entry of this.entries) {
      const metaKey = this.getMetaKey(entry.name, entry.size, entry.mtime);
      this.metaMap.set(metaKey, entry);

      if (entry.sha256) {
        this.sha256Map.set(`${entry.size}|${entry.sha256}`, entry);
      }
      if (entry.quickHash) {
        this.quickHashMap.set(`${entry.size}|${entry.quickHash}`, entry);
      }
    }
  }

  getMetaKey(name, size, mtime) {
    // Normalize mtime to nearest second to avoid millisecond discrepancies between mobile & PC OS
    const mtimeSec = mtime ? Math.round(Number(mtime) / 1000) : 0;
    return `${name.toLowerCase()}|${size}|${mtimeSec}`;
  }

  saveCatalog() {
    try {
      const dir = path.dirname(this.catalogFile);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const tmpPath = `${this.catalogFile}.tmp`;
      fs.writeFileSync(tmpPath, JSON.stringify(this.entries, null, 2), 'utf8');
      fs.renameSync(tmpPath, this.catalogFile);
    } catch (err) {
      console.error('[Deduplicator] Error saving catalog:', err.message);
    }
  }

  /**
   * Fast check before upload starts.
   * Mobile client provides { name, size, mtime, quickHash?, sha256? }
   */
  async checkDuplicate(fileMeta) {
    const { name, size, mtime, quickHash, sha256 } = fileMeta;

    // 1. Check exact metadata match (name + size + mtime)
    if (name && size !== undefined && mtime !== undefined) {
      const metaKey = this.getMetaKey(name, size, mtime);
      const existing = this.metaMap.get(metaKey);
      if (existing && this.fileExists(existing.filePath)) {
        return {
          isDuplicate: true,
          reason: 'exact_metadata',
          existingPath: existing.filePath,
          entry: existing
        };
      }
    }

    // 2. Check by full SHA-256 hash if client supplied it
    if (sha256 && size !== undefined) {
      const existing = this.sha256Map.get(`${size}|${sha256}`);
      if (existing && this.fileExists(existing.filePath)) {
        return {
          isDuplicate: true,
          reason: 'content_hash',
          existingPath: existing.filePath,
          entry: existing
        };
      }
    }

    // 3. Check by QuickHash if client supplied it
    if (quickHash && size !== undefined) {
      const existing = this.quickHashMap.get(`${size}|${quickHash}`);
      if (existing && this.fileExists(existing.filePath)) {
        return {
          isDuplicate: true,
          reason: 'quick_hash',
          existingPath: existing.filePath,
          entry: existing
        };
      }
    }

    return { isDuplicate: false };
  }

  fileExists(filePath) {
    if (!filePath) return false;
    try {
      return fs.existsSync(filePath);
    } catch {
      return false;
    }
  }

  /**
   * Calculate Quick Hash from a physical file on disk.
   * Samples first 64KB, middle 64KB, and last 64KB for instantaneous calculation.
   */
  async computeQuickHash(filePath, size) {
    const SAMPLE_SIZE = 64 * 1024;
    const hash = crypto.createHash('md5');

    if (size <= SAMPLE_SIZE * 3) {
      const data = fs.readFileSync(filePath);
      hash.update(data);
      return hash.digest('hex');
    }

    const fd = fs.openSync(filePath, 'r');
    try {
      const buffer = Buffer.alloc(SAMPLE_SIZE);

      // 1. First 64KB
      fs.readSync(fd, buffer, 0, SAMPLE_SIZE, 0);
      hash.update(buffer);

      // 2. Middle 64KB
      const midPos = Math.floor(size / 2) - Math.floor(SAMPLE_SIZE / 2);
      fs.readSync(fd, buffer, 0, SAMPLE_SIZE, midPos);
      hash.update(buffer);

      // 3. Last 64KB
      const endPos = size - SAMPLE_SIZE;
      fs.readSync(fd, buffer, 0, SAMPLE_SIZE, endPos);
      hash.update(buffer);

      return hash.digest('hex');
    } finally {
      fs.closeSync(fd);
    }
  }

  /**
   * Calculate full SHA-256 stream hash
   */
  async computeFullSha256(filePath) {
    return new Promise((resolve, reject) => {
      const hash = crypto.createHash('sha256');
      const stream = fs.createReadStream(filePath);
      stream.on('data', chunk => hash.update(chunk));
      stream.on('end', () => resolve(hash.digest('hex')));
      stream.on('error', err => reject(err));
    });
  }

  /**
   * Register completed file into the catalog
   */
  async registerFile(params) {
    const { name, size, mtime, filePath, sha256: providedSha, quickHash: providedQuick } = params;

    const quickHash = providedQuick || (await this.computeQuickHash(filePath, size));
    const sha256 = providedSha || (await this.computeFullSha256(filePath));

    const entry = {
      id: crypto.randomBytes(8).toString('hex'),
      name,
      size,
      mtime: mtime || Date.now(),
      filePath,
      quickHash,
      sha256,
      transferredAt: Date.now()
    };

    // Remove old entry with same path or metaKey if exists
    const metaKey = this.getMetaKey(name, size, entry.mtime);
    this.entries = this.entries.filter(e => e.filePath !== filePath);
    this.entries.push(entry);

    this.metaMap.set(metaKey, entry);
    this.sha256Map.set(`${size}|${sha256}`, entry);
    this.quickHashMap.set(`${size}|${quickHash}`, entry);

    this.saveCatalog();
    return entry;
  }

  /**
   * Scan an existing directory to index all files into the catalog
   */
  async scanAndIndexDirectory(dirPath) {
    if (!fs.existsSync(dirPath)) return 0;

    let indexedCount = 0;
    const walk = async (currentDir) => {
      const items = fs.readdirSync(currentDir, { withFileTypes: true });
      for (const item of items) {
        const fullPath = path.join(currentDir, item.name);
        if (item.isDirectory()) {
          // Skip temp chunk directory or hidden dirs
          if (!item.name.startsWith('.')) {
            await walk(fullPath);
          }
        } else if (item.isFile()) {
          // Skip temporary/catalog files
          if (item.name.startsWith('.') || item.name.endsWith('.tmp')) continue;

          const stat = fs.statSync(fullPath);
          const metaKey = this.getMetaKey(item.name, stat.size, stat.mtimeMs);

          // If not in catalog, index it
          if (!this.metaMap.has(metaKey)) {
            try {
              const quickHash = await this.computeQuickHash(fullPath, stat.size);
              const sha256 = await this.computeFullSha256(fullPath);
              const entry = {
                id: crypto.randomBytes(8).toString('hex'),
                name: item.name,
                size: stat.size,
                mtime: stat.mtimeMs,
                filePath: fullPath,
                quickHash,
                sha256,
                transferredAt: stat.ctimeMs
              };
              this.entries.push(entry);
              this.metaMap.set(metaKey, entry);
              this.sha256Map.set(`${stat.size}|${sha256}`, entry);
              this.quickHashMap.set(`${stat.size}|${quickHash}`, entry);
              indexedCount++;
            } catch (scanErr) {
              console.warn('[Deduplicator] Could not index file:', fullPath, scanErr.message);
            }
          }
        }
      }
    };

    await walk(dirPath);
    if (indexedCount > 0) {
      this.saveCatalog();
    }
    return indexedCount;
  }

  getStats() {
    return {
      totalFiles: this.entries.length,
      totalBytes: this.entries.reduce((sum, e) => sum + (e.size || 0), 0)
    };
  }
}

module.exports = Deduplicator;
