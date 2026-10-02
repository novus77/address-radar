// Both aliases refer to the same account association and its wallet evidence.
export const TRUSTED_ACCOUNT_WALLET_SQL = "((ea.confidence = 'confirmed' AND w.confidence = 'confirmed') OR (ea.confidence IN ('high', 'confirmed') AND w.confidence = 'high' AND w.source = 'fomolens_manual'))";

export const TRUSTED_FOMO_ACCOUNT_SQL = `(ea.source != 'manual_wallet' AND (
  ea.confidence = 'confirmed' OR EXISTS (
    SELECT 1 FROM wallet_identities w
    WHERE w.account_id = ea.account_id AND ${TRUSTED_ACCOUNT_WALLET_SQL}
  )
))`;
