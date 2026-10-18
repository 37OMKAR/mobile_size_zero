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

  function showModal(el) {
    if (!el) return;
    el.classList.remove('hidden');
    el.classList.add('flex');
    el.style.display = 'flex';
  }

  function hideModal(el) {
    if (!el) return;
    el.classList.add('hidden');
    el.classList.remove('flex');
    el.style.display = 'none';
  }

  // Initialize Uploader
  const uploader = new ChunkUploader({
    token: sessionToken,
    pin: sessionPin,
    onProgress: (item) => updateFileProgress(item),
    onFileStatus: (item) => updateFileStatus(item),
    onSpeedUpdate: (mbps) => {
      metricSpeed.textContent = mbps.toFixed(1);
    },
    onQueueComplete: () => {
      btnPauseResume.textContent = 'PAUSE';
      metricSpeed.textContent = '0.0';
    }
  });

  // Check auth
  if (!sessionToken && !sessionPin) {
    showModal(authModal);
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
        hideModal(authModal);
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
        showModal(authModal);
      }
    } catch {
      setConnected(false);
    }
  }

  function setConnected(connected) {
    if (connected) {
      connectionText.textContent = 'Connected • 5GHz LAN (866 Mbps)';
      connectionText.className = 'font-mono text-[10px] text-secondary font-medium';
    } else {
      connectionText.textContent = 'Offline (Reconnecting...)';
      connectionText.className = 'font-mono text-[10px] text-error font-medium';
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

  let scannedItems = [];
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
    if (emptyQueue) emptyQueue.style.display = 'none';
    await uploader.addFiles(fileList);
    updateQueueBadge();
    inputMedia.value = '';
    inputFiles.value = '';
  }

  // Storage Scanner Logic
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
        selected: true,
        status: 'checking',
        reason: null
      });
    }

    scanTotalSize.textContent = formatBytes(totalBytes);
    scanItemCount.textContent = `${scannedItems.length} media items found`;

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

    showModal(scannerModal);
    inputScan.value = '';

    renderScannerList();
    updateSelectionSummary();

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
            item.selected = false;
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
    const filtered = scannedItems.filter(item => {
      if (currentScanFilter === 'heavy') return item.isHeavy;
      if (currentScanFilter === 'new') return item.status === 'new';
      if (currentScanFilter === 'on-pc') return item.status === 'on_pc';
      return true;
    });

    const cAll = document.getElementById('countScanAll') || document.getElementById('countAll');
    const cHeavy = document.getElementById('countScanHeavy') || document.getElementById('countHeavy');
    const cNew = document.getElementById('countScanNew') || document.getElementById('countNew');
    const cOnPc = document.getElementById('countScanOnPc') || document.getElementById('countOnPc');

    if (cAll) cAll.textContent = scannedItems.length;
    if (cHeavy) cHeavy.textContent = scannedItems.filter(i => i.isHeavy).length;
    if (cNew) cNew.textContent = scannedItems.filter(i => i.status === 'new').length;
    if (cOnPc) cOnPc.textContent = scannedItems.filter(i => i.status === 'on_pc').length;

    if (filtered.length === 0) {
      scannerFileList.innerHTML = `<div class="text-center font-mono text-xs text-on-surface-variant py-6">No items match this filter.</div>`;
      return;
    }

    scannerFileList.innerHTML = filtered.map(item => {
      const isChecked = item.selected ? 'checked' : '';
      let badgeHtml = '';
      if (item.isHeavy) {
        badgeHtml += `<span class="px-1.5 py-0.5 rounded bg-error-container/40 text-error font-mono text-[9px] font-semibold">HEAVY</span>`;
      }
      if (item.status === 'on_pc') {
        badgeHtml += `<span class="px-1.5 py-0.5 rounded bg-secondary-container/20 text-secondary font-mono text-[9px] font-semibold">ON PC</span>`;
      } else if (item.status === 'new') {
        badgeHtml += `<span class="px-1.5 py-0.5 rounded bg-primary-container/20 text-primary-container font-mono text-[9px] font-semibold">NEW</span>`;
      }

      return `
        <div class="p-2.5 rounded-lg bg-surface-container flex items-center gap-2.5 border border-outline-variant/20 hover:bg-surface-container-high transition-colors cursor-pointer" data-id="${item.id}">
          <input type="checkbox" ${isChecked} data-id="${item.id}" class="w-4 h-4 accent-primary-container cursor-pointer"/>
          <span class="material-symbols-outlined text-primary-container text-[20px] shrink-0">
            ${item.category === 'Videos' ? 'movie' : item.category === 'Photos' ? 'image' : 'description'}
          </span>
          <div class="flex flex-col min-w-0 flex-1">
            <span class="font-mono text-xs text-on-surface truncate font-medium">${item.name}</span>
            <div class="flex items-center gap-2 mt-0.5">
              <span class="font-mono text-[10px] text-on-surface-variant">${formatBytes(item.size)}</span>
              ${badgeHtml}
            </div>
          </div>
        </div>
      `;
    }).join('');

    scannerFileList.querySelectorAll('[data-id]').forEach(row => {
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
      updateSelectionSummary();
    }
  }

  function updateSelectionSummary() {
    const selected = scannedItems.filter(i => i.selected);
    const selectedBytes = selected.reduce((sum, i) => sum + i.size, 0);

    selectionCountText.textContent = `${selected.length} of ${scannedItems.length} selected`;
    btnTransferText.textContent = `Transfer Selected (${formatBytes(selectedBytes)})`;
  }

  scannerPills.forEach(pill => {
    pill.addEventListener('click', () => {
      scannerPills.forEach(p => {
        p.classList.remove('active', 'bg-surface-container-high', 'text-primary');
        p.classList.add('bg-surface-container', 'text-on-surface-variant');
      });
      pill.classList.add('active', 'bg-surface-container-high', 'text-primary');
      pill.classList.remove('bg-surface-container', 'text-on-surface-variant');
      currentScanFilter = pill.dataset.scanFilter;
      renderScannerList();
    });
  });

  if (btnSelectAllNew) {
    btnSelectAllNew.addEventListener('click', () => {
      scannedItems.forEach(i => { i.selected = (i.status !== 'on_pc'); });
      renderScannerList();
      updateSelectionSummary();
    });
  }

  if (btnSelectHeavy) {
    btnSelectHeavy.addEventListener('click', () => {
      scannedItems.forEach(i => { i.selected = i.isHeavy; });
      renderScannerList();
      updateSelectionSummary();
    });
  }

  if (btnCloseScanner) {
    btnCloseScanner.addEventListener('click', () => hideModal(scannerModal));
  }

  if (btnTransferSelected) {
    btnTransferSelected.addEventListener('click', async () => {
      const toTransfer = scannedItems.filter(i => i.selected).map(i => i.file);
      if (toTransfer.length === 0) {
        alert('Please select at least one file to transfer.');
        return;
      }
      hideModal(scannerModal);
      if (emptyQueue) emptyQueue.style.display = 'none';
      await uploader.addFiles(toTransfer);
      updateQueueBadge();
    });
  }

  btnPauseResume.addEventListener('click', () => {
    if (uploader.isPaused) {
      uploader.resumeAll();
      btnPauseResume.textContent = 'PAUSE';
    } else {
      uploader.pauseAll();
      btnPauseResume.textContent = 'RESUME';
      metricSpeed.textContent = '0.0';
    }
  });

  btnClearDone.addEventListener('click', () => {
    uploader.clearFinished();
    const finishedNodes = queueList.querySelectorAll('.file-item[data-status="completed"], .file-item[data-status="duplicate_skipped"]');
    finishedNodes.forEach(n => n.remove());
    if (queueList.querySelectorAll('.file-item').length === 0 && emptyQueue) {
      emptyQueue.style.display = 'flex';
    }
    updateQueueBadge();
  });

  function updateQueueBadge() {
    if (queueBadge) queueBadge.textContent = `${uploader.queue.length} Staged`;
  }

  function formatBytes(bytes) {
    if (!bytes || bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }

  function getFileIconName(filename) {
    const ext = filename.split('.').pop().toLowerCase();
    if (['jpg', 'jpeg', 'png', 'heic', 'webp', 'gif', 'dng'].includes(ext)) return 'image';
    if (['mp4', 'mov', 'avi', 'mkv', 'webm'].includes(ext)) return 'movie';
    return 'description';
  }

  function getOrCreateFileElement(item) {
    let el = document.getElementById(`item-${item.fileId}`);
    if (!el) {
      el = document.createElement('div');
      el.id = `item-${item.fileId}`;
      el.className = 'file-item p-3 rounded-lg bg-surface-container/70 flex flex-col gap-2 border border-outline-variant/20 transition-all';
      el.dataset.status = item.status;
      el.innerHTML = `
        <div class="flex items-start justify-between gap-2">
          <div class="flex items-center gap-2 min-w-0">
            <span class="status-icon material-symbols-outlined text-primary-container text-[18px] shrink-0">hourglass_top</span>
            <div class="flex flex-col min-w-0">
              <span class="font-mono text-xs text-on-surface font-medium truncate" title="${item.name}">${item.name}</span>
              <span class="font-mono text-[10px] text-on-surface-variant">${formatBytes(item.size)}</span>
            </div>
          </div>
          <div class="text-right shrink-0">
            <span class="status-chip font-mono text-[10px] px-2 py-0.5 rounded bg-surface-container text-on-surface-variant font-semibold">Pending</span>
          </div>
        </div>
        <div class="w-full bg-surface-container-lowest h-2 rounded overflow-hidden p-0.5 border border-outline-variant/20 shadow-inner">
          <div class="progress-fill h-full bg-gradient-to-r from-primary-container to-secondary rounded-xs transition-all duration-300" style="width: 0%;"></div>
        </div>
      `;
      queueList.appendChild(el);
    }
    return el;
  }

  function updateFileProgress(item) {
    const el = getOrCreateFileElement(item);
    const fill = el.querySelector('.progress-fill');
    if (fill) fill.style.width = `${item.progress}%`;
    const chip = el.querySelector('.status-chip');
    if (chip) {
      chip.className = 'status-chip font-mono text-[10px] px-2 py-0.5 rounded bg-primary-container/20 text-primary-container font-semibold';
      chip.textContent = `${item.progress}%`;
    }
  }

  function updateFileStatus(item) {
    const el = getOrCreateFileElement(item);
    el.dataset.status = item.status;
    const fill = el.querySelector('.progress-fill');
    const chip = el.querySelector('.status-chip');
    const icon = el.querySelector('.status-icon');

    if (item.status === 'checking') {
      if (chip) {
        chip.className = 'status-chip font-mono text-[10px] px-2 py-0.5 rounded bg-surface-container-highest text-primary font-semibold';
        chip.textContent = 'CHECKING DUP...';
      }
      if (icon) icon.textContent = 'sync';
    } else if (item.status === 'uploading') {
      if (chip) {
        chip.className = 'status-chip font-mono text-[10px] px-2 py-0.5 rounded bg-primary-container/20 text-primary-container font-semibold';
        chip.textContent = `${item.progress}%`;
      }
      if (icon) {
        icon.className = 'status-icon material-symbols-outlined text-primary-container text-[18px] shrink-0 animate-spin';
        icon.textContent = 'sync';
      }
    } else if (item.status === 'duplicate_skipped') {
      if (chip) {
        chip.className = 'status-chip font-mono text-[10px] px-2 py-0.5 rounded bg-secondary-container/20 text-secondary font-semibold';
        chip.textContent = 'SKIPPED (EXISTS)';
      }
      if (icon) {
        icon.className = 'status-icon material-symbols-outlined text-secondary text-[18px] shrink-0';
        icon.textContent = 'verified';
      }
      if (fill) {
        fill.className = 'progress-fill h-full bg-secondary rounded-xs';
        fill.style.width = '100%';
      }
      skippedDuplicatesCount++;
      if (metricSkipped) metricSkipped.textContent = skippedDuplicatesCount;
    } else if (item.status === 'finalizing') {
      if (chip) {
        chip.className = 'status-chip font-mono text-[10px] px-2 py-0.5 rounded bg-surface-container-highest text-primary font-semibold';
        chip.textContent = 'VERIFYING SHA-256...';
      }
    } else if (item.status === 'completed') {
      if (chip) {
        chip.className = 'status-chip font-mono text-[10px] px-2 py-0.5 rounded bg-secondary-container/30 text-secondary font-semibold';
        chip.textContent = '100% VERIFIED';
      }
      if (icon) {
        icon.className = 'status-icon material-symbols-outlined text-secondary text-[18px] shrink-0';
        icon.textContent = 'check_circle';
      }
      if (fill) {
        fill.className = 'progress-fill h-full bg-secondary rounded-xs';
        fill.style.width = '100%';
      }
      totalTransferredBytes += item.size;
      if (metricTransferred) metricTransferred.textContent = formatBytes(totalTransferredBytes);

      if (!verifiedFiles.some(f => f.name === item.name)) {
        verifiedFiles.push({ name: item.name, size: item.size });
      }
      updateCleanupCard();
    } else if (item.status === 'failed') {
      if (chip) {
        chip.className = 'status-chip font-mono text-[10px] px-2 py-0.5 rounded bg-error-container/40 text-error font-semibold';
        chip.textContent = 'FAILED (TAP TO RETRY)';
      }
      if (icon) {
        icon.className = 'status-icon material-symbols-outlined text-error text-[18px] shrink-0';
        icon.textContent = 'error';
      }
      el.onclick = () => {
        item.status = 'pending';
        uploader.processQueue();
      };
    } else if (item.status === 'paused') {
      if (chip) {
        chip.className = 'status-chip font-mono text-[10px] px-2 py-0.5 rounded bg-surface-container text-on-surface-variant font-semibold';
        chip.textContent = 'PAUSED';
      }
    }

    updateQueueBadge();
  }

  function updateCleanupCard() {
    if (verifiedFiles.length > 0 && cleanupCard) {
      cleanupCard.style.display = 'flex';
      cleanupHeading.textContent = `🎉 ${verifiedFiles.length} File${verifiedFiles.length > 1 ? 's' : ''} Ready to Clear from Phone`;
      cleanupSubtext.textContent = `${formatBytes(totalTransferredBytes)} safely verified on PC! You can now safely delete these items from your gallery to make your mobile space empty.`;
      
      verifiedFilesList.innerHTML = verifiedFiles.map(f => `
        <div class="flex items-center justify-between p-1.5 rounded bg-surface-container">
          <span class="truncate max-w-[70%] text-on-surface">${f.name}</span>
          <span class="text-secondary font-semibold">${formatBytes(f.size)}</span>
        </div>
      `).join('');
    }
  }

  if (btnToggleVerifiedList) {
    btnToggleVerifiedList.addEventListener('click', () => {
      const isVisible = verifiedFilesList.style.display === 'flex';
      verifiedFilesList.style.display = isVisible ? 'none' : 'flex';
    });
  }

  if (btnCopyFilenames) {
    btnCopyFilenames.addEventListener('click', () => {
      const names = verifiedFiles.map(f => f.name).join('\n');
      navigator.clipboard.writeText(names).then(() => {
        btnCopyFilenames.textContent = 'Copied to Clipboard!';
        setTimeout(() => { btnCopyFilenames.textContent = 'Copy Backed-Up Filenames'; }, 2000);
      });
    });
  }

  // Real-time WebSocket connection to PC
  function initWebSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}`;
    const ws = new WebSocket(wsUrl);

    ws.onopen = () => setConnected(true);
    ws.onclose = () => {
      setConnected(false);
      setTimeout(initWebSocket, 3000);
    };
    ws.onerror = () => setConnected(false);
  }

  initWebSocket();
});
