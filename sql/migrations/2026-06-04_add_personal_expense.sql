-- ============================================================================
-- add_personal_expense — бот (n8n + Gemini) добавляет ЛИЧНЫЙ расход владельца.
-- Пишет в crm_state.data.expenses новый объект с personal = true.
-- Доступ: owner (через UI) ИЛИ service_role (n8n с service-ключом).
--
-- Дата: 2026-06-01
-- Безопасность: SECURITY DEFINER + проверка роли. anon — REVOKE.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.add_personal_expense(
  p_amount   numeric,
  p_category text DEFAULT 'Прочее личное',
  p_comment  text DEFAULT '',
  p_date     text DEFAULT NULL          -- 'YYYY-MM-DD'; NULL → сегодня (МСК)
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_role  text;
  v_id    text;
  v_date  text;
  v_item  jsonb;
  v_count int;
BEGIN
  -- 1. Проверка прав: только owner или service_role (бот).
  v_role := public._jwt_role();
  IF v_role IS DISTINCT FROM 'owner' AND v_role IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'forbidden: only owner/service_role can add personal expense'
      USING ERRCODE = '42501';
  END IF;

  -- 2. Валидация суммы.
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'amount must be > 0' USING ERRCODE = '22023';
  END IF;

  -- 3. Дата: либо переданная, либо сегодня по МСК.
  v_date := COALESCE(
    NULLIF(trim(p_date), ''),
    to_char((now() AT TIME ZONE 'Europe/Moscow')::date, 'YYYY-MM-DD')
  );

  -- 4. id в стиле фронта (короткий, опаковый).
  v_id := 'tg' || left(md5(random()::text || clock_timestamp()::text), 14);

  v_item := jsonb_build_object(
    'id',       v_id,
    'date',     v_date,
    'amount',   round(p_amount)::int,
    'category', COALESCE(NULLIF(trim(p_category), ''), 'Прочее личное'),
    'comment',  COALESCE(p_comment, ''),
    'personal', true,
    'source',   'bot'        -- помечаем что добавил ассистент
  );

  -- 5. Атомарно добавляем в массив expenses + обновляем updated_at.
  --    Если строки main нет или expenses не массив — инициализируем.
  UPDATE public.crm_state
  SET
    data = jsonb_set(
      data,
      '{expenses}',
      COALESCE(data->'expenses', '[]'::jsonb) || v_item,
      true
    ),
    updated_at = now()
  WHERE id = 'main';

  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count = 0 THEN
    RAISE EXCEPTION 'crm_state row (id=main) not found' USING ERRCODE = 'P0002';
  END IF;

  RETURN jsonb_build_object('ok', true, 'id', v_id, 'date', v_date,
                            'amount', round(p_amount)::int,
                            'category', v_item->>'category');
END;
$$;

-- Права: owner/service_role идут как authenticated/service_role в PostgREST.
GRANT EXECUTE ON FUNCTION public.add_personal_expense(numeric, text, text, text)
  TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.add_personal_expense(numeric, text, text, text)
  FROM anon, public;

-- Сбросить кэш схемы PostgREST, чтобы RPC сразу был доступен по REST.
NOTIFY pgrst, 'reload schema';
