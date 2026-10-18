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

  const app = express();
  const server = http.createServer(app);

  // Speed Boost: Turbo Socket tuning (TCP_NODELAY disables Nagle's delay algorithm)
  server.on('connection', (socket) => {
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 5000);
  });

  const wss = new WebSocket.Server({ server });

  // WebSocket Clients Tracker
  const clients = new Set();

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

  // Raw body parser for binary chunk uploads
  app.use('/api/upload-chunk', express.raw({
    limit: '20mb',
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
        disk,
        catalogStats,
        connectedClients: clients.size
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
      const { fileId, name, size, mtime, quickHash, sha256, totalChunks, mimeType } = req.body;

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
        mimeType
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

  return { app, server, config, deduplicator, chunkManager, fileOrganizer, wss };
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
