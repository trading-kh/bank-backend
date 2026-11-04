// ចាប់ផ្ដើម dev server ក្នុងផ្ទៃដោយមិនបើកផ្ទាំង console (Windows) + សរាយទៅ dev.log
// ប្រើ: npm run dev:bg  →  បិទក្រោយ: npm run dev:stop  →  មើលកំណត់ត្រា: npm run dev:log
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const LOG = path.join(ROOT, 'dev.log');
const PID_FILE = path.join(ROOT, '.dev.pid');

function readPid() {
  try {
    const pid = Number(fs.readFileSync(PID_FILE, 'utf8').trim());
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch (_) {
    return null;
  }
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (_) {
    return false;
  }
}

const old = readPid();
if (old && isAlive(old)) {
  console.log(`ℹ️ មាន dev server កំពុងដំណើរការរួច (PID ${old}) — បិទវាជាមុនដើម្បីចាប់ផ្ដើមថ្មី…`);
  try {
    require('child_process').execFileSync('taskkill', ['/PID', String(old), '/T', '/F'], {
      stdio: 'ignore',
    });
  } catch (_) {}
  try {
    fs.unlinkSync(PID_FILE);
  } catch (_) {}
}

fs.writeFileSync(
  LOG,
  `\n===== ចាប់ផ្ដើម dev server ${new Date().toLocaleString('kh-KH')} =====\n`,
);

const out = fs.openSync(LOG, 'a');
const child = spawn(process.execPath, [path.join(__dirname, 'dev.js')], {
  cwd: ROOT,
  detached: true,
  stdio: ['ignore', out, out],
  windowsHide: true,
});
child.unref();
fs.writeFileSync(PID_FILE, String(child.pid));

console.log(`✅ Dev server កំពុងដំណើរការក្នុងផ្ទៃ (PID ${child.pid}) — គ្មានផ្ទាំង console បើក`);
console.log('🌐 API: http://127.0.0.1:3100   ផ្ទាំង admin: http://127.0.0.1:3100/admin/');
console.log(`📄 កំណត់ត្រា: ${LOG}   (npm run dev:log ដើម្បីមើល)`);
