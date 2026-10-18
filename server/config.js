const path = require('path');
const os = require('os');
const crypto = require('crypto');

const BASE_DIR = path.resolve(__dirname, '..');

const config = {
  // Network configuration
  PORT: process.env.PORT ? parseInt(process.env.PORT, 10) : 4545,
  HOST: '0.0.0.0',

  // Storage directories
  BASE_DIR,
  STORAGE_DIR: process.env.STORAGE_DIR || path.join(BASE_DIR, 'transferred_files'),
  CHUNKS_DIR: process.env.CHUNKS_DIR || path.join(BASE_DIR, '.chunks'),
  CATALOG_FILE: path.join(BASE_DIR, '.transfer-catalog.json'),

  // Chunking parameters (Dynamic Adaptive Bursting)
  CHUNK_SIZE_SMALL: 1 * 1024 * 1024,  // 1MB for photos/documents
  CHUNK_SIZE_LARGE: 4 * 1024 * 1024,  // 4MB for high-res 4K videos / large files
  MAX_CONCURRENT_CHUNKS: 4,           // Parallel streams for maximum LAN/Wire saturation

  // Organization settings
  AUTO_ORGANIZE: true, // Auto-sort into Photos/Videos/Docs/Audio/Others by date
  DEDUPLICATION_ENABLED: true,

  // Security settings
  REQUIRE_PIN: true,
  SESSION_PIN: String(Math.floor(100000 + Math.random() * 900000)), // 6-digit random PIN
  SESSION_TOKEN: crypto.randomBytes(16).toString('hex'), // Token embedded in QR code for 1-scan instant auth
};

// Helper to retrieve all non-internal IPv4 LAN and Wire (USB Tethering) addresses
config.getLanAddresses = function () {
  const interfaces = os.networkInterfaces();
  const addresses = [];

  for (const name of Object.keys(interfaces)) {
    for (const net of interfaces[name]) {
      // Skip internal (127.0.0.1) and non-IPv4 addresses
      if (net.family === 'IPv4' && !net.internal) {
        // Detect Wire (USB Cable / USB Tethering / RNDIS / Apple USB)
        const isWire = /rndis|remote ndis|tether|apple mobile|usb/i.test(name) ||
                       /^192\.168\.42\./.test(net.address) ||
                       /^172\.20\.10\./.test(net.address);
        
        // Detect Wi-Fi vs Ethernet
        const isWiFi = /wi-?fi|wlan|wireless/i.test(name);
        const isEthernet = /eth|ethernet|local area/i.test(name);

        const type = isWire
          ? '⚡ Wire (USB Cable - Max Speed)'
          : isWiFi
          ? '📶 Wi-Fi (Wireless)'
          : isEthernet
          ? '🔌 Ethernet / LAN'
          : '🌐 Network Adapter';

        const priority = isWire ? 0 : isWiFi ? 1 : isEthernet ? 2 : 3;

        addresses.push({
          interface: name,
          address: net.address,
          type,
          isWire,
          priority
        });
      }
    }
  }

  // Sort by priority (Wire USB first, then Wi-Fi, then Ethernet)
  addresses.sort((a, b) => a.priority - b.priority);
  return addresses;
};

module.exports = config;
