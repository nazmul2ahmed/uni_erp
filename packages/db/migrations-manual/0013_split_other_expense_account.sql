-- 0013_split_other_expense_account.sql
-- Decision ACC-007. Account 5900 was provisioned under the name "Inventory Shrinkage/Expiry Expense" but is the
-- "Other Expense" catch-all of 08 3.5 (it is what the default "Other expenses" category posts to). Write-offs now
-- post to 5500. Fix the LABEL of 5900 where doing so cannot rewrite history.
--
-- Safe by construction and idempotent:
--   * only accounts with NO journal entries are renamed -- an account that already carries postings keeps its
--     name (those entries were posted as shrinkage; reclassifying a posted fact needs an adjusting journal,
--     never an edit);
--   * after the rename the WHERE no longer matches, so re-running is a no-op.
-- Runs as the owner role, which bypasses RLS, so it covers every tenant.
UPDATE core.accounts a
SET name = 'Other Expense'
WHERE a.code = '5900'
  AND a.name = 'Inventory Shrinkage/Expiry Expense'
  AND NOT EXISTS (SELECT 1 FROM core.journal_entries je WHERE je.account_id = a.id);
