const { exec, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

class MtpPhoneEngine {
  constructor() {
    this.activeChild = null;
    this.isTransferring = false;
    this.shouldCancel = false;
    this.isPaused = false;
  }

  /**
   * Detect all connected MTP phones and list their storages & primary media folders
   */
  async detectDevices() {
    return new Promise((resolve) => {
      const psScript = `
$ErrorActionPreference = 'SilentlyContinue'
$shell = New-Object -ComObject Shell.Application
$myComputer = $shell.NameSpace(17)
$phones = @()

foreach ($item in $myComputer.Items()) {
    if ($item.Type -like "*Portable Device*" -or $item.Type -like "*Phone*" -or $item.Path -like "::{20D04FE0*") {
        $phoneName = $item.Name
        $phoneFolder = $item.GetFolder
        $storages = @()

        if ($phoneFolder) {
            foreach ($sub in $phoneFolder.Items()) {
                $storageName = $sub.Name
                $subFolder = $sub.GetFolder
                $folders = @()
                if ($subFolder) {
                    foreach ($f in $subFolder.Items()) {
                        if ($f.IsFolder -and $f.Name -notlike ".*" -and $f.Name -ne "Android" -and $f.Name -ne "System Volume Information" -and $f.Name -ne "LOST.DIR") {
                            $folders += $f.Name
                        }
                    }
                }
                $storages += [PSCustomObject]@{
                    name = $storageName
                    folders = $folders
                }
            }
        }

        $phones += [PSCustomObject]@{
            name = $phoneName
            type = $item.Type
            storages = $storages
        }
    }
}

$phones | ConvertTo-Json -Depth 4
`;

      const tempFile = path.join(process.cwd(), `.mtp_detect_${Date.now()}.ps1`);
      fs.writeFileSync(tempFile, psScript, 'utf8');

      exec(`powershell -NoProfile -ExecutionPolicy Bypass -File "${tempFile}"`, { maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
        try { fs.unlinkSync(tempFile); } catch {}
        if (err || !stdout || !stdout.trim()) {
          return resolve([]);
        }
        try {
          const parsed = JSON.parse(stdout.trim());
          const list = Array.isArray(parsed) ? parsed : [parsed];
          resolve(list);
        } catch (e) {
          console.error('[MtpPhoneEngine] detectDevices parse error:', e.message);
          resolve([]);
        }
      });
    });
  }

  /**
   * Scan a specific folder on a phone to get file count and preview
   */
  async scanFolder(phoneName, storageName, folderName) {
    return new Promise((resolve) => {
      const psScript = `
$ErrorActionPreference = 'SilentlyContinue'
$shell = New-Object -ComObject Shell.Application
$myComputer = $shell.NameSpace(17)
$phone = $null

foreach ($item in $myComputer.Items()) {
    if ($item.Name -eq "${phoneName.replace(/"/g, '`"')}") {
        $phone = $item
        break
    }
}

if (-not $phone) {
    Write-Output "[]"
    exit 0
}

$phoneFolder = $phone.GetFolder
$storage = $null
foreach ($sub in $phoneFolder.Items()) {
    if ($sub.Name -eq "${storageName.replace(/"/g, '`"')}") {
        $storage = $sub
        break
    }
}

if (-not $storage) {
    Write-Output "[]"
    exit 0
}

$storageFolder = $storage.GetFolder
$target = $null
foreach ($f in $storageFolder.Items()) {
    if ($f.Name -eq "${folderName.replace(/"/g, '`"')}") {
        $target = $f
        break
    }
}

if (-not $target) {
    Write-Output "[]"
    exit 0
}

$targetFolder = $target.GetFolder
$items = @()
foreach ($file in $targetFolder.Items()) {
    if (-not $file.IsFolder) {
        $items += [PSCustomObject]@{
            name = $file.Name
            type = $file.Type
        }
    }
}

