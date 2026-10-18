const https = require('https');
const fs = require('fs');
const path = require('path');

const API_KEY = process.env.STITCH_API_KEY || process.env.GEMINI_API_KEY || process.argv[2] || '';
if (!API_KEY) {
  console.error('Error: STITCH_API_KEY or CLI argument is required.');
  process.exit(1);
}
const PROJECT_ID = '6420098479487077794';
const SCREEN_IDS = [
  '5af9d9952ce949c9a3d2c2405018804d',
  'fc139b3f1efb41abbb839bb7de3fb7cf'
];

function callMcpTool(name, args) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      jsonrpc: '2.0',
      id: Date.now(),
      method: 'tools/call',
      params: {
        name,
        arguments: args
      }
    });

    const req = https.request('https://stitch.googleapis.com/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': API_KEY,
        'Content-Length': Buffer.byteLength(payload)
      }
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          if (parsed.error) {
            reject(new Error(JSON.stringify(parsed.error)));
          } else {
            resolve(parsed.result);
          }
        } catch (e) {
          reject(new Error(`Failed to parse response: ${body}`));
        }
      });
    });

    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function downloadUrl(url, destPath) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    const getFollow = (currentUrl) => {
      https.get(currentUrl, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          getFollow(res.headers.location);
          return;
        }
        res.pipe(file);
        file.on('finish', () => {
          file.close(resolve);
        });
      }).on('error', (err) => {
        fs.unlink(destPath, () => {});
        reject(err);
      });
    };
    getFollow(url);
  });
}

async function main() {
  console.log('--- Fetching Stitch Project and Screens ---');
  const stitchDir = path.join(__dirname, '..', '.stitch', 'designs');
  fs.mkdirSync(stitchDir, { recursive: true });

  // 1. Fetch Project Details
  try {
    console.log(`Calling get_project for projects/${PROJECT_ID}...`);
    const projectRes = await callMcpTool('get_project', { name: `projects/${PROJECT_ID}` });
    console.log('Project Response received:');
    fs.writeFileSync(path.join(__dirname, '..', '.stitch', 'metadata.json'), JSON.stringify(projectRes, null, 2));
  } catch (err) {
    console.warn('get_project error:', err.message);
  }

  // 2. Fetch each screen
  for (let i = 0; i < SCREEN_IDS.length; i++) {
    const screenId = SCREEN_IDS[i];
    const screenName = `projects/${PROJECT_ID}/screens/${screenId}`;
    console.log(`\nFetching screen [${i + 1}/${SCREEN_IDS.length}]: ${screenName}`);

    const res = await callMcpTool('get_screen', { name: screenName });
    console.log('Screen result:', JSON.stringify(res, null, 2).substring(0, 500));

    // Inspect content or structure
    let screenData = res;
    if (res.content && res.content[0] && res.content[0].text) {
      try {
        screenData = JSON.parse(res.content[0].text);
      } catch {}
    }

    const title = screenData.title || `screen_${i + 1}`;
    const safeTitle = title.toLowerCase().replace(/[^a-z0-9_-]/g, '_');
    const baseFilename = `${i + 1}_${safeTitle}_${screenId.substring(0, 8)}`;

    // Save JSON details
    fs.writeFileSync(path.join(stitchDir, `${baseFilename}.json`), JSON.stringify(screenData, null, 2));

    // Download HTML code
    if (screenData.htmlCode && screenData.htmlCode.downloadUrl) {
      const htmlPath = path.join(stitchDir, `${baseFilename}.html`);
      console.log(`Downloading HTML to ${htmlPath}...`);
      await downloadUrl(screenData.htmlCode.downloadUrl, htmlPath);
      console.log(`✔ HTML downloaded successfully (${fs.statSync(htmlPath).size} bytes)`);
    }

    // Download Screenshot image
    if (screenData.screenshot && screenData.screenshot.downloadUrl) {
      let imgUrl = screenData.screenshot.downloadUrl;
      const width = screenData.width || 1440;
      if (!imgUrl.includes('=w')) {
        imgUrl += `=w${width}`;
      }
      const imgPath = path.join(stitchDir, `${baseFilename}.png`);
      console.log(`Downloading Screenshot to ${imgPath}...`);
      await downloadUrl(imgUrl, imgPath);
      console.log(`✔ Screenshot downloaded successfully (${fs.statSync(imgPath).size} bytes)`);
    }
  }

  console.log('\nAll Stitch screens and code fetched successfully!');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
