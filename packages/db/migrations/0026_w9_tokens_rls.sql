-- KPBooks 0026 -- RLS on w9_upload_tokens + a SECURITY DEFINER function that
-- the public (no-auth) upload route uses to look up a token without setting
-- the tenant GUC.
--
-- The flow on the public side:
--   1. Public route receives token + file
--   2. Calls lookup_w9_token(token) -- runs as table owner, bypasses RLS
--   3. If valid, sets app.current_company GUC to the returned company_id
--   4. From here on, normal RLS-aware queries work (insert worker_document,
--      mark token used, read vendor + company name for the success page)

ALTER TABLE w9_upload_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE w9_upload_tokens FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS w9_upload_tokens_company_isolation ON w9_upload_tokens;
CREATE POLICY w9_upload_tokens_company_isolation ON w9_upload_tokens
  FOR ALL
  USING (company_id = app_current_company())
  WITH CHECK (company_id = app_current_company());

-- SECURITY DEFINER lookup. Returns at most one row matching the token (or zero).
-- We deliberately do NOT return the email, created_by, etc. -- only what the
-- caller needs to set the GUC and then re-query everything else with RLS.
CREATE OR REPLACE FUNCTION lookup_w9_token(p_token text)
RETURNS TABLE(
  token_id uuid,
  company_id uuid,
  vendor_id uuid,
  expires_at timestamp with time zone,
  used_at timestamp with time zone
)
LANGUAGE sql SECURITY DEFINER STABLE AS $$
  SELECT id, company_id, vendor_id, expires_at, used_at
  FROM w9_upload_tokens
  WHERE token = p_token
$$;

-- Since this is called from a no-auth public endpoint, allow any DB role to
-- execute it. The function's body still only returns one row's worth of data
-- and the caller can't pivot from this.
GRANT EXECUTE ON FUNCTION lookup_w9_token(text) TO PUBLIC;
