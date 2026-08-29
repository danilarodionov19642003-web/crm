-- Rename the CRM outreach funnel without losing current or historical statuses.
-- Keep the legacy terminal label in the scheduling guard for old open tabs.

begin;

create or replace function pg_temp.mentori_status_name(p_value text)
returns text
language sql
immutable
as $$
  select case p_value
    when '💬 Диалог Начат' then '💬 Начать диалог'
    when '💬 Диалог Начать' then '💬 Начать диалог'
    when '✅ Диалог Закончен' then '✅ Обменяться'
    when '🎯 Готов' then '🎯 Опубликован'
    else p_value
  end
$$;

create or replace function pg_temp.mentori_status_item(p_item jsonb)
returns jsonb
language sql
stable
as $$
  select
    p_item
    || jsonb_build_object(
      'status', pg_temp.mentori_status_name(p_item ->> 'status')
    )
    || case
      when p_item ? 'nextActionStatus' then jsonb_build_object(
        'nextActionStatus', pg_temp.mentori_status_name(p_item ->> 'nextActionStatus')
      )
      else '{}'::jsonb
    end
    || case
      when jsonb_typeof(p_item -> 'history') = 'array' then jsonb_build_object(
        'history', (
          select coalesce(
            jsonb_agg(
              history_item.item || jsonb_build_object(
                'status', pg_temp.mentori_status_name(history_item.item ->> 'status')
              )
              order by history_item.ordinality
            ),
            '[]'::jsonb
          )
          from jsonb_array_elements(p_item -> 'history') with ordinality
            as history_item(item, ordinality)
        )
      )
      else '{}'::jsonb
    end
$$;

create or replace function pg_temp.mentori_status_array(p_items jsonb)
returns jsonb
language sql
stable
as $$
  select coalesce(
    jsonb_agg(pg_temp.mentori_status_item(status_item.item) order by status_item.ordinality),
    '[]'::jsonb
  )
  from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) with ordinality
    as status_item(item, ordinality)
$$;

create or replace function pg_temp.mentori_snapshot_anketa(p_anketa jsonb)
returns jsonb
language sql
stable
as $$
  select case
    when jsonb_typeof(p_anketa -> 'statuses') = 'array' then
      jsonb_set(
        p_anketa,
        '{statuses}',
        pg_temp.mentori_status_array(p_anketa -> 'statuses'),
        true
      )
    else p_anketa
  end
$$;

create or replace function pg_temp.mentori_snapshot_anketas(p_items jsonb)
returns jsonb
language sql
stable
as $$
  select coalesce(
    jsonb_agg(pg_temp.mentori_snapshot_anketa(anketa.item) order by anketa.ordinality),
    '[]'::jsonb
  )
  from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) with ordinality
    as anketa(item, ordinality)
$$;

-- Explicit recoverable before-state because crm_state has no update trigger.
insert into public.crm_state_history (state_id, data, client_info)
select state.id, state.data, 'migration:2026-08-29_profile_status_labels'
from public.crm_state state
where state.id = 'main'
  and exists (
    select 1
    from jsonb_array_elements(coalesce(state.data -> 'profileStatuses', '[]'::jsonb)) item
    where item ->> 'status' in (
      '💬 Диалог Начат', '💬 Диалог Начать', '✅ Диалог Закончен', '🎯 Готов'
    )
       or item ->> 'nextActionStatus' in (
         '💬 Диалог Начат', '💬 Диалог Начать', '✅ Диалог Закончен', '🎯 Готов'
       )
       or exists (
         select 1
         from jsonb_array_elements(coalesce(item -> 'history', '[]'::jsonb)) history_item
         where history_item ->> 'status' in (
           '💬 Диалог Начат', '💬 Диалог Начать', '✅ Диалог Закончен', '🎯 Готов'
         )
       )
  );

update public.crm_state state
set data = jsonb_set(
      state.data,
      '{profileStatuses}',
      pg_temp.mentori_status_array(state.data -> 'profileStatuses'),
      true
    ),
    updated_at = now()
where state.id = 'main'
  and exists (
    select 1
    from jsonb_array_elements(coalesce(state.data -> 'profileStatuses', '[]'::jsonb)) item
    where item ->> 'status' in (
      '💬 Диалог Начат', '💬 Диалог Начать', '✅ Диалог Закончен', '🎯 Готов'
    )
       or item ->> 'nextActionStatus' in (
         '💬 Диалог Начат', '💬 Диалог Начать', '✅ Диалог Закончен', '🎯 Готов'
       )
       or exists (
         select 1
         from jsonb_array_elements(coalesce(item -> 'history', '[]'::jsonb)) history_item
         where history_item ->> 'status' in (
           '💬 Диалог Начат', '💬 Диалог Начать', '✅ Диалог Закончен', '🎯 Готов'
         )
       )
  );

-- Client cabinets and Telegram Mini App read their own RLS snapshots.
update public.client_snapshots snapshot
set payload = jsonb_set(
      snapshot.payload,
      '{anketas}',
      pg_temp.mentori_snapshot_anketas(snapshot.payload -> 'anketas'),
      true
    ),
    updated_at = now()
where jsonb_typeof(snapshot.payload -> 'anketas') = 'array'
  and exists (
    select 1
    from jsonb_array_elements(snapshot.payload -> 'anketas') anketa
    cross join lateral jsonb_array_elements(coalesce(anketa -> 'statuses', '[]'::jsonb)) status_item
    where status_item ->> 'status' in (
      '💬 Диалог Начат', '💬 Диалог Начать', '✅ Диалог Закончен', '🎯 Готов'
    )
  );

-- The current scheduling implementation delegates to this legacy-named
-- function. Teach it both terminal labels so an old open tab cannot consume
-- an extra slot while the rollout is propagating.
do $$
declare
  v_definition text;
begin
  select pg_get_functiondef(
    'public.manage_client_outreach_slot_v1(text,bigint,text,date)'::regprocedure
  ) into v_definition;

  if position('''🎯 Опубликован''' in v_definition) = 0 then
    v_definition := replace(
      v_definition,
      'not in (''📋 Запланировано'', ''🎯 Готов'')',
      'not in (''📋 Запланировано'', ''🎯 Готов'', ''🎯 Опубликован'')'
    );
    if position('''🎯 Опубликован''' in v_definition) = 0 then
      raise exception 'OUTREACH_STATUS_GUARD_NOT_FOUND';
    end if;
    execute v_definition;
  end if;
end
$$;

notify pgrst, 'reload schema';

commit;
