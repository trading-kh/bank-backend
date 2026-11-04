// កំណត់គណនីជា Admin (សិទ្ធិគ្រប់គ្រងទិន្នថយទាំងអស់)
// ប្រើ: DATABASE_URL=postgres://... node scripts/set-admin.js you@example.com
// ដកសិទ្ធិ Admin: node scripts/set-admin.js --remove you@example.com
const db = require('../db');

const args = process.argv.slice(2);
const remove = args[0] === '--remove';
const email = (remove ? args[1] : args[0] || '').trim().toLowerCase();
if (!email) {
  console.error('ប្រើ: node scripts/set-admin.js <email>');
  process.exit(1);
}

(async () => {
  const user = await db.prepare('SELECT id, name, email FROM users WHERE lower(email) = lower(?)').get(email);
  if (!user) {
    console.error('រកមិនឃើញគណនី:', email);
    process.exit(1);
  }
  await db.prepare('UPDATE users SET is_admin = ? WHERE id = ?').run(remove ? 0 : 1, user.id);
  console.log(`✅ ${user.name} (${user.email}) → is_admin = ${remove ? 0 : 1}`);
  process.exit(0);
})().catch((e) => {
  console.error('❌', e.message);
  process.exit(1);
});
