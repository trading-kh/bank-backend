// បង្ហាញ 40 បន្ទាត់ចុងក្នុង dev.log
// ប្រើ: npm run dev:log
const path = require('path');
const fs = require('fs');

const LOG = path.join(__dirname, '..', 'dev.log');
if (!fs.existsSync(LOG)) {
  console.log('ℹ️ មិនទាន់មាន dev.log — ដំណើរ npm run dev:bg ជាមុន');
  process.exit(0);
}
const lines = fs.readFileSync(LOG, 'utf8').split(/\r?\n/);
console.log(lines.slice(-40).join('\n'));
