const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class ChunkManager {
  constructor(options = {}) {
    this.chunksDir = options.chunksDir || path.join(__dirname, '..', '.chunks');
    if (!fs.existsSync(this.chunksDir)) {
      fs.mkdirSync(this.chunksDir, { recursive: true });
    }
  }

  getUploadDir(fileId) {
    // Sanitize fileId to prevent path traversal
    const safeFileId = String(fileId).replace(/[^a-zA-Z0-9_-]/g, '');
    return path.join(this.chunksDir, safeFileId);
  }

  getMetaPath(fileId) {
    return path.join(this.getUploadDir(fileId), 'meta.json');
  }

  async initUpload(fileMeta) {
    const uploadDir = this.getUploadDir(fileMeta.fileId);
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }

    const metaPath = this.getMetaPath(fileMeta.fileId);
    const meta = {
      fileId: fileMeta.fileId,
      name: fileMeta.name,
      totalSize: Number(fileMeta.totalSize),
      totalChunks: Number(fileMeta.totalChunks),
      mtime: fileMeta.mtime || Date.now(),
      mimeType: fileMeta.mimeType || 'application/octet-stream',
      createdAt: Date.now()
    };

    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf8');
    return meta;
  }

  async getUploadStatus(fileId) {
    const uploadDir = this.getUploadDir(fileId);
    if (!fs.existsSync(uploadDir)) {
      return { exists: false, uploadedChunks: [], bytesReceived: 0, isComplete: false };
    }

    const metaPath = this.getMetaPath(fileId);
    if (!fs.existsSync(metaPath)) {
      return { exists: false, uploadedChunks: [], bytesReceived: 0, isComplete: false };
    }

    let meta;
    try {
      meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    } catch {
      return { exists: false, uploadedChunks: [], bytesReceived: 0, isComplete: false };
    }

    const files = fs.readdirSync(uploadDir);
    const uploadedChunks = [];
    let bytesReceived = 0;

    for (const f of files) {
      const match = f.match(/^chunk_(\d+)\.part$/);
      if (match) {
        const index = parseInt(match[1], 10);
        uploadedChunks.push(index);
        try {
          const stat = fs.statSync(path.join(uploadDir, f));
          bytesReceived += stat.size;
        } catch {}
      }
    }

    uploadedChunks.sort((a, b) => a - b);
    const isComplete = meta.totalChunks > 0 && uploadedChunks.length === meta.totalChunks;

    return {
      exists: true,
      meta,
      totalChunks: meta.totalChunks,
      uploadedChunks,
      bytesReceived,
      isComplete
    };
  }

  async saveChunk(fileId, chunkIndex, buffer) {
    const uploadDir = this.getUploadDir(fileId);
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }

    const finalPath = path.join(uploadDir, `chunk_${chunkIndex}.part`);
    const tempPath = path.join(uploadDir, `chunk_${chunkIndex}.tmp`);

    // Write to temp file then rename for atomic write
    fs.writeFileSync(tempPath, buffer);
    fs.renameSync(tempPath, finalPath);

    return { success: true, chunkIndex, size: buffer.length };
  }

  async assembleFile(fileId, destinationPath) {
    const uploadDir = this.getUploadDir(fileId);
    const status = await this.getUploadStatus(fileId);

    if (!status.exists || !status.meta) {
      throw new Error(`Upload session not found for fileId: ${fileId}`);
    }

    const { totalChunks, totalSize } = status.meta;
    if (status.uploadedChunks.length !== totalChunks) {
      throw new Error(`Cannot assemble: missing chunks (${status.uploadedChunks.length}/${totalChunks})`);
    }

    // Ensure destination directory exists
    const destDir = path.dirname(destinationPath);
    if (!fs.existsSync(destDir)) {
      fs.mkdirSync(destDir, { recursive: true });
    }

    const writeStream = fs.createWriteStream(destinationPath);
    const hash = crypto.createHash('sha256');

    return new Promise((resolve, reject) => {
      let currentChunk = 0;

      const appendNextChunk = () => {
        if (currentChunk >= totalChunks) {
          writeStream.end();
          return;
        }

        const chunkPath = path.join(uploadDir, `chunk_${currentChunk}.part`);
        if (!fs.existsSync(chunkPath)) {
          writeStream.destroy();
          reject(new Error(`Missing chunk file: ${chunkPath}`));
          return;
        }

        const readStream = fs.createReadStream(chunkPath);
        readStream.on('data', chunk => {
          hash.update(chunk);
          writeStream.write(chunk);
        });

        readStream.on('end', () => {
          currentChunk++;
          appendNextChunk();
        });

        readStream.on('error', err => {
          writeStream.destroy();
          reject(err);
        });
      };

      writeStream.on('finish', () => {
        try {
          const sha256 = hash.digest('hex');
          const finalStat = fs.statSync(destinationPath);

          // Clean up chunk files and metadata
          fs.rmSync(uploadDir, { recursive: true, force: true });

          resolve({
            size: finalStat.size,
            sha256,
            path: destinationPath
          });
        } catch (err) {
          reject(err);
        }
      });

      writeStream.on('error', err => {
        reject(err);
      });

      // Start streaming chunks
      appendNextChunk();
    });
  }

  async cancelUpload(fileId) {
    const uploadDir = this.getUploadDir(fileId);
    if (fs.existsSync(uploadDir)) {
      fs.rmSync(uploadDir, { recursive: true, force: true });
    }
  }

  /**
   * Cleanup abandoned uploads older than maxAgeMs (default 24 hours)
   */
  async cleanupOldUploads(maxAgeMs = 24 * 60 * 60 * 1000) {
    if (!fs.existsSync(this.chunksDir)) return 0;
    const now = Date.now();
    let cleaned = 0;

    const dirs = fs.readdirSync(this.chunksDir);
    for (const dir of dirs) {
      const fullPath = path.join(this.chunksDir, dir);
      try {
        const stat = fs.statSync(fullPath);
        if (stat.isDirectory() && now - stat.mtimeMs > maxAgeMs) {
          fs.rmSync(fullPath, { recursive: true, force: true });
          cleaned++;
        }
      } catch {}
    }
    return cleaned;
  }
}

module.exports = ChunkManager;
