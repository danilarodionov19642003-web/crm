-- ============================================================================
-- add_personal_expense — бот (n8n) добавляет ЛИЧНЫЙ расход владельца.
-- Пишет в crm_state.data.expenses (personal=true, source=bot, createdAt=ISO).
-- owner / service_role only; anon — REVOKE. Обновлено 2026-06-04: + createdAt.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.add_personal_expense(
  p_amount   numeric,
  p_category text DEFAULT 'Прочее личное',
  p_comment  text DEFAULT '',
  p_date     text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_role text; v_id text; v_date text; v_item jsonb; v_count int; v_created text;
BEGIN
  v_role := public._jwt_role();
  IF v_role IS DISTINCT FROM 'owner' AND v_role IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'forbidden: only owner/service_role can add personal expense' USING ERRCODE = '42501';
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'amount must be > 0' USING ERRCODE = '22023';
  END IF;
  v_date := COALESCE(NULLIF(trim(p_date), ''), to_char((now() AT TIME ZONE 'Europe/Moscow')::date, 'YYYY-MM-DD'));
  v_id := 'tg' || left(md5(random()::text || clock_timestamp()::text), 14);
  -- ISO-8601 UTC с миллисекундами и буквой Z (как new Date().toISOString() во фронте)
  v_created := to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  v_item := jsonb_build_object(
    'id', v_id,
    'date', v_date,
    'amount', round(p_amount)::int,
    'category', COALESCE(NULLIF(trim(p_category), ''), 'Прочее личное'),
    'comment', COALESCE(p_comment, ''),
    'personal', true,
    'source', 'bot',
    'createdAt', v_created
  );
  UPDATE public.crm_state
  SET data = jsonb_set(data, '{expenses}', COALESCE(data->'expenses', '[]'::jsonb) || v_item, true),
      updated_at = now()
  WHERE id = 'main';
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count = 0 THEN
    RAISE EXCEPTION 'crm_state row (id=main) not found' USING ERRCODE = 'P0002';
  END IF;
  RETURN jsonb_build_object('ok', true, 'id', v_id, 'date', v_date,
                            'amount', round(p_amount)::int,
                            'category', v_item->>'category', 'createdAt', v_created);
END;
$$;
NOTIFY pgrst, 'reload schema';

GRANT EXECUTE ON FUNCTION public.add_personal_expense(numeric, text, text, text) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.add_personal_expense(numeric, text, text, text) FROM anon, public;
