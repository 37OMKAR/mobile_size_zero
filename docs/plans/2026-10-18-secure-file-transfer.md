# Secure Resumable Mobile-to-PC File Transfer Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a high-speed, secure, crash-resilient local Wi-Fi file transfer application with zero-install mobile PWA, resumable chunked streaming, smart dual-check duplicate detection, and automated media organization on PC.

**Architecture:** A local Node.js Express + WebSocket server running on the PC auto-detects LAN IPs and presents a QR Code + PIN for authentication. A lightweight, responsive Mobile PWA connects via mobile browser, slices large files into 2MB-4MB chunks, checks duplicates pre-flight with PC index, uploads chunks concurrently with auto-resume on interruption, and acquires a Screen Wake Lock to avoid sleep. The PC server streams chunks, verifies SHA-256 integrity, deduplicates files, and organizes them into categorized folders (Photos, Videos, Documents, etc.).

**Tech Stack:** Node.js (v24), Express, WebSockets (`ws`), Vanilla CSS/HTML/JS (PWA, Web Crypto API, Screen WakeLock API, QR Code generator, Streams).

---

### Task 1: Initialize Project & Dependencies

**Files:**
- Create: `package.json`
- Create: `server/config.js`

**Step 1: Write `package.json` with required dependencies**
Define scripts, `express`, `ws`, `qrcode`, and dev tools.

**Step 2: Install dependencies with npm**
Run: `npm install`
Expected: Dependencies installed successfully with 0 vulnerabilities.

**Step 3: Create configuration module (`server/config.js`)**
Setup ports (default 4545), upload destination (`./transferred_files`), temp chunks dir (`./.chunks`), token expiration, and organization settings.

---

### Task 2: Core Deduplication & Catalog Engine (`server/deduplicator.js`)

**Files:**
- Create: `server/deduplicator.js`
- Test: `test/test-dedup.js`

**Step 1: Write failing unit test for deduplicator**
Test:
- Indexing an empty folder
- Detecting duplicate by exact Name + Size + Timestamp
- Detecting duplicate by Quick Hash (64KB sample) and Full SHA-256
- Returning `duplicate: true` with existing path when matching file is registered

**Step 2: Run test to verify it fails**
Run: `node test/test-dedup.js`
Expected: FAIL (module not implemented)

**Step 3: Implement `server/deduplicator.js`**
Features:
- Fast metadata lookup (size + mtime)
- Partial quick-hash calculator (first, middle, last 64KB) for rapid pre-check without reading gigabytes
- Full SHA-256 streaming hash verification for confirmed exact match
- Persistent index saved to `.transfer-catalog.json`
- Directory scan & sync on startup

**Step 4: Run test to verify it passes**
Run: `node test/test-dedup.js`
Expected: PASS with 100% assertions met.

---

### Task 3: Chunked Resumable Upload Engine & File Organizer

**Files:**
- Create: `server/chunkManager.js`
- Create: `server/fileOrganizer.js`
- Test: `test/test-chunk-engine.js`

**Step 1: Write failing test for chunk manager & file organizer**
Test:
- Pre-flight check: query upload status of new file vs partially uploaded file
- Append chunks in arbitrary sequence
- Finalize file assembly and verify SHA-256 checksum
- Auto-categorize into `Photos/YYYY-MM/` or `Videos/` based on MIME type & modified date
- Test resume: simulate crash after 3 chunks, upload remaining 2 chunks, verify assembled file matches original

**Step 2: Run test to verify it fails**
Run: `node test/test-chunk-engine.js`
Expected: FAIL

**Step 3: Implement `server/chunkManager.js` and `server/fileOrganizer.js`**
- Atomic chunk writes with validation
- Resumable state map stored in `.chunks/metadata.json`
- Assembled stream pipe with cleanup of temporary chunk slices
- Safe filename sanitization preventing path traversal
- Date & category sorting logic

**Step 4: Run test to verify it passes**
Run: `node test/test-chunk-engine.js`
Expected: PASS

---

### Task 4: Express REST API & WebSocket Telemetry Server

