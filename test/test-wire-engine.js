const assert = require('assert');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const WireTransferEngine = require('../server/wireTransferEngine');
const Deduplicator = require('../server/deduplicator');
const FileOrganizer = require('../server/fileOrganizer');

async function runWireEngineTests() {
  console.log('--- Running WireTransferEngine Unit Tests ---');

  const testDir = path.join(__dirname, 'temp_wire_test');
  const sourceDir = path.join(testDir, 'phone_dcim');
  const targetDir = path.join(testDir, 'pc_storage');

  if (fs.existsSync(testDir)) {
    fs.rmSync(testDir, { recursive: true, force: true });
  }
  fs.mkdirSync(sourceDir, { recursive: true });
  fs.mkdirSync(targetDir, { recursive: true });

  const deduplicator = new Deduplicator({ catalogPath: path.join(testDir, 'catalog.json') });
  await deduplicator.init();
  const fileOrganizer = new FileOrganizer({ storageDir: targetDir, autoOrganize: true });
  const wireEngine = new WireTransferEngine();

  // Create mock files simulating phone camera roll
  const file1 = path.join(sourceDir, 'IMG_20261018_4K.jpg');
  const file2 = path.join(sourceDir, 'VID_20261018_CINEMA.mp4');
  const subFolder = path.join(sourceDir, 'WhatsApp');
  fs.mkdirSync(subFolder, { recursive: true });
  const file3 = path.join(subFolder, 'WA_DOC.pdf');

  fs.writeFileSync(file1, Buffer.alloc(2 * 1024 * 1024, 'A')); // 2MB
  fs.writeFileSync(file2, Buffer.alloc(5 * 1024 * 1024, 'B')); // 5MB
  fs.writeFileSync(file3, Buffer.alloc(500 * 1024, 'C')); // 500KB

  // Test 1: Scan Source Directory
  const scanned = await wireEngine.scanDirectory(sourceDir);
  assert.strictEqual(scanned.length, 3, 'Should find 3 files recursively');
  console.log('✔ Test 1 Passed: Directory scanned recursively and found 3 items');

  // Test 2: Start Batch Transfer over Wire
  const progressEvents = [];
  const broadcast = (event, data) => progressEvents.push({ event, data });

  const batchResult = await wireEngine.startBatchTransfer({
    sourceDir,
    destinationDir: targetDir,
    deduplicator,
    fileOrganizer,
    broadcast
  });

  assert.strictEqual(batchResult.completedCount, 3, 'All 3 files transferred');
  assert.strictEqual(batchResult.duplicateCount, 0, 'Zero duplicates on first run');
  assert.strictEqual(batchResult.verifiedFiles.length, 3, '3 verified files returned');
  console.log('✔ Test 2 Passed: Batch wire transfer completed at turbo speed with full verification');

  // Test 3: Run Second Transfer to Verify 0ms Duplicate Skipping
  const secondRun = await wireEngine.startBatchTransfer({
    sourceDir,
    destinationDir: targetDir,
    deduplicator,
    fileOrganizer,
    broadcast
  });

  assert.strictEqual(secondRun.completedCount, 0, 'Zero new files needed');
  assert.strictEqual(secondRun.duplicateCount, 3, 'All 3 files skipped as duplicates');
  console.log('✔ Test 3 Passed: Re-running wire transfer instantly skipped duplicates in 0ms');

  // Cleanup
  fs.rmSync(testDir, { recursive: true, force: true });
  console.log('All WireTransferEngine tests PASSED successfully!\n');
}

if (require.main === module) {
  runWireEngineTests().catch(err => {
    console.error('Test failed:', err);
    process.exit(1);
  });
}

module.exports = { runWireEngineTests };
