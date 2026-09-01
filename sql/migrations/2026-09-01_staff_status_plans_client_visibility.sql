-- Make status-action dates assigned by CRM staff visible in the web cabinet
-- and Telegram Mini App. The CRM blob remains private: only fields belonging
-- to statuses already present in the client's own snapshot are copied.

begin;

create or replace function public.client_snapshot_with_status_plans(p_payload jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_source_statuses jsonb;
  v_anketas jsonb := '[]'::jsonb;
  v_statuses jsonb;
  v_anketa jsonb;
  v_snapshot_status jsonb;
  v_source_status jsonb;
  v_clean_status jsonb;
  v_target_status text;
  v_planned_date text;
begin
  if p_payload is null
     or jsonb_typeof(coalesce(p_payload -> 'anketas', '[]'::jsonb)) <> 'array' then
    return p_payload;
  end if;

  select coalesce(state.data -> 'profileStatuses', '[]'::jsonb)
  into v_source_statuses
  from public.crm_state state
  where state.id = 'main';

  if v_source_statuses is null or jsonb_typeof(v_source_statuses) <> 'array' then
    return p_payload;
  end if;

  for v_anketa in
    select row_item.item
    from jsonb_array_elements(coalesce(p_payload -> 'anketas', '[]'::jsonb))
      with ordinality as row_item(item, item_order)
    order by row_item.item_order
  loop
    if jsonb_typeof(coalesce(v_anketa -> 'statuses', '[]'::jsonb)) <> 'array' then
      v_anketas := v_anketas || jsonb_build_array(v_anketa);
      continue;
    end if;
    v_statuses := '[]'::jsonb;
    for v_snapshot_status in
      select row_item.item
      from jsonb_array_elements(coalesce(v_anketa -> 'statuses', '[]'::jsonb))
        with ordinality as row_item(item, item_order)
      order by row_item.item_order
    loop
      v_source_status := null;
      select source.item into v_source_status
      from jsonb_array_elements(v_source_statuses) source(item)
      where source.item ->> 'id' = v_snapshot_status ->> 'id'
        and source.item ->> 'mentorId' = v_snapshot_status ->> 'mentorId'
        and source.item ->> 'profileId' = v_snapshot_status ->> 'profileId'
        and source.item ->> 'status' = v_snapshot_status ->> 'status'
        and substring(coalesce(source.item ->> 'date', '') from 1 for 10)
            = substring(coalesce(v_snapshot_status ->> 'date', '') from 1 for 10)
      limit 1;

      v_clean_status := v_snapshot_status
        - 'plannedActionDate' - 'nextActionStatus'
        - 'taskPlanSource' - 'taskPlanSchema';
      v_planned_date := coalesce(v_source_status ->> 'plannedActionDate', '');
      v_target_status := public.client_status_action_target(v_source_status ->> 'status');

      if v_source_status is not null
         and v_planned_date ~ '^\d{4}-\d{2}-\d{2}$'
         and v_target_status is not null then
        v_clean_status := v_clean_status || jsonb_build_object(
          'plannedActionDate', v_planned_date,
          'nextActionStatus', v_target_status,
          'taskPlanSource', case
            when v_source_status ->> 'taskPlanSource' = 'client' then 'client'
            else 'staff'
          end,
          'taskPlanSchema', coalesce(
            nullif(v_source_status ->> 'taskPlanSchema', ''),
            'separate-v1'
          )
        );
      end if;
      v_statuses := v_statuses || jsonb_build_array(v_clean_status);
    end loop;
    v_anketas := v_anketas || jsonb_build_array(
      jsonb_set(v_anketa, '{statuses}', v_statuses, true)
    );
  end loop;

  return jsonb_set(p_payload, '{anketas}', v_anketas, true);
end;
$$;

revoke all on function public.client_snapshot_with_status_plans(jsonb)
  from public, anon, authenticated, service_role;

create or replace function public.enrich_client_snapshot_status_plans()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  NEW.payload := public.client_snapshot_with_status_plans(NEW.payload);
  return NEW;
end;
$$;

revoke all on function public.enrich_client_snapshot_status_plans()
  from public, anon, authenticated, service_role;

drop trigger if exists client_snapshots_status_plans_trg on public.client_snapshots;
create trigger client_snapshots_status_plans_trg
before insert or update of payload on public.client_snapshots
for each row execute function public.enrich_client_snapshot_status_plans();

-- Preserve the existing order and row count while enriching all current
-- snapshots immediately. This also makes A27 visible without waiting for the
-- next CRM save.
do $$
declare
  v_before bigint;
  v_after bigint;
begin
  select count(*) into v_before
  from public.client_snapshots snapshot
  cross join lateral jsonb_array_elements(
    coalesce(snapshot.payload -> 'anketas', '[]'::jsonb)
  ) anketa(item)
  cross join lateral jsonb_array_elements(
    coalesce(anketa.item -> 'statuses', '[]'::jsonb)
  ) status(item);

  with enriched as (
    select snapshot.ctid as row_id,
           public.client_snapshot_with_status_plans(snapshot.payload) as payload
    from public.client_snapshots snapshot
  )
  update public.client_snapshots snapshot
  set payload = enriched.payload,
      updated_at = clock_timestamp()
  from enriched
  where snapshot.ctid = enriched.row_id
    and snapshot.payload is distinct from enriched.payload;

  select count(*) into v_after
  from public.client_snapshots snapshot
  cross join lateral jsonb_array_elements(
    coalesce(snapshot.payload -> 'anketas', '[]'::jsonb)
  ) anketa(item)
  cross join lateral jsonb_array_elements(
    coalesce(anketa.item -> 'statuses', '[]'::jsonb)
  ) status(item);

  if v_before <> v_after then
    raise exception 'CLIENT_SNAPSHOT_STATUS_COUNT_CHANGED:%:%', v_before, v_after;
  end if;
end;
$$;

create or replace function public.client_telegram_payload_with_status_plans(
  p_payload jsonb,
  p_snapshot jsonb
)
returns jsonb
language plpgsql
immutable
set search_path = public
as $$
declare
  v_anketas jsonb := '[]'::jsonb;
  v_statuses jsonb;
  v_mini_anketa jsonb;
  v_snapshot_anketa jsonb;
  v_mini_status jsonb;
  v_snapshot_status jsonb;
  v_clean_status jsonb;
  v_planned_date text;
begin
  if p_payload is null
     or p_snapshot is null
     or jsonb_typeof(coalesce(p_payload -> 'anketas', '[]'::jsonb)) <> 'array'
     or jsonb_typeof(coalesce(p_snapshot -> 'anketas', '[]'::jsonb)) <> 'array' then
    return p_payload;
  end if;

  for v_mini_anketa in
    select row_item.item
    from jsonb_array_elements(coalesce(p_payload -> 'anketas', '[]'::jsonb))
      with ordinality as row_item(item, item_order)
    order by row_item.item_order
  loop
    v_snapshot_anketa := null;
    select source.item into v_snapshot_anketa
    from jsonb_array_elements(coalesce(p_snapshot -> 'anketas', '[]'::jsonb)) source(item)
    where source.item ->> 'mentorId' = v_mini_anketa ->> 'mentor_id'
    limit 1;

    if jsonb_typeof(coalesce(v_mini_anketa -> 'statuses', '[]'::jsonb)) <> 'array' then
      v_anketas := v_anketas || jsonb_build_array(v_mini_anketa);
      continue;
    end if;
    v_statuses := '[]'::jsonb;
    for v_mini_status in
      select row_item.item
      from jsonb_array_elements(coalesce(v_mini_anketa -> 'statuses', '[]'::jsonb))
        with ordinality as row_item(item, item_order)
      order by row_item.item_order
    loop
      v_snapshot_status := null;
      select source.item into v_snapshot_status
      from jsonb_array_elements(
        case
          when jsonb_typeof(coalesce(v_snapshot_anketa -> 'statuses', '[]'::jsonb)) = 'array'
            then coalesce(v_snapshot_anketa -> 'statuses', '[]'::jsonb)
          else '[]'::jsonb
        end
      ) source(item)
      where source.item ->> 'id' = v_mini_status ->> 'id'
        and source.item ->> 'profileId' = v_mini_status ->> 'profile_id'
        and source.item ->> 'status' = v_mini_status ->> 'status'
        and substring(coalesce(source.item ->> 'date', '') from 1 for 10)
            = substring(coalesce(v_mini_status ->> 'date', '') from 1 for 10)
      limit 1;

      v_clean_status := v_mini_status
        - 'planned_action_date' - 'next_action_status' - 'task_plan_source';
      v_planned_date := coalesce(v_snapshot_status ->> 'plannedActionDate', '');
      if v_snapshot_status is not null
         and v_planned_date ~ '^\d{4}-\d{2}-\d{2}$'
         and coalesce(v_snapshot_status ->> 'nextActionStatus', '') <> '' then
        v_clean_status := v_clean_status || jsonb_build_object(
          'planned_action_date', v_planned_date,
          'next_action_status', v_snapshot_status ->> 'nextActionStatus',
          'task_plan_source', case
            when v_snapshot_status ->> 'taskPlanSource' = 'client' then 'client'
            else 'staff'
          end
        );
      end if;
      v_statuses := v_statuses || jsonb_build_array(v_clean_status);
    end loop;
    v_anketas := v_anketas || jsonb_build_array(
      jsonb_set(v_mini_anketa, '{statuses}', v_statuses, true)
    );
  end loop;

  return jsonb_set(p_payload, '{anketas}', v_anketas, true);
end;
$$;

revoke all on function public.client_telegram_payload_with_status_plans(jsonb, jsonb)
  from public, anon, authenticated, service_role;

-- Keep the private, feature-complete v2 delegate intact. The public wrapper
-- adds only the client's own status-plan fields and the existing request data.
create or replace function public.get_client_telegram_calendar(
  p_token text,
  p_from date,
  p_to date
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_portal text;
  v_business_today date := (now() at time zone 'Europe/Moscow')::date;
  v_from date := greatest(coalesce(p_from, v_business_today + 1), v_business_today + 1);
  v_to date := coalesce(p_to, v_business_today + 45);
  v_snapshot jsonb;
  v_payload jsonb;
  v_requests jsonb;
begin
  select ctx.portal_email into v_portal
  from public.client_telegram_webapp_context(p_token) ctx;
  if v_portal is null then
    raise exception 'TOKEN_INVALID_OR_EXPIRED' using errcode = '42501';
  end if;

  select snapshot.payload into v_snapshot
  from public.client_snapshots snapshot
  where lower(snapshot.email) = lower(v_portal);
  if v_snapshot is null then
    raise exception 'PORTAL_NOT_FOUND' using errcode = 'P0002';
  end if;
  v_snapshot := public.client_snapshot_with_status_plans(v_snapshot);

  perform public.expire_past_client_outreach_slots();
  v_payload := public.get_client_telegram_calendar_v2(p_token, v_from, v_to);
  v_payload := public.client_telegram_payload_with_status_plans(v_payload, v_snapshot);

  select coalesce(jsonb_agg(to_jsonb(request_row) order by request_row.updated_at desc), '[]'::jsonb)
  into v_requests
  from (
    select request.id, request.status_id, request.mentor_id, request.profile_id,
           request.status_date, request.current_status, request.target_status,
           request.requested_date, request.request_status,
           request.updated_at, request.resolved_at
    from public.client_publication_requests request
    where lower(request.client_email) = lower(v_portal)
    order by request.updated_at desc
  ) request_row;

  v_payload := jsonb_set(v_payload, '{publication_requests}', v_requests, true);
  v_payload := jsonb_set(v_payload, '{minimum_date}', to_jsonb((v_business_today + 1)::text), true);
  return jsonb_set(v_payload, '{business_today}', to_jsonb(v_business_today::text), true);
end;
$$;

revoke all on function public.get_client_telegram_calendar(text, date, date)
  from public, anon, authenticated, service_role;
grant execute on function public.get_client_telegram_calendar(text, date, date)
  to anon, authenticated;

notify pgrst, 'reload schema';

commit;
