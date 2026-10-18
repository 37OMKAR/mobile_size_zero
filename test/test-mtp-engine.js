const assert = require('assert');
const MtpPhoneEngine = require('../server/mtpPhoneEngine');

async function runMtpEngineTests() {
  console.log('--- Running MtpPhoneEngine Tests ---');
  const engine = new MtpPhoneEngine();

  // Test 1: Device Detection
  const phones = await engine.detectDevices();
  assert(Array.isArray(phones), 'detectDevices must return an array');
  console.log(`✔ Test 1 Passed: Detected ${phones.length} connected MTP phone(s)`);

  if (phones.length > 0) {
    const p = phones[0];
    console.log(`   Found phone: ${p.name} with ${p.storages.length} storage volumes`);
    assert(p.storages && p.storages.length > 0, 'Phone must have storage volumes');

    // Test 2: Scan folder on the real phone
    const s = p.storages[0];
    if (s.folders && s.folders.length > 0) {
      const fName = s.folders[0];
      const scan = await engine.scanFolder(p.name, s.name, fName);
      assert(typeof scan.totalFiles === 'number', 'totalFiles must be a number');
      console.log(`✔ Test 2 Passed: Scanned ${p.name} -> ${s.name} -> ${fName}: ${scan.totalFiles} files`);
    }
  } else {
    console.log('ℹ Notice: No MTP phone connected during headless test run');
  }

  console.log('All MtpPhoneEngine tests PASSED successfully!\n');
}

if (require.main === module) {
  runMtpEngineTests().catch(err => {
    console.error('MtpPhoneEngine test failed:', err);
    process.exit(1);
  });
}

module.exports = runMtpEngineTests;
