const assert = require('assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ChunkManager = require('../server/chunkManager');
const FileOrganizer = require('../server/fileOrganizer');

async function runTests() {
  console.log('--- Running Chunk Manager & File Organizer Tests ---');
  const testDir = path.join(__dirname, 'temp-chunk-test');
  const chunksDir = path.join(testDir, '.chunks');
  const storageDir = path.join(testDir, 'transferred');

  if (fs.existsSync(testDir)) {
    fs.rmSync(testDir, { recursive: true, force: true });
  }
  fs.mkdirSync(chunksDir, { recursive: true });
  fs.mkdirSync(storageDir, { recursive: true });

  try {
    // 1. File Organizer Tests
    console.log('Testing File Organizer...');
    const organizer = new FileOrganizer({ storageDir, autoOrganize: true });

    // Test categorization
    const photoPath = organizer.determineDestinationPath({
      name: 'IMG_20261018_120000.HEIC',
      mtime: new Date('2026-10-18T10:00:00Z').getTime()
    });
    assert.ok(photoPath.includes('Photos'), 'HEIC should be categorized as Photos');
    assert.ok(photoPath.includes('2026-10'), 'Should be organized in 2026-10 month folder');
    console.log('✔ Test 1 Passed: Photo HEIC categorized and routed to Photos/2026-10/');

    const videoPath = organizer.determineDestinationPath({
      name: 'vacation_clip.mp4',
      mtime: new Date('2026-05-12T15:30:00Z').getTime()
    });
    assert.ok(videoPath.includes('Videos'), 'MP4 should be categorized as Videos');
    assert.ok(videoPath.includes('2026-05'), 'Should be organized in 2026-05 month folder');
    console.log('✔ Test 2 Passed: Video MP4 categorized and routed to Videos/2026-05/');

    const docPath = organizer.determineDestinationPath({
      name: 'contract.pdf',
      mtime: Date.now()
    });
    assert.ok(docPath.includes('Documents'), 'PDF should be categorized as Documents');
    console.log('✔ Test 3 Passed: Document PDF categorized into Documents/');

    // Test filename sanitization
    const sanitized = organizer.sanitizeFilename('../../../evil:path*name?.jpg');
    assert.strictEqual(sanitized, 'evil_path_name_.jpg', 'Dangerous path and Windows forbidden characters must be sanitized');
    console.log('✔ Test 4 Passed: Filename sanitization handles traversal & illegal characters');

    // 2. Chunk Manager Tests
    console.log('\nTesting Chunk Manager & Resumability...');
    const chunkManager = new ChunkManager({ chunksDir });

    // Generate test data: 3 chunks of 100KB each (total 300KB)
    const chunk0 = crypto.randomBytes(100 * 1024);
    const chunk1 = crypto.randomBytes(100 * 1024);
    const chunk2 = crypto.randomBytes(100 * 1024);
    const fullBuffer = Buffer.concat([chunk0, chunk1, chunk2]);
    const expectedSha256 = crypto.createHash('sha256').update(fullBuffer).digest('hex');

    const fileMeta = {
      fileId: 'test-file-abc-123',
      name: 'sample_video.mp4',
      totalSize: fullBuffer.length,
      totalChunks: 3,
      mtime: Date.now()
    };

    // Initialize upload
    await chunkManager.initUpload(fileMeta);

    // Initial status: 0 uploaded
    let status = await chunkManager.getUploadStatus(fileMeta.fileId);
    assert.strictEqual(status.exists, true);
    assert.strictEqual(status.uploadedChunks.length, 0);

    // Upload chunk 0
    await chunkManager.saveChunk(fileMeta.fileId, 0, chunk0);
    // Upload chunk 2 (out of order upload test)
    await chunkManager.saveChunk(fileMeta.fileId, 2, chunk2);

    // Check status after simulated crash/interruption: should show chunks 0 and 2 uploaded, chunk 1 missing
    status = await chunkManager.getUploadStatus(fileMeta.fileId);
    assert.deepStrictEqual(status.uploadedChunks.sort(), [0, 2]);
    assert.strictEqual(status.isComplete, false);
    console.log('✔ Test 5 Passed: Interrupted state tracked accurately (out of order chunks 0 & 2 preserved)');

    // Resume: now upload missing chunk 1
    await chunkManager.saveChunk(fileMeta.fileId, 1, chunk1);
    status = await chunkManager.getUploadStatus(fileMeta.fileId);
    assert.strictEqual(status.isComplete, true);
    assert.strictEqual(status.uploadedChunks.length, 3);
    console.log('✔ Test 6 Passed: Resumed upload finished all chunks');

    // Assemble file to final destination
    const finalDest = organizer.determineDestinationPath({
      name: fileMeta.name,
      mtime: fileMeta.mtime
    });
    const assembleResult = await chunkManager.assembleFile(fileMeta.fileId, finalDest);

    assert.strictEqual(assembleResult.sha256, expectedSha256, 'Assembled file SHA-256 must match original data');
    assert.strictEqual(assembleResult.size, fullBuffer.length, 'Assembled file size must match original data');
    assert.ok(fs.existsSync(finalDest), 'Final file must exist at destination');

    // Chunks temp folder should be cleaned up
    const chunkDirExists = fs.existsSync(path.join(chunksDir, fileMeta.fileId));
    assert.strictEqual(chunkDirExists, false, 'Temporary chunks folder must be cleaned up after assembly');
    console.log('✔ Test 7 Passed: Atomic assembly, SHA-256 verification and cleanup passed');

    console.log('\nAll Chunk Manager & File Organizer tests PASSED successfully!\n');
  } finally {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  }
}

runTests().catch(err => {
  console.error('Test FAILED:', err);
  process.exit(1);
});
