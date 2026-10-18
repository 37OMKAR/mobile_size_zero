document.addEventListener('DOMContentLoaded', () => {
  // Elements
  const qrImage = document.getElementById('qrImage');
  const pinCodeDisplay = document.getElementById('pinCodeDisplay');
  const mobileUrlInput = document.getElementById('mobileUrlInput');
  const btnCopyUrl = document.getElementById('btnCopyUrl');
  const pcHostInfo = document.getElementById('pcHostInfo');
  const connectedCountBadge = document.getElementById('connectedCountBadge');

  const statTotalTransferred = document.getElementById('statTotalTransferred');
  const statTotalFiles = document.getElementById('statTotalFiles');
  const statDuplicatesSkipped = document.getElementById('statDuplicatesSkipped');
  const statCurrentSpeed = document.getElementById('statCurrentSpeed');

  const storageAmounts = document.getElementById('storageAmounts');
  const storageBarFill = document.getElementById('storageBarFill');
  const storageFolderPath = document.getElementById('storageFolderPath');
  const storagePercentUsed = document.getElementById('storagePercentUsed');

  const filesTableBody = document.getElementById('filesTableBody');
  const filterPills = document.querySelectorAll('.filter-pill');

  const btnOpenFolder = document.getElementById('btnOpenFolder');
  const navSettings = document.getElementById('navSettings');
  const settingsModal = document.getElementById('settingsModal');
  const btnCloseSettings = document.getElementById('btnCloseSettings');
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

  function formatBytes(bytes) {
    if (!bytes || bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }

  function formatDate(ts) {
    if (!ts) return 'Just now';
    const d = new Date(Number(ts));
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + ' ' + d.toLocaleDateString();
  }

  // Load Status
  async function loadStatus() {
    try {
      const res = await fetch('/api/status');
      if (!res.ok) throw new Error('Status request failed');
      const data = await res.json();

      qrImage.src = data.qrCode;
      pinCodeDisplay.textContent = data.sessionPin;
      mobileUrlInput.value = data.mobileUrl;
      pcHostInfo.textContent = `PC Host: ${data.hostName} • Local IP: ${data.primaryIp}:${data.port}`;
      connectedCountBadge.textContent = `${data.connectedClients || 0} Connected`;

      // Storage
      if (data.disk) {
        const freeGB = data.disk.freeGB;
        const totalGB = data.disk.totalGB;
        storageAmounts.textContent = `${freeGB} GB free of ${totalGB} GB`;
        if (data.disk.totalBytes > 0) {
          const usedPct = ((data.disk.usedBytes / data.disk.totalBytes) * 100).toFixed(1);
          storageBarFill.style.width = `${usedPct}%`;
          storagePercentUsed.textContent = `${usedPct}% Used`;
        }
      }
      storageFolderPath.textContent = `Destination: ${data.storageDir}`;

      // Settings inputs
      settingStoragePath.value = data.storageDir;
      settingAutoOrganize.checked = data.autoOrganize;
      settingRequirePin.checked = data.requirePin;

      if (data.catalogStats) {
        statTotalFiles.textContent = `${data.catalogStats.totalFiles} files indexed`;
        totalTransferredBytes = data.catalogStats.totalBytes || 0;
        statTotalTransferred.textContent = formatBytes(totalTransferredBytes);
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
        renderTable();
      }
    } catch (err) {
      console.error('Error loading history:', err);
    }
  }

  function getCategory(filename) {
    const ext = filename.split('.').pop().toLowerCase();
    if (['jpg', 'jpeg', 'png', 'heic', 'webp', 'gif'].includes(ext)) return 'Photos';
    if (['mp4', 'mov', 'avi', 'mkv', 'webm'].includes(ext)) return 'Videos';
    if (['pdf', 'doc', 'docx', 'xls', 'xlsx', 'txt', 'zip'].includes(ext)) return 'Documents';
    return 'Others';
  }

  function renderTable() {
    const filtered = historyEntries.filter(entry => {
      if (currentFilter === 'all') return true;
      const cat = entry.category || getCategory(entry.name);
      return cat.toLowerCase() === currentFilter.toLowerCase();
    });

    if (filtered.length === 0) {
      filesTableBody.innerHTML = `
        <tr>
          <td colspan="6" style="text-align: center; color: var(--text-dim); padding: 30px;">
            ${historyEntries.length === 0 ? 'No files transferred yet. Connect your phone and send files!' : 'No files in this category.'}
          </td>
        </tr>
      `;
      return;
    }

    filesTableBody.innerHTML = filtered.map(item => {
      const cat = item.category || getCategory(item.name);
      let badgeClass = 'badge-photo';
      if (cat === 'Videos') badgeClass = 'badge-video';
      else if (cat === 'Documents') badgeClass = 'badge-doc';

      const shortHash = item.sha256 ? `${item.sha256.substring(0, 8)}...${item.sha256.substring(item.sha256.length - 6)}` : 'Verified';

      return `
        <tr>
          <td>
            <div class="file-row-name">
              <div class="row-icon">
                <svg width="18" height="18" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                </svg>
              </div>
              <span title="${item.name}">${item.name}</span>
            </div>
          </td>
          <td><span class="badge-tag ${badgeClass}">${cat}</span></td>
          <td>${formatBytes(item.size)}</td>
          <td><code style="font-size: 0.78rem; opacity: 0.8;" title="${item.sha256 || ''}">${shortHash}</code></td>
          <td style="color: var(--text-muted); font-size: 0.82rem;">${formatDate(item.transferredAt)}</td>
          <td>
            <button class="filter-pill" style="padding: 4px 10px; font-size: 0.75rem;" onclick="openSpecificFile('${item.filePath ? item.filePath.replace(/\\/g, '\\\\') : ''}')">
              Locate
            </button>
          </td>
        </tr>
      `;
    }).join('');
  }

  window.openSpecificFile = (filePath) => {
    if (!filePath) return;
    fetch('/api/open-folder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folderPath: filePath })
    });
  };

  // Filter pills
  filterPills.forEach(pill => {
    pill.addEventListener('click', () => {
      filterPills.forEach(p => p.classList.remove('active'));
      pill.classList.add('active');
      currentFilter = pill.dataset.filter;
      renderTable();
    });
  });

  // Copy URL
  btnCopyUrl.addEventListener('click', () => {
    mobileUrlInput.select();
    navigator.clipboard.writeText(mobileUrlInput.value);
    btnCopyUrl.textContent = 'Copied!';
    setTimeout(() => { btnCopyUrl.textContent = 'Copy'; }, 2000);
  });

  // Open Storage Folder
  btnOpenFolder.addEventListener('click', () => {
    fetch('/api/open-folder', { method: 'POST' });
  });

  // Settings
  navSettings.addEventListener('click', () => {
    settingsModal.style.display = 'flex';
  });
  btnCloseSettings.addEventListener('click', () => {
    settingsModal.style.display = 'none';
  });

  btnSaveSettings.addEventListener('click', async () => {
    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          storageDir: settingStoragePath.value.trim(),
          autoOrganize: settingAutoOrganize.checked,
          requirePin: settingRequirePin.checked
        })
      });
      if (res.ok) {
        settingsModal.style.display = 'none';
        loadStatus();
      }
    } catch (err) {
      alert('Failed to save settings: ' + err.message);
    }
  });

  // WebSocket Live Updates
  function initWebSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}`;
    const ws = new WebSocket(wsUrl);

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        const { event: evt, data } = msg;

        if (evt === 'clients_count') {
          connectedCountBadge.textContent = `${data.count} Connected`;
        } else if (evt === 'transfer_progress') {
          speedBytesRecent += (data.chunkSize || 0);
          updateSpeedMeter();
        } else if (evt === 'duplicate_skipped') {
          skippedDuplicatesCount++;
          statDuplicatesSkipped.textContent = skippedDuplicatesCount;
        } else if (evt === 'file_completed') {
          historyEntries.unshift(data);
          totalTransferredBytes += (data.size || 0);
          statTotalTransferred.textContent = formatBytes(totalTransferredBytes);
          statTotalFiles.textContent = `${historyEntries.length} files saved`;
          renderTable();
          loadStatus(); // refresh storage bar
        }
      } catch (e) {}
    };

    ws.onclose = () => {
      setTimeout(initWebSocket, 3000);
    };
  }

  // Speed Graph Elements
  const speedGraphCanvas = document.getElementById('speedGraphCanvas');
  const graphCurrentSpeed = document.getElementById('graphCurrentSpeed');
  const graphPeakSpeed = document.getElementById('graphPeakSpeed');
  const ctx = speedGraphCanvas ? speedGraphCanvas.getContext('2d') : null;

  const MAX_GRAPH_POINTS = 45;
  const speedHistory = new Array(MAX_GRAPH_POINTS).fill(0);
  let peakSpeedMBps = 0;

  function drawSpeedGraph() {
    if (!ctx || !speedGraphCanvas) return;
    const w = speedGraphCanvas.width;
    const h = speedGraphCanvas.height;

    ctx.clearRect(0, 0, w, h);

    // Scale dynamically to at least 40 MB/s or higher if speed peaks
    const maxVal = Math.max(40, peakSpeedMBps * 1.15);

    // Horizontal grid lines
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.05)';
    ctx.fillStyle = 'rgba(148, 163, 184, 0.45)';
    ctx.font = '10px -apple-system, BlinkMacSystemFont, sans-serif';

    const gridLines = 3;
    for (let i = 1; i <= gridLines; i++) {
      const y = h - (h / (gridLines + 1)) * i;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();

      const speedMark = ((maxVal / (gridLines + 1)) * i).toFixed(0);
      ctx.fillText(`${speedMark} MB/s`, 10, y - 4);
    }

    // Draw Smooth Bezier Path
    ctx.beginPath();
    const stepX = w / (MAX_GRAPH_POINTS - 1);

    speedHistory.forEach((val, idx) => {
      const x = idx * stepX;
      const normalized = Math.min(1, val / maxVal);
      const y = h - (normalized * (h - 22)) - 4;

      if (idx === 0) {
        ctx.moveTo(x, y);
      } else {
        const prevX = (idx - 1) * stepX;
        const prevNormalized = Math.min(1, speedHistory[idx - 1] / maxVal);
        const prevY = h - (prevNormalized * (h - 22)) - 4;
        const cpX = (prevX + x) / 2;
        ctx.bezierCurveTo(cpX, prevY, cpX, y, x, y);
      }
    });

    // Neon Glow Stroke
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = '#06b6d4';
    ctx.shadowColor = '#06b6d4';
    ctx.shadowBlur = 10;
    ctx.stroke();
    ctx.shadowBlur = 0; // reset

    // Gradient Area Fill
    ctx.lineTo(w, h);
    ctx.lineTo(0, h);
    ctx.closePath();

    const gradient = ctx.createLinearGradient(0, 0, 0, h);
    gradient.addColorStop(0, 'rgba(6, 182, 212, 0.35)');
    gradient.addColorStop(1, 'rgba(6, 182, 212, 0.0)');
    ctx.fillStyle = gradient;
    ctx.fill();
  }

  function pushSpeed(mbps) {
    speedHistory.shift();
    speedHistory.push(mbps);
    if (mbps > peakSpeedMBps) {
      peakSpeedMBps = mbps;
      if (graphPeakSpeed) graphPeakSpeed.textContent = `Peak: ${peakSpeedMBps.toFixed(1)} MB/s`;
    }
    if (graphCurrentSpeed) graphCurrentSpeed.textContent = `${mbps.toFixed(1)} MB/s`;
    statCurrentSpeed.textContent = `${mbps.toFixed(1)} MB/s`;
    drawSpeedGraph();
  }

  function updateSpeedMeter() {
    const now = Date.now();
    const elapsed = (now - speedLastTime) / 1000;
    if (elapsed >= 0.6) {
      const mbps = (speedBytesRecent / (1024 * 1024)) / elapsed;
      const cleanMbps = Math.max(0, parseFloat(mbps.toFixed(2)));
      pushSpeed(cleanMbps);
      speedBytesRecent = 0;
      speedLastTime = now;

      clearTimeout(currentSpeedTimer);
      currentSpeedTimer = setTimeout(() => {
        pushSpeed(0);
      }, 1500);
    }
  }

  // Periodic graph redraw to keep smooth idle animation
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