$items | ConvertTo-Json -Depth 2
`;

      const tempFile = path.join(process.cwd(), `.mtp_scan_${Date.now()}.ps1`);
      fs.writeFileSync(tempFile, psScript, 'utf8');

      exec(`powershell -NoProfile -ExecutionPolicy Bypass -File "${tempFile}"`, { maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
        try { fs.unlinkSync(tempFile); } catch {}
        if (err || !stdout || !stdout.trim()) {
          return resolve({ totalFiles: 0, files: [] });
        }
        try {
          const parsed = JSON.parse(stdout.trim());
          const list = Array.isArray(parsed) ? parsed : [parsed];
          resolve({
            totalFiles: list.length,
            files: list
          });
        } catch (e) {
          console.error('[MtpPhoneEngine] scanFolder parse error:', e.message);
          resolve({ totalFiles: 0, files: [] });
        }
      });
    });
  }

  /**
   * Start batch file transfer from MTP phone to PC
   */
  async startTransfer({ phoneName, storageName, folderName, destinationDir, deduplicator, fileOrganizer, broadcast }) {
    if (this.isTransferring) {
      throw new Error('A phone transfer is already running');
    }

    this.isTransferring = true;
    this.shouldCancel = false;

    // Intermediate staging directory
    const stagingDir = path.join(destinationDir, '.mtp_staging');
    if (!fs.existsSync(stagingDir)) {
      fs.mkdirSync(stagingDir, { recursive: true });
    }

    const scriptPath = path.join(process.cwd(), `.mtp_run_${Date.now()}.ps1`);
    const psScript = `
$ErrorActionPreference = 'SilentlyContinue'
$destPath = '${stagingDir.replace(/'/g, "''")}'
$shell = New-Object -ComObject Shell.Application
$destFolder = $shell.NameSpace($destPath)

$myComputer = $shell.NameSpace(17)
$phone = $null
foreach ($item in $myComputer.Items()) {
    if ($item.Name -eq "${phoneName.replace(/"/g, '`"')}") {
        $phone = $item
        break
    }
}

if (-not $phone) {
    Write-Output "ERROR:Phone not found"
    exit 1
}

$phoneFolder = $phone.GetFolder
$storage = $null
foreach ($sub in $phoneFolder.Items()) {
    if ($sub.Name -eq "${storageName.replace(/"/g, '`"')}") {
        $storage = $sub
        break
    }
}

if (-not $storage) {
    Write-Output "ERROR:Storage volume not found"
    exit 1
}

$storageFolder = $storage.GetFolder
$target = $null
foreach ($f in $storageFolder.Items()) {
    if ($f.Name -eq "${folderName.replace(/"/g, '`"')}") {
        $target = $f
        break
    }
}

if (-not $target) {
    Write-Output "ERROR:Target folder not found"
    exit 1
}

$targetFolder = $target.GetFolder
$allFiles = @()
foreach ($file in $targetFolder.Items()) {
    if (-not $file.IsFolder) {
        $allFiles += $file
    }
}

Write-Output "PLAN_TOTAL:$($allFiles.Count)"

$index = 0
foreach ($file in $allFiles) {
    $index++
    $fileName = $file.Name
    $localTarget = Join-Path $destPath $fileName

    Write-Output "START_FILE:$index:$fileName"
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $destFolder.CopyHere($file, 16 + 4)

    # Wait for file to land on disk
    $waitMs = 0
    while (-not (Test-Path $localTarget) -and $waitMs -lt 60000) {
        Start-Sleep -Milliseconds 150
        $waitMs += 150
    }

    if (Test-Path $localTarget) {
        # Ensure file write is completed
        $prevSize = -1
        $currSize = (Get-Item $localTarget).Length
        while ($currSize -ne $prevSize -and $waitMs -lt 60000) {
            $prevSize = $currSize
            Start-Sleep -Milliseconds 250
            $currSize = (Get-Item $localTarget).Length
        }
        $sw.Stop()
        Write-Output "DONE_FILE:$index:$fileName:$currSize:$($sw.ElapsedMilliseconds)"
    } else {
        Write-Output "TIMEOUT_FILE:$index:$fileName"
    }
}

