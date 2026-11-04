// បិទ dev server ក្នុងផ្ទៃ (kill ដូចមិនអប់រំ + Postgres ដែលជាកូន)
// ប្រើ: npm run dev:stop
const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const PID_FILE = path.join(ROOT, '.dev.pid');

let pid = null;
try {
  pid = Number(fs.readFileSync(PID_FILE, 'utf8').trim());
} catch (_) {}

if (!pid || !Number.isFinite(pid)) {
  console.log('ℹ️ មិនទាន់មាន dev server ដំណើរការ');
  process.exit(0);
}

try {
  execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
  console.log(`🛑 បិទ dev server (PID ${pid}) រួចរាល់`);
} catch (_) {
  console.log(`ℹ️ PID ${pid} មិនទាន់ដំណើរការ`);
}

try {
  fs.unlinkSync(PID_FILE);
} catch (_) {}
