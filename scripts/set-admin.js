// កំណត់គណនីជា Admin (សិទ្ធិគ្រប់គ្រងទិន្នន័យទាំងអស់)
// ផ្តល់សិទ្ធិ admin ដល់គណនីធម្មតា:  DATABASE_URL=postgres://... node scripts/set-admin.js you@example.com
// ដកសិទ្ធិ admin:                          node scripts/set-admin.js --remove you@example.com
// បង្កើតគណនី admin ប្រព័ន្ធ (email + password):
//   DATABASE_URL=postgres://... node scripts/set-admin.js --password 'your-password' admin@admin.com
const bcrypt = require('bcrypt');
const db = require('../db');

const args = process.argv.slice(2);
const remove = args[0] === '--remove';
const passMode = args[0] === '--password';
const password = passMode ? String(args[1] || '') : '';
const email = (remove ? args[1] : passMode ? args[2] : args[0] || '').trim().toLowerCase();

if (!email) {
  console.error('ប្រើ: node scripts/set-admin.js <email>');
  console.error('     node scripts/set-admin.js --remove <email>');
  console.error('     node scripts/set-admin.js --password <password> <email>');
  process.exit(1);
}
if (passMode && password.length < 6) {
  console.error('ពាក្យសម្ងាត់ត្រូវមានយ៉ាងតិច 6 តួអក្សរ');
  process.exit(1);
}

(async () => {
  const user = await db.prepare('SELECT id, name, email FROM users WHERE lower(email) = lower(?)').get(email);

  if (remove) {
    if (!user) {
      console.error('រកមិនឃើញគណនី:', email);
      process.exit(1);
    }
    await db.prepare('UPDATE users SET is_admin = 0 WHERE id = ?').run(user.id);
    console.log(`✅ ${user.name} (${user.email}) → is_admin = 0`);
    process.exit(0);
  }

  if (passMode) {
    const hash = await bcrypt.hash(password, 10);
    if (user) {
      await db.prepare('UPDATE users SET is_admin = 1, password_hash = ? WHERE id = ?').run(hash, user.id);
      console.log(`✅ គណនី admin ត្រូវបានធ្វើបច្ចុប្បន្ន: ${email}`);
    } else {
      const pinHash = await bcrypt.hash(String(Math.floor(1000 + Math.random() * 9000)), 10);
      await db.prepare(`INSERT INTO users (name, email, phone, pin_hash, password_hash, auth_provider, is_admin)
        VALUES (?, ?, ?, ?, ?, 'admin', 1)`).run('Admin', email, '+85500000000', pinHash, hash);
      console.log(`✅ គណនី admin ប្រព័ន្ធត្រូវបានបង្កើត: ${email}`);
    }
    process.exit(0);
  }

  if (!user) {
    console.error('រកមិនឃើញគណនី:', email);
    process.exit(1);
  }
  await db.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(user.id);
  console.log(`✅ ${user.name} (${user.email}) → is_admin = 1`);
  process.exit(0);
})().catch((e) => {
  console.error('❌', e.message);
  process.exit(1);
});