Write-Output "ALL_DONE"
`;

    fs.writeFileSync(scriptPath, psScript, 'utf8');

    return new Promise((resolve, reject) => {
      let totalFiles = 0;
      let completedCount = 0;
      let duplicateCount = 0;
      let totalBytesTransferred = 0;
      const verifiedFiles = [];
      const startTime = Date.now();

      const child = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath]);
      this.activeChild = child;

      let buffer = '';

      child.stdout.on('data', async (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop(); // keep remainder

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          if (trimmed.startsWith('PLAN_TOTAL:')) {
            totalFiles = parseInt(trimmed.substring(11), 10) || 0;
            if (broadcast) {
              broadcast('mtp_transfer_started', {
                phoneName,
                storageName,
                folderName,
                totalFiles
              });
            }
          } else if (trimmed.startsWith('START_FILE:')) {
            const parts = trimmed.split(':');
            const fileIndex = parseInt(parts[1], 10);
            const fileName = parts.slice(2).join(':');

            if (broadcast) {
              broadcast('transfer_progress', {
                currentFileName: fileName,
                fileIndex,
                totalFiles
              });
            }
          } else if (trimmed.startsWith('DONE_FILE:')) {
            const parts = trimmed.split(':');
            const fileIndex = parseInt(parts[1], 10);
            const fileName = parts[2];
            const size = parseInt(parts[3], 10) || 0;
            const elapsedMs = parseInt(parts[4], 10) || 1;

            const stagedPath = path.join(stagingDir, fileName);

            if (fs.existsSync(stagedPath)) {
              // 1. Calculate SHA-256 Checksum
              const hash = crypto.createHash('sha256');
              const data = fs.readFileSync(stagedPath);
              hash.update(data);
              const sha256 = hash.digest('hex');

              // 2. Pre-flight duplicate check against PC deduplicator
              if (deduplicator) {
                const dup = await deduplicator.checkDuplicate({
                  name: fileName,
                  size,
                  sha256
                });

                if (dup.isDuplicate) {
                  duplicateCount++;
                  try { fs.unlinkSync(stagedPath); } catch {}
                  if (broadcast) {
                    broadcast('duplicate_skipped', {
                      name: fileName,
                      size,
                      reason: dup.reason
                    });
                  }
                  continue;
                }
              }

              // 3. Move from staging into organized storage path
              let finalPath;
              if (fileOrganizer) {
                finalPath = fileOrganizer.determineDestinationPath({
                  name: fileName,
                  size
                });
              } else {
                finalPath = path.join(destinationDir, fileName);
              }

              const finalDir = path.dirname(finalPath);
              if (!fs.existsSync(finalDir)) {
                fs.mkdirSync(finalDir, { recursive: true });
              }

              fs.renameSync(stagedPath, finalPath);

              // 4. Register in deduplicator
              if (deduplicator) {
                await deduplicator.registerFile({
                  name: fileName,
                  size,
                  filePath: finalPath,
                  sha256
                });
              }

              completedCount++;
              totalBytesTransferred += size;
              verifiedFiles.push({
                name: fileName,
                size,
                path: finalPath,
                sha256
              });

              const speedMBps = parseFloat(((size / (1024 * 1024)) / (elapsedMs / 1000)).toFixed(2));

              if (broadcast) {
                broadcast('file_completed', {
                  name: fileName,
                  size,
                  path: finalPath,
                  sha256,
                  category: fileOrganizer ? fileOrganizer.getCategory(fileName) : 'Files',
                  fileIndex,
                  totalFiles
                });

                broadcast('transfer_progress', {
                  chunkSize: size,
                  currentSpeedMBps: speedMBps,
                  fileIndex,
                  totalFiles,
                  currentFileName: fileName
                });
              }
            }
          }
        }
      });

      child.stderr.on('data', (errData) => {
        console.error('[MTP Transfer stderr]:', errData.toString().trim());
      });

      child.on('close', (code) => {
        this.isTransferring = false;
        this.activeChild = null;
        try { fs.unlinkSync(scriptPath); } catch {}
        try { if (fs.existsSync(stagingDir)) fs.rmSync(stagingDir, { recursive: true, force: true }); } catch {}

        const durationSeconds = parseFloat(((Date.now() - startTime) / 1000).toFixed(1)) || 0.1;
        const averageSpeedMBps = parseFloat(((totalBytesTransferred / (1024 * 1024)) / durationSeconds).toFixed(2));

        const summary = {
          success: code === 0 && !this.shouldCancel,
          completedCount,
          duplicateCount,
          totalBytesTransferred,
          durationSeconds,
          averageSpeedMBps,
          verifiedFiles
        };

        if (broadcast) {
          broadcast('mtp_transfer_completed', summary);
        }

        resolve(summary);
      });

      child.on('error', (err) => {
        this.isTransferring = false;
        this.activeChild = null;
        try { fs.unlinkSync(scriptPath); } catch {}
        if (broadcast) {
          broadcast('mtp_transfer_error', { error: err.message });
        }
        reject(err);
      });
    });
  }

  cancelTransfer() {
    this.shouldCancel = true;
    if (this.activeChild) {
      try {
        this.activeChild.kill('SIGKILL');
      } catch (e) {
        console.error('[MtpPhoneEngine] Cancel error:', e.message);
      }
    }
    this.isTransferring = false;
  }
}

module.exports = MtpPhoneEngine;
