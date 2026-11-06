#!/usr/bin/env node
// Reset all user balances to 0
// Run: node scripts/reset-balances.js

require('dotenv').config();
const { getDb } = require('../db');

async function main() {
  console.log('🔄 Resetting all user balances to 0...');
  
  const db = getDb();
  
  try {
    // Reset card balances
    const cardResult = await db.prepare('UPDATE cards SET balance = 0').run();
    console.log(`✅ Reset ${cardResult.changes} card balances to 0`);
    
    // Reset goals saved amount
    const goalResult = await db.prepare('UPDATE goals SET saved = 0').run();
    console.log(`✅ Reset ${goalResult.changes} goals saved amount to 0`);
    
    // Verify
    const cards = await db.prepare('SELECT COUNT(*) as count, SUM(balance) as total FROM cards').get();
    console.log(`\n📊 Verification:`);
    console.log(`   Total cards: ${cards.count}`);
    console.log(`   Total balance: $${cards.total || 0}`);
    
    console.log('\n✅ All balances reset successfully!');
    console.log('💡 Users will now only get money when their loan is approved and disbursed.');
    
  } catch (err) {
    console.error('❌ Error:', err.message);
    process.exit(1);
  }
}

main();
