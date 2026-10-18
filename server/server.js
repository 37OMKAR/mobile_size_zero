const http = require('http');
const path = require('path');
const fs = require('fs');
const express = require('express');
const cors = require('cors');
const WebSocket = require('ws');
const QRCode = require('qrcode');
const { exec } = require('child_process');

const defaultConfig = require('./config');
const Deduplicator = require('./deduplicator');
const ChunkManager = require('./chunkManager');
const FileOrganizer = require('./fileOrganizer');
const WireTransferEngine = require('./wireTransferEngine');

async function createAppAndServer(customConfig = {}) {
  const config = { ...defaultConfig, ...customConfig };
  
  // Initialize storage directories
  if (!fs.existsSync(config.STORAGE_DIR)) {
    fs.mkdirSync(config.STORAGE_DIR, { recursive: true });
  }
  if (!fs.existsSync(config.CHUNKS_DIR)) {
    fs.mkdirSync(config.CHUNKS_DIR, { recursive: true });
  }

  // Initialize Core Engines
  const deduplicator = new Deduplicator({
    catalogFile: config.CATALOG_FILE,
    storageDir: config.STORAGE_DIR
  });
  await deduplicator.init();

  // Index any existing files in storage directory
  await deduplicator.scanAndIndexDirectory(config.STORAGE_DIR);

  const chunkManager = new ChunkManager({
    chunksDir: config.CHUNKS_DIR
  });

  const fileOrganizer = new FileOrganizer({
    storageDir: config.STORAGE_DIR,
    autoOrganize: config.AUTO_ORGANIZE
  });

  const wireEngine = new WireTransferEngine();

  const app = express();
  const server = http.createServer(app);

  // Speed Boost: Turbo Socket tuning (TCP_NODELAY disables Nagle's delay algorithm)
  server.on('connection', (socket) => {
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 5000);
  });

  const wss = new WebSocket.Server({ server });

  // WebSocket Clients & Device Trackers
  const clients = new Set();
  const connectedDevices = new Map();
  const outboxItems = new Map();

  function broadcast(event, data) {
    const payload = JSON.stringify({ event, data, timestamp: Date.now() });
    for (const ws of clients) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(payload);
      }
    }
  }

  wss.on('connection', (ws, req) => {
    clients.add(ws);
    broadcast('clients_count', { count: clients.size });

    ws.on('close', () => {
      clients.delete(ws);
      broadcast('clients_count', { count: clients.size });
    });

    ws.on('message', (message) => {
      try {
        const parsed = JSON.parse(message);
        if (parsed.type === 'ping') {
          ws.send(JSON.stringify({ type: 'pong' }));
        }
      } catch {}
    });
  });

  // Middleware
  app.use(cors());
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true }));

  // Raw body parser for binary chunk uploads & PC-to-mobile transfers
  app.use('/api/upload-chunk', express.raw({
    limit: '50mb',
    type: 'application/octet-stream'
  }));
  app.use('/api/send-to-mobile', express.raw({
    limit: '200mb',
    type: 'application/octet-stream'
  }));

  // Auth Middleware
  function isAuthorized(req) {
    const clientIp = req.socket.remoteAddress;
    // Local PC is always authorized
    if (clientIp === '127.0.0.1' || clientIp === '::1' || clientIp === '::ffff:127.0.0.1') {
      return true;
    }

    if (!config.REQUIRE_PIN) return true;

    // Check query token
    if (req.query && req.query.token === config.SESSION_TOKEN) {
      return true;
    }

    // Check authorization header
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.substring(7);
      if (token === config.SESSION_TOKEN) return true;
    }

    // Check custom PIN header
    if (req.headers['x-pin'] === config.SESSION_PIN) {
      return true;
    }

    return false;
  }

  function requireAuth(req, res, next) {
    if (isAuthorized(req)) {
      return next();
    }
    return res.status(401).json({ error: 'Unauthorized: PIN or valid token required' });
  }

  // Get Disk Space Free
  function getDiskStats() {
    try {
      if (fs.statfsSync) {
        const stats = fs.statfsSync(config.STORAGE_DIR);
        const freeBytes = stats.bavail * stats.bsize;
        const totalBytes = stats.blocks * stats.bsize;
        return {
          freeBytes,
          totalBytes,
          usedBytes: totalBytes - freeBytes,
          freeGB: (freeBytes / (1024 ** 3)).toFixed(2),
          totalGB: (totalBytes / (1024 ** 3)).toFixed(2)
        };
      }
    } catch (e) {
      console.warn('statfs error:', e.message);
    }
    return { freeBytes: 0, totalBytes: 0, freeGB: 'Unknown', totalGB: 'Unknown' };
  }

  // Generate QR Code URL
  async function generateQrData(primaryAddress) {
    const host = primaryAddress || 'localhost';
    const mobileUrl = `http://${host}:${config.PORT}/mobile.html?token=${config.SESSION_TOKEN}&pin=${config.SESSION_PIN}`;
    const qrCodeDataUrl = await QRCode.toDataURL(mobileUrl, {
      width: 280,
      margin: 2,
      color: { dark: '#0f172a', light: '#ffffff' }
    });
    return { mobileUrl, qrCodeDataUrl };
  }

  // Static files
  app.use(express.static(path.join(__dirname, '..', 'public')));

  // --- REST API ENDPOINTS ---

  // 1. GET /api/status - Get PC server status, LAN addresses, QR code, disk space
  app.get('/api/status', async (req, res) => {
    try {
      const lanAddresses = config.getLanAddresses ? config.getLanAddresses() : [];
      const primaryIp = lanAddresses.length > 0 ? lanAddresses[0].address : 'localhost';
      const { mobileUrl, qrCodeDataUrl } = await generateQrData(primaryIp);
      const disk = getDiskStats();
      const catalogStats = deduplicator.getStats();

      const memUsage = process.memoryUsage();
      const bufferRamMB = Math.round(memUsage.rss / (1024 * 1024));
      const totalRamGB = (require('os').totalmem() / (1024 ** 3)).toFixed(1);

      res.json({
        hostName: require('os').hostname(),
        port: config.PORT,
        lanAddresses,
        primaryIp,
        mobileUrl,
        qrCode: qrCodeDataUrl,
        sessionPin: config.SESSION_PIN,
        sessionToken: config.SESSION_TOKEN,
        requirePin: config.REQUIRE_PIN,
        autoOrganize: config.AUTO_ORGANIZE,
        storageDir: config.STORAGE_DIR,
        bufferRamMB,
        totalRamGB,
        disk,
        catalogStats,
        connectedClients: clients.size,
        connectedDevices: Array.from(connectedDevices.values())
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // 2. POST /api/auth/verify - Verify PIN or Token
  app.post('/api/auth/verify', (req, res) => {
    const { pin, token } = req.body;
    if (token === config.SESSION_TOKEN || pin === config.SESSION_PIN) {
      return res.json({
        success: true,
        token: config.SESSION_TOKEN,
        message: 'Authenticated successfully'
      });
    }
    return res.status(401).json({ success: false, error: 'Invalid PIN or Token' });
  });

  // 3. POST /api/check-file - Pre-flight duplicate check & resumable upload state
  app.post('/api/check-file', requireAuth, async (req, res) => {
    try {
      const { fileId, name, size, mtime, quickHash, sha256, totalChunks, mimeType, relativePath } = req.body;

      if (!fileId || !name || size === undefined) {
        return res.status(400).json({ error: 'fileId, name, and size are required' });
      }

      // Check for duplicate in catalog
      const dupCheck = await deduplicator.checkDuplicate({
        name,
        size: Number(size),
        mtime,
        quickHash,
        sha256
      });

      if (dupCheck.isDuplicate) {
        broadcast('duplicate_skipped', {
          fileId,
          name,
          size,
          reason: dupCheck.reason,
          existingPath: dupCheck.existingPath
        });

        return res.json({
          status: 'duplicate',
          reason: dupCheck.reason,
          existingPath: dupCheck.existingPath,
          message: 'File already exists on PC, skipped instantly.'
        });
      }

      // Check if partially uploaded
      const uploadStatus = await chunkManager.getUploadStatus(fileId);
      if (uploadStatus.exists) {
        return res.json({
          status: 'partial',
          uploadedChunks: uploadStatus.uploadedChunks,
          totalChunks: uploadStatus.totalChunks,
          bytesReceived: uploadStatus.bytesReceived,
          isComplete: uploadStatus.isComplete
        });
      }

      // Initialize new upload session
      await chunkManager.initUpload({
        fileId,
        name,
        totalSize: size,
        totalChunks: totalChunks || 1,
        mtime,
        mimeType,
        relativePath
      });

      res.json({
        status: 'new',
        uploadedChunks: [],
        totalChunks: totalChunks || 1
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // 4. POST /api/upload-chunk - Stream a binary slice
  app.post('/api/upload-chunk', requireAuth, async (req, res) => {
    try {
      const fileId = req.headers['x-file-id'];
      const chunkIndex = parseInt(req.headers['x-chunk-index'], 10);
      const totalChunks = parseInt(req.headers['x-total-chunks'], 10);
      const buffer = req.body;

      if (!fileId || isNaN(chunkIndex) || !Buffer.isBuffer(buffer)) {
        return res.status(400).json({ error: 'Missing or invalid chunk headers or binary body' });
      }

      await chunkManager.saveChunk(fileId, chunkIndex, buffer);

      // Broadcast progress event
      broadcast('transfer_progress', {
        fileId,
        chunkIndex,
        totalChunks,
        chunkSize: buffer.length
      });

      res.json({ success: true, chunkIndex, size: buffer.length });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // 5. POST /api/finalize-file - Assemble chunks, verify SHA-256, deduplicate & organize
  app.post('/api/finalize-file', requireAuth, async (req, res) => {
    try {
      const { fileId } = req.body;
      if (!fileId) {
        return res.status(400).json({ error: 'fileId is required' });
      }

      const status = await chunkManager.getUploadStatus(fileId);
      if (!status.exists || !status.meta) {
        return res.status(404).json({ error: 'Upload session not found' });
      }

      const meta = status.meta;
      const destinationPath = fileOrganizer.determineDestinationPath(meta);

      // Stitch chunks together and compute SHA-256
      const result = await chunkManager.assembleFile(fileId, destinationPath);

      // Register with Deduplicator catalog
      const registered = await deduplicator.registerFile({
        name: meta.name,
        size: result.size,
        mtime: meta.mtime,
        filePath: result.path,
        sha256: result.sha256
      });

      const category = fileOrganizer.getCategory(meta.name);

      // Broadcast completion event to PC dashboard
      broadcast('file_completed', {
        fileId,
        name: meta.name,
        size: result.size,
        path: result.path,
        category,
        sha256: result.sha256,
        transferredAt: Date.now()
      });

      res.json({
        success: true,
        name: meta.name,
        size: result.size,
        path: result.path,
        category,
        sha256: result.sha256
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // 6. POST /api/cancel-upload - Cancel and cleanup chunk directory
  app.post('/api/cancel-upload', requireAuth, async (req, res) => {
    try {
      const { fileId } = req.body;
      if (fileId) {
        await chunkManager.cancelUpload(fileId);
      }
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // 7. GET /api/history - Retrieve transfer history & catalog entries
  app.get('/api/history', requireAuth, (req, res) => {
    res.json({
      entries: deduplicator.entries.slice(-200).reverse(), // latest 200 files
      stats: deduplicator.getStats()
    });
  });

  // 8. POST /api/settings - Update config settings from PC dashboard
  app.post('/api/settings', requireAuth, async (req, res) => {
    const { storageDir, autoOrganize, requirePin } = req.body;

    if (storageDir && typeof storageDir === 'string') {
      config.STORAGE_DIR = path.resolve(storageDir);
      fileOrganizer.storageDir = config.STORAGE_DIR;
      deduplicator.storageDir = config.STORAGE_DIR;
      if (!fs.existsSync(config.STORAGE_DIR)) {
        fs.mkdirSync(config.STORAGE_DIR, { recursive: true });
      }
      await deduplicator.scanAndIndexDirectory(config.STORAGE_DIR);
    }

    if (autoOrganize !== undefined) {
      config.AUTO_ORGANIZE = Boolean(autoOrganize);
      fileOrganizer.autoOrganize = config.AUTO_ORGANIZE;
    }

    if (requirePin !== undefined) {
      config.REQUIRE_PIN = Boolean(requirePin);
    }

    broadcast('settings_updated', {
      storageDir: config.STORAGE_DIR,
      autoOrganize: config.AUTO_ORGANIZE,
      requirePin: config.REQUIRE_PIN
    });

    res.json({
      success: true,
      storageDir: config.STORAGE_DIR,
      autoOrganize: config.AUTO_ORGANIZE,
      requirePin: config.REQUIRE_PIN
    });
  });

  // 9. POST /api/open-folder - Open destination folder in Windows Explorer
  app.post('/api/open-folder', requireAuth, (req, res) => {
    const target = req.body.folderPath || config.STORAGE_DIR;
    if (process.platform === 'win32') {
      exec(`explorer.exe "${target}"`, (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true, opened: target });
      });
    } else {
      res.json({ success: true, message: 'Open folder supported on Windows' });
    }
  });

  // 10. POST /api/browse-folder - Native Windows Folder Selector Dialog
  app.post('/api/browse-folder', requireAuth, (req, res) => {
    if (process.platform === 'win32') {
      const psCmd = `powershell -NoProfile -Command "Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.FolderBrowserDialog; $d.Description = 'Select PC Storage Destination Folder for Mobile Transfers'; $d.ShowNewFolderButton = $true; if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $d.SelectedPath }"`;
      exec(psCmd, async (err, stdout) => {
        const selected = (stdout || '').trim();
        if (selected && fs.existsSync(selected)) {
          config.STORAGE_DIR = path.resolve(selected);
          fileOrganizer.storageDir = config.STORAGE_DIR;
          deduplicator.storageDir = config.STORAGE_DIR;
          await deduplicator.scanAndIndexDirectory(config.STORAGE_DIR);
          broadcast('settings_updated', { storageDir: config.STORAGE_DIR });
          return res.json({ success: true, storageDir: config.STORAGE_DIR });
        }
        return res.json({ success: false, message: 'No folder selected or cancelled' });
      });
    } else {
      res.json({ success: false, message: 'Native folder browser supported on Windows' });
    }
  });

  // 11. POST /api/register-device - Track connected mobile devices
  app.post('/api/register-device', (req, res) => {
    const { deviceId, deviceName, platform, browser, isWire } = req.body || {};
    const rawIp = req.socket.remoteAddress || req.ip || '127.0.0.1';
    const cleanIp = rawIp.replace(/^.*:/, '');
    const id = deviceId || 'dev_' + cleanIp.replace(/\./g, '_');

    const dev = {
      id,
      name: deviceName || (platform ? `${platform} Device` : 'Mobile Device'),
      ip: cleanIp,
      platform: platform || 'Mobile',
      browser: browser || 'Mobile Browser',
      isWire: Boolean(isWire),
      connectedAt: Date.now(),
      lastSeen: Date.now()
    };
    connectedDevices.set(id, dev);

    broadcast('device_registered', dev);
    broadcast('devices_updated', { devices: Array.from(connectedDevices.values()) });
    res.json({ success: true, device: dev });
  });

  // 12. GET /api/devices - List all active mobile devices
  app.get('/api/devices', (req, res) => {
    res.json({ devices: Array.from(connectedDevices.values()) });
  });

  // 13. POST /api/send-to-mobile - Send file from PC to connected mobile
  app.post('/api/send-to-mobile', requireAuth, (req, res) => {
    try {
      const rawName = req.headers['x-filename'] || 'file_' + Date.now();
      const filename = decodeURIComponent(rawName);
      const fileId = 'outbox_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6);
      const outboxDir = path.join(config.STORAGE_DIR, '.outbox');
      if (!fs.existsSync(outboxDir)) {
        fs.mkdirSync(outboxDir, { recursive: true });
      }

      const filePath = path.join(outboxDir, `${fileId}_${path.basename(filename)}`);
      fs.writeFileSync(filePath, req.body);
      const size = Buffer.isBuffer(req.body) ? req.body.length : 0;

      const item = {
        id: fileId,
        name: path.basename(filename),
        size,
        path: filePath,
        timestamp: Date.now(),
        downloadUrl: `/api/download-file/${fileId}`
      };
      outboxItems.set(fileId, item);

      broadcast('incoming_file_from_pc', item);
      res.json({ success: true, item });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // 14. GET /api/download-file/:fileId - Download file sent from PC
  app.get('/api/download-file/:fileId', (req, res) => {
    const item = outboxItems.get(req.params.fileId);
    if (!item || !fs.existsSync(item.path)) {
      return res.status(404).send('File not found in outbox');
    }
    res.download(item.path, item.name);
  });

  // 15. GET /api/mobile-downloads - List all files available for phone to download
  app.get('/api/mobile-downloads', (req, res) => {
    res.json({ items: Array.from(outboxItems.values()) });
  });

  // --- DIRECT HIGH-SPEED USB-C / WIRE TRANSFER ENDPOINTS ---

  // 16. POST /api/wire/browse - Browse mobile drive or folder on PC
  app.post('/api/wire/browse', requireAuth, async (req, res) => {
    try {
      const result = await wireEngine.browseMobileFolder('Select Connected Mobile Drive or Folder (USB-C Wire)');
      res.json(result);
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // 17. POST /api/wire/scan - Recursively scan mobile directory
  app.post('/api/wire/scan', requireAuth, async (req, res) => {
    try {
      const { sourceDir } = req.body;
      if (!sourceDir || !fs.existsSync(sourceDir)) {
        return res.status(400).json({ error: 'Valid source directory is required' });
      }

      const files = await wireEngine.scanDirectory(sourceDir);
      const totalBytes = files.reduce((acc, f) => acc + f.size, 0);

      let videoBytes = 0;
      let photoBytes = 0;
      let docBytes = 0;

      files.forEach(f => {
        const cat = fileOrganizer.getCategory(f.name);
        if (cat === 'Videos') videoBytes += f.size;
        else if (cat === 'Photos') photoBytes += f.size;
        else docBytes += f.size;
      });

      res.json({
        success: true,
        sourceDir,
        totalFiles: files.length,
        totalBytes,
        videoBytes,
        photoBytes,
        docBytes,
        files: files.slice(0, 500) // preview up to 500
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // 18. POST /api/wire/start - Start high-speed wire transfer batch
  app.post('/api/wire/start', requireAuth, async (req, res) => {
    try {
      const { sourceDir } = req.body;
      if (!sourceDir || !fs.existsSync(sourceDir)) {
        return res.status(400).json({ error: 'Valid source directory is required' });
      }

      // Run async transfer in background and report completion via WebSocket
      wireEngine.startBatchTransfer({
        sourceDir,
        destinationDir: config.STORAGE_DIR,
        deduplicator,
        fileOrganizer,
        broadcast
      }).then(summary => {
        console.log(`[WireTransfer] Batch finished: ${summary.completedCount} transferred, ${summary.duplicateCount} duplicates skipped.`);
      }).catch(err => {
        console.error('[WireTransfer] Batch failed:', err.message);
        broadcast('wire_batch_error', { error: err.message });
      });

      res.json({ success: true, message: 'Wire transfer batch started' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // 19. POST /api/wire/cancel - Cancel active wire transfer
  app.post('/api/wire/cancel', requireAuth, (req, res) => {
    wireEngine.cancelTransfer();
    broadcast('wire_batch_cancelled', {});
    res.json({ success: true, message: 'Wire transfer cancelled' });
  });

  // 20. POST /api/wire/pause - Pause active wire transfer
  app.post('/api/wire/pause', requireAuth, (req, res) => {
    wireEngine.pauseTransfer();
    res.json({ success: true, message: 'Wire transfer paused' });
  });

  // 21. POST /api/wire/resume - Resume active wire transfer
  app.post('/api/wire/resume', requireAuth, (req, res) => {
    wireEngine.resumeTransfer();
    res.json({ success: true, message: 'Wire transfer resumed' });
  });

  return { app, server, config, deduplicator, chunkManager, fileOrganizer, wireEngine, wss };
}

// Direct execution entrypoint
if (require.main === module) {
  createAppAndServer().then(({ server, config }) => {
    server.listen(config.PORT, config.HOST, () => {
      const addresses = config.getLanAddresses ? config.getLanAddresses() : [];
      console.log('\n======================================================');
      console.log('  🚀 AirTransfer - Secure Mobile to PC File Transfer');
      console.log('======================================================');
      console.log(`  🖥️  PC Web Dashboard: http://localhost:${config.PORT}/pc.html`);
      console.log(`  🔑 Session PIN:       ${config.SESSION_PIN}`);
      if (addresses.length > 0) {
        console.log('  📱 Mobile LAN Connect:');
        addresses.forEach(addr => {
          console.log(`     • ${addr.type} (${addr.interface}): http://${addr.address}:${config.PORT}/mobile.html?token=${config.SESSION_TOKEN}&pin=${config.SESSION_PIN}`);
        });
      }
      console.log(`  📂 Storage Folder:    ${config.STORAGE_DIR}`);
      console.log('======================================================\n');
    });
  }).catch(err => {
    console.error('Failed to start AirTransfer server:', err);
    process.exit(1);
  });
}

module.exports = { createAppAndServer };
