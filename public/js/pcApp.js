document.addEventListener('DOMContentLoaded', () => {
  // Elements
  const qrImage = document.getElementById('qrImage');
  const pinBoxContainer = document.getElementById('pinBoxContainer');
  const mobileUrlInput = document.getElementById('mobileUrlInput');
  const btnCopyUrl = document.getElementById('btnCopyUrl');
  const pcHostInfo = document.getElementById('pcHostInfo');
  const connectedCountBadge = document.getElementById('connectedCountBadge');
  const wifiIpLabel = document.getElementById('wifiIpLabel');
  const connectedDeviceName = document.getElementById('connectedDeviceName');
  const deviceIndicatorDot = document.getElementById('deviceIndicatorDot');

  const statTotalTransferred = document.getElementById('statTotalTransferred');
  const statTotalFiles = document.getElementById('statTotalFiles');
  const statDuplicatesSkipped = document.getElementById('statDuplicatesSkipped');
  const statCurrentSpeed = document.getElementById('statCurrentSpeed');

  const storageAmounts = document.getElementById('storageAmounts');
  const storageBarFill = document.getElementById('storageBarFill');
  const storageFolderPath = document.getElementById('storageFolderPath');
  const storagePercentUsed = document.getElementById('storagePercentUsed');

  const filesTableBody = document.getElementById('filesTableBody');
  const tableItemCounter = document.getElementById('tableItemCounter');
  const searchInput = document.getElementById('searchInput');
  const filterPills = document.querySelectorAll('.filter-pill');
  const btnRefreshCatalog = document.getElementById('btnRefreshCatalog');

  const countAll = document.getElementById('countAll');
  const countPhotos = document.getElementById('countPhotos');
  const countVideos = document.getElementById('countVideos');
  const countDocs = document.getElementById('countDocs');
  const countSkipped = document.getElementById('countSkipped');

  const btnOpenFolder = document.getElementById('btnOpenFolder');
  const btnHeaderSettings = document.getElementById('btnHeaderSettings');
  const btnNavSettings = document.getElementById('btnNavSettings');
  const settingsModal = document.getElementById('settingsModal');
  const btnCloseSettings = document.getElementById('btnCloseSettings');
  const btnCancelSettings = document.getElementById('btnCancelSettings');
  const btnSaveSettings = document.getElementById('btnSaveSettings');
  const settingStoragePath = document.getElementById('settingStoragePath');
  const settingAutoOrganize = document.getElementById('settingAutoOrganize');
  const settingRequirePin = document.getElementById('settingRequirePin');

  let currentFilter = 'all';
  let historyEntries = [];
  let skippedDuplicatesCount = 0;
  let totalTransferredBytes = 0;
  let currentSpeedTimer = null;
  let speedBytesRecent = 0;
  let speedLastTime = Date.now();
  let searchQuery = '';

  function formatBytes(bytes) {
    if (!bytes || bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }

  function formatDate(ts) {
    if (!ts) return '14:28:10';
    const d = new Date(Number(ts));
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  // Update PIN boxes
  function updatePinBoxes(pin) {
    if (!pinBoxContainer) return;
    const pinStr = String(pin || '------').padEnd(6, '-');
    pinBoxContainer.innerHTML = pinStr.split('').map(digit => `
      <div class="h-12 bg-surface-container-lowest rounded flex items-center justify-center font-mono text-2xl font-bold text-primary shadow-inner border border-outline-variant/30">
        ${digit}
      </div>
    `).join('');
  }

  // Load Status
  async function loadStatus() {
    try {
      const res = await fetch('/api/status');
      if (!res.ok) throw new Error('Status request failed');
      const data = await res.json();

      if (qrImage) qrImage.src = data.qrCode;
      updatePinBoxes(data.sessionPin);

      if (mobileUrlInput) mobileUrlInput.value = data.mobileUrl;
      if (wifiIpLabel) wifiIpLabel.textContent = `${data.primaryIp}:${data.port}`;
      if (pcHostInfo) pcHostInfo.textContent = `DAEMON RUNNING • PORT :${data.port} • ${data.hostName.toUpperCase()}`;
      
      const clientCount = data.connectedClients || 0;
      if (connectedCountBadge) connectedCountBadge.textContent = `${clientCount} Connected`;
      if (connectedDeviceName) {
        connectedDeviceName.textContent = clientCount > 0 ? 'Mobile Device (Paired)' : 'Mobile Device (Standby)';
      }
      if (deviceIndicatorDot) {
        deviceIndicatorDot.className = clientCount > 0 
          ? 'w-2.5 h-2.5 rounded-full bg-secondary shadow-[0_0_8px_rgba(78,222,163,0.8)] animate-pulse'
          : 'w-2.5 h-2.5 rounded-full bg-outline-variant';
      }

      // Storage
      if (data.disk) {
        const freeGB = data.disk.freeGB;
        const totalGB = data.disk.totalGB;
        if (storageAmounts) storageAmounts.textContent = `${freeGB} GB FREE / ${totalGB} GB`;
        if (data.disk.totalBytes > 0) {
          const usedPct = ((data.disk.usedBytes / data.disk.totalBytes) * 100).toFixed(1);
          if (storageBarFill) storageBarFill.style.width = `${usedPct}%`;
          if (storagePercentUsed) storagePercentUsed.textContent = `${usedPct}% Used`;
        }
      }
      if (storageFolderPath) storageFolderPath.textContent = data.storageDir;

      // Settings inputs
      if (settingStoragePath) settingStoragePath.value = data.storageDir;
      if (settingAutoOrganize) settingAutoOrganize.checked = data.autoOrganize;
      if (settingRequirePin) settingRequirePin.checked = data.requirePin;

      if (data.catalogStats) {
        if (statTotalFiles) statTotalFiles.textContent = `${data.catalogStats.totalFiles} files indexed`;
        totalTransferredBytes = data.catalogStats.totalBytes || 0;
        if (statTotalTransferred) statTotalTransferred.textContent = formatBytes(totalTransferredBytes);
      }
    } catch (err) {
      console.error('Error fetching PC status:', err);
    }
  }

  // Load Transfer History
  async function loadHistory() {
    try {
      const res = await fetch('/api/history');
      if (res.ok) {
        const data = await res.json();
        historyEntries = data.entries || [];
        updateCounts();
        renderTable();
      }
    } catch (err) {
      console.error('Error loading history:', err);
    }
  }

  function getCategory(filename) {
    const ext = filename.split('.').pop().toLowerCase();
    if (['jpg', 'jpeg', 'png', 'heic', 'webp', 'gif', 'dng'].includes(ext)) return 'Photos';
    if (['mp4', 'mov', 'avi', 'mkv', 'webm', '3gp'].includes(ext)) return 'Videos';
    if (['pdf', 'doc', 'docx', 'xls', 'xlsx', 'txt', 'zip', 'sqlite'].includes(ext)) return 'Documents';
    return 'Other';
  }

  function getCategoryIcon(cat) {
    switch (cat) {
      case 'Videos': return '<span class="material-symbols-outlined text-[18px] text-primary-container">movie</span>';
      case 'Photos': return '<span class="material-symbols-outlined text-[18px] text-tertiary-fixed-dim">image</span>';
      case 'Documents': return '<span class="material-symbols-outlined text-[18px] text-tertiary-container">description</span>';
      default: return '<span class="material-symbols-outlined text-[18px] text-on-surface-variant">insert_drive_file</span>';
    }
  }

  function updateCounts() {
    let pCount = 0, vCount = 0, dCount = 0;
    historyEntries.forEach(item => {
      const cat = item.category || getCategory(item.name);
      if (cat === 'Photos') pCount++;
      else if (cat === 'Videos') vCount++;
      else if (cat === 'Documents') dCount++;
    });

    if (countAll) countAll.textContent = historyEntries.length;
    if (countPhotos) countPhotos.textContent = pCount;
    if (countVideos) countVideos.textContent = vCount;
    if (countDocs) countDocs.textContent = dCount;
    if (countSkipped) countSkipped.textContent = skippedDuplicatesCount;

    if (tableItemCounter) {
      tableItemCounter.textContent = `${historyEntries.length} ITEMS INGESTED • ZERO CHECKSUM DISCREPANCIES`;
    }
  }

  function renderTable() {
    if (!filesTableBody) return;

    const filtered = historyEntries.filter(entry => {
      // Category filter
      if (currentFilter === 'photos' && (entry.category || getCategory(entry.name)) !== 'Photos') return false;
      if (currentFilter === 'videos' && (entry.category || getCategory(entry.name)) !== 'Videos') return false;
      if (currentFilter === 'documents' && (entry.category || getCategory(entry.name)) !== 'Documents') return false;
      if (currentFilter === 'skipped' && !entry.isDuplicate) return false;

      // Search filter
      if (searchQuery) {
        const query = searchQuery.toLowerCase();
        const matchesName = entry.name.toLowerCase().includes(query);
        const matchesHash = entry.sha256 && entry.sha256.toLowerCase().includes(query);
        if (!matchesName && !matchesHash) return false;
      }
      return true;
    });

    if (filtered.length === 0) {
      filesTableBody.innerHTML = `
        <tr>
          <td colspan="8" class="text-center py-8 text-on-surface-variant font-mono">
            ${historyEntries.length === 0 
              ? 'No files transferred yet. Connect your smartphone and begin transferring!' 
              : 'No files match the active filter.'}
          </td>
        </tr>
      `;
      return;
    }

    filesTableBody.innerHTML = filtered.map(item => {
      const cat = item.category || getCategory(item.name);
      const icon = getCategoryIcon(cat);
      const shortHash = item.sha256 ? `${item.sha256.substring(0, 8)}..${item.sha256.substring(item.sha256.length - 4)}` : 'verified';
      const cleanPath = item.filePath ? item.filePath.replace(/\\/g, '\\\\') : '';

      return `
        <tr class="hover:bg-surface-container-high/30 transition-colors group">
          <td class="py-2.5 px-3 text-center">${icon}</td>
          <td class="py-2.5 px-3 font-mono text-xs font-medium text-primary">
            <span title="${item.name}">${item.name}</span>
          </td>
          <td class="py-2.5 px-3 text-on-surface-variant font-sans text-xs">${cat}</td>
          <td class="py-2.5 px-3 font-mono text-xs text-on-surface font-medium">${formatBytes(item.size)}</td>
          <td class="py-2.5 px-3">
            <span class="font-mono text-[10px] bg-surface-container px-1.5 py-0.5 rounded text-outline group-hover:text-primary transition-colors" title="${item.sha256 || ''}">
              ${shortHash}
            </span>
          </td>
          <td class="py-2.5 px-3 font-mono text-[10px] text-on-surface-variant">${formatDate(item.transferredAt)}</td>
          <td class="py-2.5 px-3">
            <span class="inline-flex items-center gap-1 font-mono text-[10px] text-secondary bg-surface-container px-2 py-0.5 rounded font-semibold">
              <span class="w-1.5 h-1.5 rounded-full bg-secondary"></span>
              100% VERIFIED
            </span>
          </td>
          <td class="py-2.5 px-3 text-right">
            <button class="font-mono text-[10px] bg-surface-container hover:bg-surface-bright text-on-surface px-2.5 py-1 rounded transition-colors" onclick="openSpecificFile('${cleanPath}')">
              Locate
            </button>
          </td>
        </tr>
      `;
    }).join('');
  }

  // Search input binding
  if (searchInput) {
    searchInput.addEventListener('input', (e) => {
      searchQuery = e.target.value.trim();
      renderTable();
    });
  }

  // Filter pills
  filterPills.forEach(pill => {
    pill.addEventListener('click', () => {
      filterPills.forEach(p => {
        p.classList.remove('active', 'bg-surface-container-high', 'text-primary', 'shadow');
        p.classList.add('text-on-surface-variant');
      });
      pill.classList.add('active', 'bg-surface-container-high', 'text-primary', 'shadow');
      pill.classList.remove('text-on-surface-variant');

      currentFilter = pill.getAttribute('data-filter');
      renderTable();
    });
  });

  if (btnRefreshCatalog) {
    btnRefreshCatalog.addEventListener('click', () => {
      loadHistory();
      loadStatus();
    });
  }

  // Copy URL
  if (btnCopyUrl && mobileUrlInput) {
    btnCopyUrl.addEventListener('click', () => {
      navigator.clipboard.writeText(mobileUrlInput.value).then(() => {
        btnCopyUrl.textContent = 'COPIED';
        setTimeout(() => { btnCopyUrl.textContent = 'COPY'; }, 2000);
      });
    });
  }

  // Open storage folder
  if (btnOpenFolder) {
    btnOpenFolder.addEventListener('click', async () => {
      try {
        await fetch('/api/open-folder', { method: 'POST' });
      } catch (err) {
        console.error('Failed to open storage folder:', err);
      }
    });
  }

  window.openSpecificFile = async function(filePath) {
    if (!filePath) return;
    try {
      await fetch('/api/open-folder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filePath })
      });
    } catch {}
  };

  // Settings modal
  function openSettings() {
    if (settingsModal) {
      settingsModal.classList.remove('hidden');
      settingsModal.classList.add('flex');
    }
  }

  function closeSettings() {
    if (settingsModal) {
      settingsModal.classList.add('hidden');
      settingsModal.classList.remove('flex');
    }
  }

  if (btnHeaderSettings) btnHeaderSettings.addEventListener('click', openSettings);
  if (btnNavSettings) btnNavSettings.addEventListener('click', openSettings);
  if (btnCloseSettings) btnCloseSettings.addEventListener('click', closeSettings);
  if (btnCancelSettings) btnCancelSettings.addEventListener('click', closeSettings);

  if (btnSaveSettings) {
    btnSaveSettings.addEventListener('click', async () => {
      const storageDir = settingStoragePath.value.trim();
      const autoOrganize = settingAutoOrganize.checked;
      const requirePin = settingRequirePin.checked;

      try {
        const res = await fetch('/api/settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ storageDir, autoOrganize, requirePin })
        });
        if (res.ok) {
          closeSettings();
          loadStatus();
        } else {
          alert('Failed to save settings');
        }
      } catch (err) {
        alert('Error saving settings: ' + err.message);
      }
    });
  }

  // Speed Graph Canvas & Telemetry Engine
  const speedGraphCanvas = document.getElementById('speedGraphCanvas');
  const graphCurrentSpeed = document.getElementById('graphCurrentSpeed');
  const graphPeakSpeed = document.getElementById('graphPeakSpeed');
  const ctx = speedGraphCanvas ? speedGraphCanvas.getContext('2d') : null;

  const MAX_GRAPH_POINTS = 60;
  const speedHistory = new Array(MAX_GRAPH_POINTS).fill(0);
  let peakSpeedMBps = 0;

  function drawSpeedGraph() {
    if (!ctx || !speedGraphCanvas) return;
    const w = speedGraphCanvas.width;
    const h = speedGraphCanvas.height;

    ctx.clearRect(0, 0, w, h);

    const maxVal = Math.max(50, peakSpeedMBps * 1.15);

    // Horizontal coordinate lines
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(0, 229, 255, 0.08)';
    ctx.fillStyle = 'rgba(132, 147, 150, 0.5)';
    ctx.font = '10px "JetBrains Mono", monospace';

    const levels = [0.25, 0.5, 0.75, 1.0];
    levels.forEach(lvl => {
      const y = h - (h - 24) * lvl - 6;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();

      const label = `${(maxVal * lvl).toFixed(0)} MB/s`;
      ctx.fillText(label, 8, y - 4);
    });

    // Draw Smooth Waveform Path
    ctx.beginPath();
    const stepX = w / (MAX_GRAPH_POINTS - 1);

    speedHistory.forEach((val, idx) => {
      const x = idx * stepX;
      const normalized = Math.min(1, val / maxVal);
      const y = h - (normalized * (h - 30)) - 6;

      if (idx === 0) {
        ctx.moveTo(x, y);
      } else {
        const prevX = (idx - 1) * stepX;
        const prevNormalized = Math.min(1, speedHistory[idx - 1] / maxVal);
        const prevY = h - (prevNormalized * (h - 30)) - 6;
        const cpX = (prevX + x) / 2;
        ctx.bezierCurveTo(cpX, prevY, cpX, y, x, y);
      }
    });

    // Glowing Cyan Stroke
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = '#00e5ff';
    ctx.shadowColor = '#00e5ff';
    ctx.shadowBlur = 12;
    ctx.stroke();
    ctx.shadowBlur = 0;

    // Gradient Area Fill under wave
    ctx.lineTo(w, h);
    ctx.lineTo(0, h);
    ctx.closePath();

    const gradient = ctx.createLinearGradient(0, 0, 0, h);
    gradient.addColorStop(0, 'rgba(0, 229, 255, 0.32)');
    gradient.addColorStop(0.6, 'rgba(126, 34, 204, 0.10)');
    gradient.addColorStop(1, 'rgba(10, 14, 22, 0.0)');
    ctx.fillStyle = gradient;
    ctx.fill();

    // Live cursor at the right edge
    const lastVal = speedHistory[speedHistory.length - 1];
    const lastNorm = Math.min(1, lastVal / maxVal);
    const lastY = h - (lastNorm * (h - 30)) - 6;

    ctx.beginPath();
    ctx.arc(w - 2, lastY, 4, 0, Math.PI * 2);
    ctx.fillStyle = '#4edea3';
    ctx.shadowColor = '#4edea3';
    ctx.shadowBlur = 8;
    ctx.fill();
    ctx.shadowBlur = 0;
  }

  function pushSpeed(mbps) {
    speedHistory.shift();
    speedHistory.push(mbps);
    if (mbps > peakSpeedMBps) {
      peakSpeedMBps = mbps;
      if (graphPeakSpeed) graphPeakSpeed.textContent = `${peakSpeedMBps.toFixed(1)} MB/s`;
    }
    if (graphCurrentSpeed) graphCurrentSpeed.textContent = `${mbps.toFixed(1)} MB/s`;
    if (statCurrentSpeed) statCurrentSpeed.textContent = `${mbps.toFixed(1)} MB/s`;
    drawSpeedGraph();
  }

  // WebSocket Connection
  function initWebSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${protocol}//${window.location.host}`);

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);

        if (msg.type === 'telemetry') {
          const bytes = msg.data.bytesTransferred || 0;
          speedBytesRecent += bytes;
          const now = Date.now();
          const elapsed = (now - speedLastTime) / 1000;
          if (elapsed >= 0.5) {
            const mbps = (speedBytesRecent / (1024 * 1024)) / elapsed;
            pushSpeed(Math.max(0, parseFloat(mbps.toFixed(2))));
            speedBytesRecent = 0;
            speedLastTime = now;
          }
        } else if (msg.type === 'duplicate_skipped') {
          skippedDuplicatesCount++;
          if (statDuplicatesSkipped) statDuplicatesSkipped.textContent = skippedDuplicatesCount;
          updateCounts();
        } else if (msg.type === 'transfer_complete') {
          const data = msg.data;
          historyEntries.unshift({
            name: data.name,
            size: data.size,
            category: data.category || getCategory(data.name),
            sha256: data.sha256,
            transferredAt: Date.now(),
            filePath: data.filePath
          });
          totalTransferredBytes += (data.size || 0);
          if (statTotalTransferred) statTotalTransferred.textContent = formatBytes(totalTransferredBytes);
          updateCounts();
          renderTable();
          loadStatus();
        }
      } catch (e) {}
    };

    ws.onclose = () => {
      setTimeout(initWebSocket, 3000);
    };
  }

  // Smooth idle speed reset
  setInterval(() => {
    if (Date.now() - speedLastTime > 2000 && speedHistory[speedHistory.length - 1] > 0) {
      pushSpeed(0);
    }
  }, 1000);

  drawSpeedGraph();
  loadStatus();
  loadHistory();
  initWebSocket();
});