**Files:**
- Create: `server/server.js`
- Test: `test/test-server-api.js`

**Step 1: Write API integration tests**
Test:
- `GET /api/status`: returns PC network info, free disk space, transfer stats
- `POST /api/auth/verify`: PIN authentication
- `POST /api/check-file`: returns duplicate status or missing chunk list
- `POST /api/upload-chunk`: uploads binary chunk with chunk index
- `POST /api/finalize-file`: triggers assembly, deduplication registration, and organization
- WebSocket connection: broadcasts real-time transfer progress, speed, and events

**Step 2: Implement `server/server.js`**
- Local IP detection across network adapters (Wi-Fi, Ethernet)
- Dynamic QR code generation for one-tap mobile connection
- Session PIN & security headers
- Streaming chunk receiver endpoint (handling raw binary buffer or multipart)
- WebSocket server on same HTTP port for live sync between PC and phone

**Step 3: Run integration test**
Run: `node test/test-server-api.js`
Expected: PASS

---

### Task 5: High-Speed Resumable Mobile PWA Frontend

**Files:**
- Create: `public/mobile.html`
- Create: `public/css/mobile.css`
- Create: `public/js/chunkUploader.js`
- Create: `public/js/mobileApp.js`
- Create: `public/manifest.json`

**Step 1: Implement Client-Side Chunker & Resumable Queue (`chunkUploader.js`)**
- Browser `File.slice()` into 2MB chunks
- Pre-flight duplicate check against server
- Concurrency manager (2-3 parallel chunk streams for maximum LAN throughput)
- Auto-retry on failed chunk (up to 5 retries with exponential backoff)
- Progress calculation (Bytes sent, instantaneous MB/s, ETA)
- Screen Wake Lock API integration (`navigator.wakeLock`) to prevent mobile OS sleep during long transfers

**Step 2: Build Native-Feeling Touch UI (`mobile.html` & `mobile.css`)**
- Modern dark mode styling with smooth glassmorphism and haptic-like animations
- One-tap buttons: "Photos & Videos", "All Files / Docs", "Folders"
- Transfer queue with status tags: `[Duplicate Skipped]`, `[Uploading 45MB/s]`, `[Verified]`, `[Resuming...]`
- Clear statistics: Total files, Skipped duplicates, Transferred size, Transfer speed
- Pause, Resume All, Cancel controls

---

### Task 6: PC Desktop Dashboard Hub

**Files:**
- Create: `public/pc.html`
- Create: `public/css/pc.css`
- Create: `public/js/pcApp.js`
- Create: `public/index.html` (auto-redirect to mobile if User-Agent is phone/tablet, or PC dashboard if desktop)

**Step 1: Build PC Control Hub UI & Logic**
- Display prominent QR Code and direct URL with quick-copy
- Show active Session PIN with option to regenerate or toggle open LAN mode
- Live speed speedometer / bandwidth graph
- Real-time disk storage gauge (free space vs transferred space)
- Live incoming files stream with instant "Open Folder" / download actions
- Deduplication history log showing saved time & bandwidth from skipped duplicates
- Settings panel: customize destination folder, toggle auto-organization rules

---

### Task 7: End-to-End Testing & Verification with Simulated Network Drops

**Files:**
- Create: `test/test-e2e-simulation.js`
- Create: `start.bat` (Windows 1-click launcher)

**Step 1: Write comprehensive stress & resilience test**
- Simulate transferring 50 mixed files (images, large video mock files)
- Simulate a network disconnect halfway through a large file
- Reconnect and verify the client resumes from the interrupted chunk without data loss
- Run duplicate pass: re-submit same 50 files and verify 100% are recognized as duplicates and skipped instantaneously with 0 data re-uploaded
- Verify final file hashes on PC match source test files

**Step 2: Run simulation test**
Run: `node test/test-e2e-simulation.js`
Expected: PASS with 0 corruption, full resume, and 100% duplicate skip.

**Step 3: Verification with Browser Subagent**
- Launch server
- Use `browser_subagent` to visually test PC dashboard and Mobile view, take screenshots, test UI responsiveness.
