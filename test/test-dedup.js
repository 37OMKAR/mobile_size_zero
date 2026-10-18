const assert = require('assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const Deduplicator = require('../server/deduplicator');

async function runTests() {
  console.log('--- Running Deduplicator Unit Tests ---');
  const testDir = path.join(__dirname, 'temp-dedup-test');
  const catalogFile = path.join(testDir, '.test-catalog.json');

  // Clean test directory
  if (fs.existsSync(testDir)) {
    fs.rmSync(testDir, { recursive: true, force: true });
  }
  fs.mkdirSync(testDir, { recursive: true });

  try {
    const dedup = new Deduplicator({ catalogFile, storageDir: testDir });
    await dedup.init();

    // 1. Create a dummy file
    const sampleContent = Buffer.from('AirTransfer secure file transfer test content with high entropy: ' + crypto.randomBytes(1024).toString('hex'));
    const testFile1 = path.join(testDir, 'photo1.jpg');
    fs.writeFileSync(testFile1, sampleContent);
    const stat1 = fs.statSync(testFile1);

    // 2. Initial check: should not be duplicate
    const check1 = await dedup.checkDuplicate({
      name: 'photo1.jpg',
      size: stat1.size,
      mtime: stat1.mtimeMs
    });
    assert.strictEqual(check1.isDuplicate, false, 'New file should not be duplicate');
    console.log('✔ Test 1 Passed: New file is not marked as duplicate');

    // 3. Register the file
    const regResult = await dedup.registerFile({
      name: 'photo1.jpg',
      size: stat1.size,
      mtime: stat1.mtimeMs,
      filePath: testFile1
    });
    assert.ok(regResult.sha256, 'Registration should compute SHA-256');
    assert.ok(regResult.quickHash, 'Registration should compute quickHash');
    console.log('✔ Test 2 Passed: File registered with SHA-256 and quickHash');

    // 4. Duplicate check by metadata (exact name, size, mtime)
    const check2 = await dedup.checkDuplicate({
      name: 'photo1.jpg',
      size: stat1.size,
      mtime: stat1.mtimeMs
    });
    assert.strictEqual(check2.isDuplicate, true, 'Same file should be detected as duplicate by metadata');
    console.log('✔ Test 3 Passed: Duplicate detected by exact metadata');

    // 5. Duplicate check by content hash (different filename, same content)
    const check3 = await dedup.checkDuplicate({
      name: 'renamed_copy.jpg',
      size: stat1.size,
      quickHash: regResult.quickHash,
      sha256: regResult.sha256
    });
    assert.strictEqual(check3.isDuplicate, true, 'Renamed file with identical hash should be detected as duplicate');
    assert.strictEqual(check3.reason, 'content_hash', 'Reason should be content_hash');
    console.log('✔ Test 4 Passed: Duplicate detected by content hash even with different name');

    // 6. Persistence check: reload deduplicator from catalog file
    const dedupReloaded = new Deduplicator({ catalogFile, storageDir: testDir });
    await dedupReloaded.init();
    const check4 = await dedupReloaded.checkDuplicate({
      name: 'photo1.jpg',
      size: stat1.size,
      mtime: stat1.mtimeMs
    });
    assert.strictEqual(check4.isDuplicate, true, 'Reloaded catalog should retain duplicate knowledge');
    console.log('✔ Test 5 Passed: Catalog persistence verified');

    // 7. Directory sync: index an external file that wasn't in catalog
    const testFile2 = path.join(testDir, 'external_doc.pdf');
    fs.writeFileSync(testFile2, Buffer.from('External document imported via USB or manual copy'));
    const scanCount = await dedupReloaded.scanAndIndexDirectory(testDir);
    assert.ok(scanCount >= 1, 'Scan should index previously untracked files');

    const stat2 = fs.statSync(testFile2);
    const check5 = await dedupReloaded.checkDuplicate({
      name: 'external_doc.pdf',
      size: stat2.size,
      mtime: stat2.mtimeMs
    });
    assert.strictEqual(check5.isDuplicate, true, 'Scanned external file should now be in duplicate index');
    console.log('✔ Test 6 Passed: Directory sync & index works seamlessly');

    console.log('\nAll Deduplicator tests PASSED successfully!\n');
  } finally {
    // Cleanup
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  }
}

runTests().catch(err => {
  console.error('Test FAILED:', err);
  process.exit(1);
});
