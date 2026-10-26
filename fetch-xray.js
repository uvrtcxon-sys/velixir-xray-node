'use strict';
// Download Xray-core (linux-64) from GitHub Releases and extract the `xray`
// binary using only Node.js built-ins (https + zlib).
// No `unzip` binary, no python, no third-party dependency: the Velixir
// container has neither unzip nor python3, so the zip is parsed by hand
// (Central Directory walk) and inflated with zlib.inflateRawSync.
const fs = require('fs');
const path = require('path');
const https = require('https');
const zlib = require('zlib');

const XRAY_VERSION = 'v26.10.21';
const XRAY_URL = `https://github.com/XTLS/Xray-core/releases/download/${XRAY_VERSION}/Xray-linux-64.zip`;
const BIN_PATH = path.join(__dirname, 'xray');
const TMP_ZIP = path.join(__dirname, 'xray.zip');

function download(url, dest, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('too many redirects'));
    const req = https.get(url, { headers: { 'User-Agent': 'velixir-xray-node' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(download(res.headers.location, dest, redirects + 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`download failed: HTTP ${res.statusCode} for ${url}`));
      }
      const file = fs.createWriteStream(dest);
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
      file.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(120000, () => req.destroy(new Error('download timed out')));
  });
}

// Minimal ZIP reader: walk the Central Directory (correct sizes even when the
// archive uses data descriptors), extract one entry by name.
// Method 0 = stored, 8 = deflate (zlib.inflateRawSync).
function extractEntry(zipBuf, wantedName) {
  // End Of Central Directory is within the last 64 KiB + 22 bytes.
  const scanStart = Math.max(0, zipBuf.length - 22 - 65536);
  let eocd = -1;
  for (let i = zipBuf.length - 22; i >= scanStart; i--) {
    if (zipBuf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip file (EOCD not found)');
  const entries = zipBuf.readUInt16LE(eocd + 10);
  let cdOff = zipBuf.readUInt32LE(eocd + 16);
  for (let n = 0; n < entries; n++) {
    if (zipBuf.readUInt32LE(cdOff) !== 0x02014b50) throw new Error('bad central directory');
    const method = zipBuf.readUInt16LE(cdOff + 10);
    const compSize = zipBuf.readUInt32LE(cdOff + 20);
    const nameLen = zipBuf.readUInt16LE(cdOff + 28);
    const extraLen = zipBuf.readUInt16LE(cdOff + 30);
    const commentLen = zipBuf.readUInt16LE(cdOff + 32);
    const localOff = zipBuf.readUInt32LE(cdOff + 42);
    const name = zipBuf.toString('utf8', cdOff + 46, cdOff + 46 + nameLen);
    if (name === wantedName) {
      if (zipBuf.readUInt32LE(localOff) !== 0x04034b50) throw new Error('bad local file header');
      const lNameLen = zipBuf.readUInt16LE(localOff + 26);
      const lExtraLen = zipBuf.readUInt16LE(localOff + 28);
      const dataOff = localOff + 30 + lNameLen + lExtraLen;
      const comp = zipBuf.subarray(dataOff, dataOff + compSize);
      if (method === 0) return Buffer.from(comp);
      if (method === 8) return zlib.inflateRawSync(comp);
      throw new Error(`unsupported zip method ${method} for ${name}`);
    }
    cdOff += 46 + nameLen + extraLen + commentLen;
  }
  throw new Error(`entry ${wantedName} not found in zip`);
}

async function ensureXray() {
  if (fs.existsSync(BIN_PATH)) {
    try {
      fs.accessSync(BIN_PATH, fs.constants.X_OK);
      console.log('[fetch-xray] xray binary already present');
      return BIN_PATH;
    } catch { /* exists but not executable: re-download */ }
  }
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      console.log(`[fetch-xray] downloading Xray-core ${XRAY_VERSION} (attempt ${attempt}/${maxAttempts}) ...`);
      await download(XRAY_URL, TMP_ZIP);
      const zipBuf = fs.readFileSync(TMP_ZIP);
      if (zipBuf.length < 4 || zipBuf.readUInt32LE(0) !== 0x04034b50) {
        throw new Error('downloaded file is not a zip');
      }
      const bin = extractEntry(zipBuf, 'xray');
      fs.writeFileSync(BIN_PATH, bin, { mode: 0o755 });
      fs.chmodSync(BIN_PATH, 0o755);
      console.log(`[fetch-xray] xray ${XRAY_VERSION} ready (${bin.length} bytes)`);
      return BIN_PATH;
    } catch (err) {
      console.error(`[fetch-xray] attempt ${attempt} failed: ${err.message}`);
      if (attempt === maxAttempts) throw err;
      await new Promise((r) => setTimeout(r, 3000 * attempt));
    } finally {
      try { fs.unlinkSync(TMP_ZIP); } catch { /* ignore */ }
    }
  }
}

if (require.main === module) {
  ensureXray()
    .then(() => process.exit(0))
    .catch((e) => { console.error(e); process.exit(1); });
}

module.exports = { ensureXray, XRAY_VERSION };
