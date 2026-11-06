-- Reset all user card balances to 0
-- Users will only get money when their loan is approved and disbursed

UPDATE cards SET balance = 0;

-- Also reset goals saved amount to 0
UPDATE goals SET saved = 0;

-- Log the change
SELECT 'All card balances reset to 0' as status, COUNT(*) as cards_updated FROM cards;
