const path = require('path');
const fs = require('fs');

class FileOrganizer {
  constructor(options = {}) {
    this.storageDir = options.storageDir || path.join(__dirname, '..', 'transferred_files');
    this.autoOrganize = options.autoOrganize !== false;
  }

  static EXTENSIONS = {
    Photos: new Set(['jpg', 'jpeg', 'png', 'heic', 'heif', 'webp', 'gif', 'bmp', 'tiff', 'tif', 'raw', 'cr2', 'nef', 'arw', 'dng', 'svg']),
    Videos: new Set(['mp4', 'mov', 'avi', 'mkv', 'webm', '3gp', 'm4v', 'flv', 'wmv', 'ts', 'mts']),
    Audio: new Set(['mp3', 'wav', 'aac', 'flac', 'm4a', 'ogg', 'wma', 'aiff', 'opus']),
    Documents: new Set(['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'csv', 'rtf', 'odt', 'ods', 'odp', 'zip', 'rar', '7z', 'tar', 'gz', 'json', 'xml'])
  };

  /**
   * Cleans filename of path traversal and illegal Windows characters.
   * If allowRelativePath is true, preserves directory subfolders while stripping traversal dots.
   */
  sanitizeFilename(rawName, allowRelativePath = false) {
    if (!rawName) return 'unnamed_file';
    
    if (allowRelativePath && (rawName.includes('/') || rawName.includes('\\'))) {
      const parts = rawName.split(/[/\\]+/).filter(p => p && p !== '.' && p !== '..');
      const cleanParts = parts.map(p => {
        let clean = p.replace(/[\\/:*?"<>|]+/g, '_');
        clean = clean.replace(/[\x00-\x1f\x80-\x9f]/g, '');
        clean = clean.replace(/^[.\s]+|[.\s]+$/g, '');
        return clean || 'sub';
      });
      return cleanParts.join(path.sep) || 'file';
    }

    // Get basename first to remove any directory paths
    let clean = path.basename(rawName);
    // Remove or replace illegal Windows chars: \ / : * ? " < > |
    clean = clean.replace(/[\\/:*?"<>|]+/g, '_');
    // Replace non-printable ASCII
    clean = clean.replace(/[\x00-\x1f\x80-\x9f]/g, '');
    // Trim leading/trailing dots and spaces
    clean = clean.replace(/^[.\s]+|[.\s]+$/g, '');
    return clean || 'file';
  }

  /**
   * Determine category based on file extension
   */
  getCategory(filename) {
    const ext = path.extname(filename).toLowerCase().replace('.', '');
    for (const [category, extSet] of Object.entries(FileOrganizer.EXTENSIONS)) {
      if (extSet.has(ext)) {
        return category;
      }
    }
    return 'Others';
  }

  /**
   * Generate destination path with date-based organization and collision avoidance
   */
  determineDestinationPath(fileMeta) {
    // If a folder hierarchy was provided, preserve folder structure
    const relPath = fileMeta.relativePath || (fileMeta.name && (fileMeta.name.includes('/') || fileMeta.name.includes('\\')) ? fileMeta.name : null);
    
    if (relPath) {
      const sanitizedRel = this.sanitizeFilename(relPath, true);
      const targetDir = path.join(this.storageDir, path.dirname(sanitizedRel));
      if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true });
      }
      return this.getNonCollidingPath(targetDir, path.basename(sanitizedRel));
    }

    const cleanName = this.sanitizeFilename(fileMeta.name);
    let targetDir = this.storageDir;

    if (this.autoOrganize) {
      const category = this.getCategory(cleanName);
      
      // Determine Year-Month folder from mtime or current date
      let date = new Date();
      if (fileMeta.mtime) {
        const parsed = new Date(Number(fileMeta.mtime));
        if (!isNaN(parsed.getTime()) && parsed.getFullYear() > 1990 && parsed.getFullYear() < 2100) {
          date = parsed;
        }
      }
      const year = date.getFullYear();
      const month = String(date.getMonth() + 1).padStart(2, '0');
      const yearMonth = `${year}-${month}`;

      if (category === 'Photos' || category === 'Videos') {
        targetDir = path.join(this.storageDir, category, yearMonth);
      } else {
        targetDir = path.join(this.storageDir, category);
      }
    }

    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }

    return this.getNonCollidingPath(targetDir, cleanName);
  }

  getNonCollidingPath(dir, filename) {
    let fullPath = path.join(dir, filename);
    if (!fs.existsSync(fullPath)) {
      return fullPath;
    }

    const ext = path.extname(filename);
    const base = path.basename(filename, ext);
    let counter = 1;

    while (fs.existsSync(fullPath)) {
      fullPath = path.join(dir, `${base}_${counter}${ext}`);
      counter++;
    }

    return fullPath;
  }
}

module.exports = FileOrganizer;
