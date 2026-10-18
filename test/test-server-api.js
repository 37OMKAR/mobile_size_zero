const assert = require('assert');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { createAppAndServer } = require('../server/server');

function makeRequest(port, options, postData = null) {
  return new Promise((resolve, reject) => {
    const reqOptions = {
      hostname: '127.0.0.1',
      port,
      path: options.path,
      method: options.method || 'GET',
      headers: options.headers || {}
    };

    const req = http.request(reqOptions, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString();
        try {
          const parsed = JSON.parse(body);
          resolve({ status: res.statusCode, headers: res.headers, body: parsed });
        } catch {
          resolve({ status: res.statusCode, headers: res.headers, raw: body });
        }
      });
    });

    req.on('error', reject);
    if (postData) {
      if (Buffer.isBuffer(postData)) {
        req.write(postData);
      } else if (typeof postData === 'object') {
        req.setHeader('Content-Type', 'application/json');
        req.write(JSON.stringify(postData));
      } else {
        req.write(postData);
      }
    }
    req.end();
  });
}

async function runTests() {
  console.log('--- Running Server API Integration Tests ---');
  const testDir = path.join(__dirname, 'temp-server-test');
  const storageDir = path.join(testDir, 'transferred');
  const chunksDir = path.join(testDir, '.chunks');
  const catalogFile = path.join(testDir, '.catalog.json');

  if (fs.existsSync(testDir)) {
    fs.rmSync(testDir, { recursive: true, force: true });
  }

  // Create server instance on dynamic port 0
  const { app, server, config, deduplicator } = await createAppAndServer({
    PORT: 0,
    STORAGE_DIR: storageDir,
    CHUNKS_DIR: chunksDir,
    CATALOG_FILE: catalogFile,
    REQUIRE_PIN: true
  });

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  console.log(`Test server running on port ${port}`);

  try {
    // 1. Test GET /api/status (Localhost is auto-authenticated)
    const statusRes = await makeRequest(port, { path: '/api/status' });
    assert.strictEqual(statusRes.status, 200);
    assert.ok(statusRes.body.sessionPin, 'Should return session PIN');
    assert.ok(statusRes.body.qrCode, 'Should return QR code data URL');
    assert.ok(statusRes.body.lanAddresses, 'Should return LAN addresses');
    console.log('✔ Test 1 Passed: GET /api/status returns valid system state & QR code');

    // 2. Test Mobile PIN Auth
    const pin = statusRes.body.sessionPin;
    const authFail = await makeRequest(port, {
      path: '/api/auth/verify',
      method: 'POST'
    }, { pin: '000000' });
    assert.strictEqual(authFail.status, 401, 'Invalid PIN should fail');

    const authPass = await makeRequest(port, {
      path: '/api/auth/verify',
      method: 'POST'
    }, { pin });
    assert.strictEqual(authPass.status, 200, 'Valid PIN should succeed');
    const token = authPass.body.token;
    assert.ok(token, 'Should receive session token');
    console.log('✔ Test 2 Passed: PIN authentication verified');

    // 3. Test File Pre-flight & Duplicate check
    const sampleBuffer = crypto.randomBytes(64 * 1024);
    const sampleSha = crypto.createHash('sha256').update(sampleBuffer).digest('hex');
    const fileId = 'test-file-999';

    const checkRes1 = await makeRequest(port, {
      path: '/api/check-file',
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}` }
    }, {
      fileId,
      name: 'vacation_pic.jpg',
      size: sampleBuffer.length,
      totalChunks: 2,
      mtime: Date.now()
    });
    assert.strictEqual(checkRes1.status, 200);
    assert.strictEqual(checkRes1.body.status, 'new', 'New file should have status "new"');
    console.log('✔ Test 3 Passed: Pre-flight check returns status "new"');

    // 4. Test Upload Chunk
    const chunkHalf1 = sampleBuffer.subarray(0, 32 * 1024);
    const chunkHalf2 = sampleBuffer.subarray(32 * 1024);

    const chunkRes1 = await makeRequest(port, {
      path: '/api/upload-chunk',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/octet-stream',
        'x-file-id': fileId,
        'x-chunk-index': '0',
        'x-total-chunks': '2'
      }
    }, chunkHalf1);
    assert.strictEqual(chunkRes1.status, 200);
    assert.strictEqual(chunkRes1.body.chunkIndex, 0);

    // 5. Check resumable status mid-transfer
    const checkRes2 = await makeRequest(port, {
      path: '/api/check-file',
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}` }
    }, {
      fileId,
      name: 'vacation_pic.jpg',
      size: sampleBuffer.length,
      totalChunks: 2,
      mtime: Date.now()
    });
    assert.strictEqual(checkRes2.body.status, 'partial', 'Partially uploaded file should have status "partial"');
    assert.deepStrictEqual(checkRes2.body.uploadedChunks, [0], 'Should report chunk 0 uploaded');
    console.log('✔ Test 4 Passed: Mid-transfer check reports resumable state');

    // Upload remaining chunk
    const chunkRes2 = await makeRequest(port, {
      path: '/api/upload-chunk',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/octet-stream',
        'x-file-id': fileId,
        'x-chunk-index': '1',
        'x-total-chunks': '2'
      }
    }, chunkHalf2);
    assert.strictEqual(chunkRes2.status, 200);

    // 6. Finalize file
    const finalizeRes = await makeRequest(port, {
      path: '/api/finalize-file',
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}` }
    }, { fileId });
    assert.strictEqual(finalizeRes.status, 200);
    assert.strictEqual(finalizeRes.body.sha256, sampleSha, 'Finalized SHA256 must match');
    assert.ok(fs.existsSync(finalizeRes.body.path), 'Assembled file must physically exist');
    console.log('✔ Test 5 Passed: File finalized, assembled and verified on disk');

    // 7. Duplicate detection on re-upload
    const checkResDuplicate = await makeRequest(port, {
      path: '/api/check-file',
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}` }
    }, {
      fileId: 'new-id-same-file',
      name: 'vacation_pic.jpg',
      size: sampleBuffer.length,
      totalChunks: 2,
      sha256: sampleSha,
      mtime: Date.now()
    });
    assert.strictEqual(checkResDuplicate.body.status, 'duplicate', 'Identical file must be detected as duplicate');
    console.log('✔ Test 6 Passed: Duplicate check instantly skips already transferred file');

    console.log('\nAll Server API tests PASSED successfully!\n');
  } finally {
    server.close();
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  }
}

runTests().catch(err => {
  console.error('Server API Test FAILED:', err);
  process.exit(1);
});
