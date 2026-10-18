document.addEventListener('DOMContentLoaded', () => {
  const params = new URLSearchParams(window.location.search);
  let sessionToken = params.get('token') || localStorage.getItem('airtransfer_token') || '';
  let sessionPin = params.get('pin') || localStorage.getItem('airtransfer_pin') || '';

  // Elements
  const connectionStatus = document.getElementById('connectionStatus');
  const connectionText = document.getElementById('connectionText');
  const metricTransferred = document.getElementById('metricTransferred');
  const metricSpeed = document.getElementById('metricSpeed');
  const metricSkipped = document.getElementById('metricSkipped');
  const wakeLockBanner = document.getElementById('wakeLockBanner');
  
  const btnPickMedia = document.getElementById('btnPickMedia');
  const btnPickFiles = document.getElementById('btnPickFiles');
  const inputMedia = document.getElementById('inputMedia');
  const inputFiles = document.getElementById('inputFiles');

  const queueBadge = document.getElementById('queueBadge');
  const btnPauseResume = document.getElementById('btnPauseResume');
  const btnClearDone = document.getElementById('btnClearDone');
  const queueList = document.getElementById('queueList');
  const emptyQueue = document.getElementById('emptyQueue');

  // Space Emptying Cleanup Elements
  const cleanupCard = document.getElementById('cleanupCard');
  const cleanupHeading = document.getElementById('cleanupHeading');
  const cleanupSubtext = document.getElementById('cleanupSubtext');
  const btnToggleVerifiedList = document.getElementById('btnToggleVerifiedList');
  const btnCopyFilenames = document.getElementById('btnCopyFilenames');
  const verifiedFilesList = document.getElementById('verifiedFilesList');

  const authModal = document.getElementById('authModal');
  const inputPin = document.getElementById('inputPin');
  const btnSubmitPin = document.getElementById('btnSubmitPin');

  let totalTransferredBytes = 0;
  let skippedDuplicatesCount = 0;
  const verifiedFiles = [];

  // Initialize Uploader
  const uploader = new ChunkUploader({
    token: sessionToken,
    pin: sessionPin,
    onProgress: (item) => updateFileProgress(item),
    onFileStatus: (item) => updateFileStatus(item),
    onSpeedUpdate: (mbps) => {
      metricSpeed.textContent = `${mbps.toFixed(1)} MB/s`;
    },
    onQueueComplete: () => {
      btnPauseResume.textContent = 'Pause';
      metricSpeed.textContent = '0.0 MB/s';
    }
  });

  // Check auth
  if (!sessionToken && !sessionPin) {
    authModal.style.display = 'flex';
  } else {
    validateSession();
  }

  btnSubmitPin.addEventListener('click', async () => {
    const pin = inputPin.value.trim();
    if (pin.length !== 6) {
      alert('Please enter a 6-digit PIN');
      return;
    }

    try {
      const res = await fetch('/api/auth/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin })
      });
      const data = await res.json();
      if (data.success) {
        sessionToken = data.token;
        sessionPin = pin;
        localStorage.setItem('airtransfer_token', sessionToken);
        localStorage.setItem('airtransfer_pin', sessionPin);
        uploader.setCredentials(sessionToken, sessionPin);
        authModal.style.display = 'none';
        validateSession();
      } else {
        alert(data.error || 'Authentication failed');
      }
    } catch (err) {
      alert('Connection error: ' + err.message);
    }
  });

  async function validateSession() {
    try {
      const res = await fetch('/api/status', {
        headers: { 'Authorization': `Bearer ${sessionToken}`, 'x-pin': sessionPin }
      });
      if (res.ok) {
        setConnected(true);
      } else {
        setConnected(false);
        authModal.style.display = 'flex';
      }
    } catch {
      setConnected(false);
    }
  }

  function setConnected(connected) {
    if (connected) {
      connectionStatus.className = 'status-indicator';
      connectionText.textContent = 'Connected';
    } else {
      connectionStatus.className = 'status-indicator disconnected';
      connectionText.textContent = 'Offline';
    }
  }

  // Scanner Elements
  const btnScanStorage = document.getElementById('btnScanStorage');
  const inputScan = document.getElementById('inputScan');
  const scannerModal = document.getElementById('scannerModal');
  const btnCloseScanner = document.getElementById('btnCloseScanner');
  const scanTotalSize = document.getElementById('scanTotalSize');
  const scanItemCount = document.getElementById('scanItemCount');
  const barVideos = document.getElementById('barVideos');
  const barPhotos = document.getElementById('barPhotos');
  const barDocs = document.getElementById('barDocs');
  const legendVideos = document.getElementById('legendVideos');
  const legendPhotos = document.getElementById('legendPhotos');
  const legendDocs = document.getElementById('legendDocs');
  const scanDupStatus = document.getElementById('scanDupStatus');
  const scanDupDetails = document.getElementById('scanDupDetails');
  const scannerFileList = document.getElementById('scannerFileList');
  const btnTransferSelected = document.getElementById('btnTransferSelected');
  const btnTransferText = document.getElementById('btnTransferText');
  const selectionCountText = document.getElementById('selectionCountText');
  const btnSelectAllNew = document.getElementById('btnSelectAllNew');
  const btnSelectHeavy = document.getElementById('btnSelectHeavy');
  const scannerPills = document.querySelectorAll('.scanner-pill');

  let scannedItems = []; // Array of scanned file objects
  let currentScanFilter = 'all';

  // File Picker bindings
  if (btnScanStorage) {
    btnScanStorage.addEventListener('click', () => inputScan.click());
  }
  if (inputScan) {
    inputScan.addEventListener('change', (e) => startStorageScan(e.target.files));
  }

  btnPickMedia.addEventListener('click', () => inputMedia.click());
  btnPickFiles.addEventListener('click', () => inputFiles.click());

  inputMedia.addEventListener('change', (e) => handleFileSelection(e.target.files));
  inputFiles.addEventListener('change', (e) => handleFileSelection(e.target.files));

  async function handleFileSelection(fileList) {
    if (!fileList || fileList.length === 0) return;
    emptyQueue.style.display = 'none';
    const added = await uploader.addFiles(fileList);
    updateQueueBadge();
    // Reset inputs so same files can be re-selected if testing
    inputMedia.value = '';
    inputFiles.value = '';
  }

  // --- Storage Scanner & Analysis Logic ---
  async function startStorageScan(fileList) {
    if (!fileList || fileList.length === 0) return;
    
    scannedItems = [];
    let totalBytes = 0;
    let videoBytes = 0;
    let photoBytes = 0;
    let docBytes = 0;

    for (let i = 0; i < fileList.length; i++) {
      const file = fileList[i];
      const ext = file.name.split('.').pop().toLowerCase();
      const isVideo = ['mp4', 'mov', 'avi', 'mkv', 'webm', '3gp', 'm4v'].includes(ext);
      const isPhoto = ['jpg', 'jpeg', 'png', 'heic', 'heif', 'webp', 'gif', 'dng'].includes(ext);
      const isHeavy = file.size >= 50 * 1024 * 1024; // > 50MB

      totalBytes += file.size;
      if (isVideo) videoBytes += file.size;
      else if (isPhoto) photoBytes += file.size;
      else docBytes += file.size;

      scannedItems.push({
        id: `scan_${i}_${file.size}`,
        file,
        name: file.name,
        size: file.size,
        mtime: file.lastModified,
        category: isVideo ? 'Videos' : isPhoto ? 'Photos' : 'Documents',
        isHeavy,
        selected: true, // checked by default
        status: 'checking', // checking, new, on_pc
        reason: null
      });
    }

    // Update Summary Header
    scanTotalSize.textContent = formatBytes(totalBytes);
    scanItemCount.textContent = `${scannedItems.length} media items found`;

    // Proportional breakdown bars
    const safeTotal = totalBytes || 1;
    const vPct = ((videoBytes / safeTotal) * 100).toFixed(1);
    const pPct = ((photoBytes / safeTotal) * 100).toFixed(1);
    const dPct = ((docBytes / safeTotal) * 100).toFixed(1);

    barVideos.style.width = `${vPct}%`;
    barPhotos.style.width = `${pPct}%`;
    barDocs.style.width = `${dPct}%`;

    legendVideos.textContent = `Videos: ${formatBytes(videoBytes)} (${vPct}%)`;
    legendPhotos.textContent = `Photos: ${formatBytes(photoBytes)} (${pPct}%)`;
    legendDocs.textContent = `Docs/Other: ${formatBytes(docBytes)} (${dPct}%)`;

    scannerModal.style.display = 'flex';
    inputScan.value = '';

    renderScannerList();
    updateSelectionSummary();

    // Run background duplicate check against PC
    runDuplicateScanAgainstPc();
  }

  async function runDuplicateScanAgainstPc() {
    scanDupStatus.textContent = 'Scanning PC catalog...';
    scanDupDetails.textContent = 'Contacting PC to identify files already safely backed up...';

    let alreadyOnPcCount = 0;
    let savedBytes = 0;

    for (const item of scannedItems) {
      try {
        const quickHash = await uploader.computeQuickHash(item.file);
        const checkRes = await fetch('/api/check-file', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${sessionToken}`,
            'x-pin': sessionPin
          },
          body: JSON.stringify({
            fileId: 'scan_check_' + item.id,
            name: item.name,
            size: item.size,
            mtime: item.mtime,
            quickHash
          })
        });

        if (checkRes.ok) {
          const data = await checkRes.json();
          if (data.status === 'duplicate') {
            item.status = 'on_pc';
            item.selected = false; // Uncheck duplicates so user transfers only new files!
            alreadyOnPcCount++;
            savedBytes += item.size;
          } else {
            item.status = 'new';
          }
        }
      } catch (err) {
        item.status = 'new';
      }
    }

    // Update Banner
    if (alreadyOnPcCount > 0) {
      scanDupStatus.textContent = `⚡ ${alreadyOnPcCount} Files Already on PC`;
      scanDupDetails.textContent = `${formatBytes(savedBytes)} is already backed up on your PC! Unchecked to save transfer time and battery.`;
    } else {
      scanDupStatus.textContent = `🚀 All ${scannedItems.length} Files Ready to Transfer`;
      scanDupDetails.textContent = `None of these files exist on your PC yet. Ready for ultra-fast transfer!`;
    }

    renderScannerList();
    updateSelectionSummary();
  }

  function renderScannerList() {
    // Filter items
    const filtered = scannedItems.filter(item => {
      if (currentScanFilter === 'heavy') return item.isHeavy;
      if (currentScanFilter === 'new') return item.status === 'new';
      if (currentScanFilter === 'on-pc') return item.status === 'on_pc';
      return true;
    });

    // Update filter counts
    document.getElementById('countAll').textContent = scannedItems.length;
    document.getElementById('countHeavy').textContent = scannedItems.filter(i => i.isHeavy).length;
    document.getElementById('countNew').textContent = scannedItems.filter(i => i.status === 'new').length;
    document.getElementById('countOnPc').textContent = scannedItems.filter(i => i.status === 'on_pc').length;

    if (filtered.length === 0) {
      scannerFileList.innerHTML = `<div style="text-align: center; color: var(--text-dim); padding: 24px;">No items match this filter.</div>`;
      return;
    }

    scannerFileList.innerHTML = filtered.map(item => {
      const isChecked = item.selected ? 'checked' : '';
      const selectedClass = item.selected ? 'selected' : '';
      
      let badgeHtml = '';
      if (item.isHeavy) {
        badgeHtml += `<span class="heavy-badge">Heavy &gt; 50MB</span>`;
      }
      if (item.status === 'on_pc') {
        badgeHtml += `<span class="on-pc-badge">Already on PC</span>`;
      } else if (item.status === 'new') {
        badgeHtml += `<span style="background: rgba(56, 189, 248, 0.15); color: var(--accent-blue); padding: 1px 6px; border-radius: 4px; font-weight: 600;">New</span>`;
      }

      return `
        <div class="scanner-item ${selectedClass}" data-id="${item.id}">
          <input type="checkbox" ${isChecked} data-id="${item.id}">
          <div class="file-icon-box" style="width: 32px; height: 32px;">${getFileIcon(item.name)}</div>
          <div class="scanner-item-details">
            <div class="scanner-item-name" title="${item.name}">${item.name}</div>
            <div class="scanner-item-sub">
              <span>${formatBytes(item.size)}</span>
              ${badgeHtml}
            </div>
          </div>
        </div>
      `;
    }).join('');

    // Attach click handlers to checkboxes and row
    scannerFileList.querySelectorAll('.scanner-item').forEach(row => {
      row.addEventListener('click', (e) => {
        if (e.target.tagName !== 'INPUT') {
          const cb = row.querySelector('input[type="checkbox"]');
          cb.checked = !cb.checked;
          handleCheckboxToggle(cb.dataset.id, cb.checked);
        }
      });
      const cb = row.querySelector('input[type="checkbox"]');
      cb.addEventListener('change', (e) => {
        handleCheckboxToggle(e.target.dataset.id, e.target.checked);
      });
    });
  }

  function handleCheckboxToggle(id, isChecked) {
    const item = scannedItems.find(i => i.id === id);
    if (item) {
      item.selected = isChecked;
      const row = scannerFileList.querySelector(`.scanner-item[data-id="${id}"]`);
      if (row) {
        if (isChecked) row.classList.add('selected');
        else row.classList.remove('selected');
      }
      updateSelectionSummary();
    }
  }

  function updateSelectionSummary() {
    const selected = scannedItems.filter(i => i.selected);
    const selectedBytes = selected.reduce((sum, i) => sum + i.size, 0);

    selectionCountText.textContent = `${selected.length} of ${scannedItems.length} selected`;
    btnTransferText.textContent = `Transfer Selected (${formatBytes(selectedBytes)})`;
  }

  // Scanner filter buttons
  scannerPills.forEach(pill => {
    pill.addEventListener('click', () => {
      scannerPills.forEach(p => p.classList.remove('active'));
      pill.classList.add('active');
      currentScanFilter = pill.dataset.scanFilter;
      renderScannerList();
    });
  });

  // Quick Selectors
  if (btnSelectAllNew) {
    btnSelectAllNew.addEventListener('click', () => {
      scannedItems.forEach(i => {
        i.selected = (i.status !== 'on_pc');
      });
      renderScannerList();
      updateSelectionSummary();
    });
  }

  if (btnSelectHeavy) {
    btnSelectHeavy.addEventListener('click', () => {
      scannedItems.forEach(i => {
        i.selected = i.isHeavy;
      });
      renderScannerList();
      updateSelectionSummary();
    });
  }

  // Close scanner modal
  if (btnCloseScanner) {
    btnCloseScanner.addEventListener('click', () => {
      scannerModal.style.display = 'none';
    });
  }

  // Transfer Selected Button
  if (btnTransferSelected) {
    btnTransferSelected.addEventListener('click', async () => {
      const toTransfer = scannedItems.filter(i => i.selected).map(i => i.file);
      if (toTransfer.length === 0) {
        alert('Please select at least one file to transfer.');
        return;
      }
      scannerModal.style.display = 'none';
      emptyQueue.style.display = 'none';
      await uploader.addFiles(toTransfer);
      updateQueueBadge();
    });
  }

  btnPauseResume.addEventListener('click', () => {
    if (uploader.isPaused) {
      uploader.resumeAll();
      btnPauseResume.textContent = 'Pause';
    } else {
      uploader.pauseAll();
      btnPauseResume.textContent = 'Resume All';
      metricSpeed.textContent = '0.0 MB/s';
    }
  });

  btnClearDone.addEventListener('click', () => {
    uploader.clearFinished();
    // Remove completed DOM items
    const finishedNodes = queueList.querySelectorAll('.file-item[data-status="completed"], .file-item[data-status="duplicate_skipped"]');
    finishedNodes.forEach(n => n.remove());
    if (queueList.querySelectorAll('.file-item').length === 0) {
      emptyQueue.style.display = 'block';
    }
    updateQueueBadge();
  });

  function updateQueueBadge() {
    queueBadge.textContent = uploader.queue.length;
  }

  function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }

  function getFileIcon(filename) {
    const ext = filename.split('.').pop().toLowerCase();
    if (['jpg', 'jpeg', 'png', 'heic', 'webp', 'gif'].includes(ext)) {
      return `<svg width="20" height="20" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" /></svg>`;
    }
    if (['mp4', 'mov', 'avi', 'mkv', 'webm'].includes(ext)) {
      return `<svg width="20" height="20" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" /></svg>`;
    }
    return `<svg width="20" height="20" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>`;
  }

  function getOrCreateFileElement(item) {
    let el = document.getElementById(`item-${item.fileId}`);
    if (!el) {
      el = document.createElement('div');
      el.id = `item-${item.fileId}`;
      el.className = 'file-item';
      el.dataset.status = item.status;
      el.innerHTML = `
        <div class="file-main-info">
          <div class="file-identity">
            <div class="file-icon-box">${getFileIcon(item.name)}</div>
            <div class="file-details">
              <div class="file-name" title="${item.name}">${item.name}</div>
              <div class="file-submeta">${formatBytes(item.size)}</div>
            </div>
          </div>
          <div class="status-chip-container">
            <span class="status-chip chip-pending">Pending</span>
          </div>
        </div>
        <div class="progress-track">
          <div class="progress-fill" style="width: 0%;"></div>
        </div>
      `;
      queueList.appendChild(el);
    }
    return el;
  }

  function updateFileProgress(item) {
    const el = getOrCreateFileElement(item);
    const fill = el.querySelector('.progress-fill');
    fill.style.width = `${item.progress}%`;
    const chip = el.querySelector('.status-chip');
    chip.className = 'status-chip chip-uploading';
    chip.textContent = `${item.progress}%`;
  }

  function updateFileStatus(item) {
    const el = getOrCreateFileElement(item);
    el.dataset.status = item.status;
    const fill = el.querySelector('.progress-fill');
    const chip = el.querySelector('.status-chip');

    if (item.status === 'checking') {
      chip.className = 'status-chip chip-checking';
      chip.textContent = 'Checking Duplicate...';
    } else if (item.status === 'uploading') {
      el.classList.add('uploading');
      chip.className = 'status-chip chip-uploading';
      chip.textContent = `${item.progress}%`;
    } else if (item.status === 'duplicate_skipped') {
      el.classList.remove('uploading');
      chip.className = 'status-chip chip-duplicate';
      chip.textContent = 'Skipped (Duplicate)';
      fill.className = 'progress-fill duplicate';
      fill.style.width = '100%';
      skippedDuplicatesCount++;
      metricSkipped.textContent = skippedDuplicatesCount;
    } else if (item.status === 'finalizing') {
      chip.className = 'status-chip chip-checking';
      chip.textContent = 'Verifying SHA-256...';
    } else if (item.status === 'completed') {
      el.classList.remove('uploading');
      chip.className = 'status-chip chip-completed';
      chip.textContent = 'Verified & Saved';
      fill.className = 'progress-fill completed';
      fill.style.width = '100%';
      totalTransferredBytes += item.size;
      metricTransferred.textContent = formatBytes(totalTransferredBytes);

      // Track verified files for mobile space emptying
      if (!verifiedFiles.some(f => f.name === item.name)) {
        verifiedFiles.push({ name: item.name, size: item.size });
      }
      updateCleanupCard();
    } else if (item.status === 'failed') {
      el.classList.remove('uploading');
      chip.className = 'status-chip chip-failed';
      chip.textContent = 'Failed - Tap to Retry';
      fill.className = 'progress-fill failed';
      el.style.cursor = 'pointer';
      el.onclick = () => {
        item.status = 'pending';
        uploader.processQueue();
      };
    } else if (item.status === 'paused') {
      el.classList.remove('uploading');
      chip.className = 'status-chip chip-pending';
      chip.textContent = 'Paused';
    }

    updateQueueBadge();
  }

  function updateCleanupCard() {
    if (verifiedFiles.length > 0 && cleanupCard) {
      cleanupCard.style.display = 'block';
      cleanupHeading.textContent = `🎉 ${verifiedFiles.length} File${verifiedFiles.length > 1 ? 's' : ''} Ready to Clear from Phone`;
      cleanupSubtext.textContent = `${formatBytes(totalTransferredBytes)} safely verified on PC! You can now safely delete these items from your gallery to make your mobile space empty.`;
      
      verifiedFilesList.innerHTML = verifiedFiles.map(f => `
        <div class="verified-file-entry">
          <span style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 75%;">${f.name}</span>
          <span style="color: var(--accent-green); font-weight: 600;">${formatBytes(f.size)}</span>
        </div>
      `).join('');
    }
  }

  if (btnToggleVerifiedList) {
    btnToggleVerifiedList.addEventListener('click', () => {
      const isVisible = verifiedFilesList.style.display === 'flex';
      verifiedFilesList.style.display = isVisible ? 'none' : 'flex';
      btnToggleVerifiedList.textContent = isVisible ? 'View Safe Files' : 'Hide List';
    });
  }

  if (btnCopyFilenames) {
    btnCopyFilenames.addEventListener('click', () => {
      const names = verifiedFiles.map(f => f.name).join('\n');
      navigator.clipboard.writeText(names).then(() => {
        btnCopyFilenames.textContent = 'Copied!';
        setTimeout(() => { btnCopyFilenames.textContent = 'Copy Filenames'; }, 2000);
      });
    });
  }

  // Real-time WebSocket connection to PC
  function initWebSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}`;
    const ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      setConnected(true);
    };

    ws.onclose = () => {
      setConnected(false);
      setTimeout(initWebSocket, 3000);
    };

    ws.onerror = () => {
      setConnected(false);
    };
  }

  initWebSocket();
});
