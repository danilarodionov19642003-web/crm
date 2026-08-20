-- Link a client text-approval request to the exact CRM review that created it.
-- The source review id is an idempotency key: retries never send the same text twice.

begin;

alter table public.client_text_approval_requests
  add column if not exists source_review_id text,
  add column if not exists source_revision integer not null default 1;

create index if not exists client_text_approvals_source_idx
  on public.client_text_approval_requests (source_review_id, source_revision desc)
  where source_review_id is not null;

create unique index if not exists client_text_approvals_source_revision_uidx
  on public.client_text_approval_requests (lower(portal_email), source_review_id, source_revision)
  where source_review_id is not null;

create or replace function public.create_review_text_approval(
  p_portal_email text,
  p_mentor_id text,
  p_source_review_id text,
  p_title text,
  p_body text
)
returns public.client_text_approval_requests
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role text := coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '');
  v_portal text := lower(btrim(coalesce(p_portal_email, '')));
  v_source_review_id text := btrim(coalesce(p_source_review_id, ''));
  v_snapshot jsonb;
  v_anketa jsonb;
  v_member public.client_telegram_members;
  v_existing public.client_text_approval_requests;
  v_request public.client_text_approval_requests;
  v_revision integer := 1;
  v_safe_title text;
  v_safe_body text;
  v_message text;
begin
  if auth.role() <> 'authenticated' or v_role not in ('owner', 'team') then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;
  if v_portal = '' or v_source_review_id = '' or coalesce(btrim(p_body), '') = '' then
    raise exception 'INVALID_ARGUMENTS' using errcode = '22023';
  end if;
  if length(v_source_review_id) > 200 then
    raise exception 'SOURCE_REVIEW_ID_TOO_LONG' using errcode = '22023';
  end if;
  if length(btrim(p_body)) > 3000 then
    raise exception 'TEXT_TOO_LONG' using errcode = '22023';
  end if;
  if length(coalesce(nullif(btrim(p_title), ''), 'Текст отзыва')) > 200 then
    raise exception 'TITLE_TOO_LONG' using errcode = '22023';
  end if;

  -- Serialize all retries for one CRM review before checking for an existing row.
  perform pg_advisory_xact_lock(hashtextextended(v_portal || ':' || v_source_review_id, 0));

  select payload into v_snapshot
  from public.client_snapshots
  where lower(email) = v_portal;
  if v_snapshot is null then
    raise exception 'PORTAL_NOT_FOUND' using errcode = 'P0002';
  end if;

  if coalesce(btrim(p_mentor_id), '') <> '' then
    select item into v_anketa
    from jsonb_array_elements(coalesce(v_snapshot -> 'anketas', '[]'::jsonb)) item
    where item ->> 'mentorId' = p_mentor_id
    limit 1;
    if v_anketa is null then
      raise exception 'ANKETA_NOT_FOUND' using errcode = 'P0002';
    end if;
  end if;

  select * into v_member
  from public.client_telegram_members
  where lower(portal_email) = v_portal
    and is_active and is_text_approver
  order by id
  limit 1;

  select * into v_existing
  from public.client_text_approval_requests
  where lower(portal_email) = v_portal
    and source_review_id = v_source_review_id
  order by source_revision desc, id desc
  limit 1
  for update;

  if v_existing.id is not null
     and v_existing.request_status <> 'cancelled'
     and v_existing.mentor_id is not distinct from nullif(btrim(p_mentor_id), '')
     and v_existing.title = coalesce(nullif(btrim(p_title), ''), 'Текст отзыва')
     and v_existing.body = btrim(p_body) then
    -- The request already exists. If Telegram was linked later, deliver it once now.
    if v_existing.request_status = 'pending'
       and v_existing.delivered_to_member_id is null
       and v_member.id is not null then
      update public.client_text_approval_requests
      set delivered_to_member_id = v_member.id,
          delivered_to_telegram_user_id = v_member.telegram_user_id,
          updated_at = now()
      where id = v_existing.id
      returning * into v_existing;

      v_safe_title := replace(replace(replace(v_existing.title,
        '&', '&amp;'), '<', '&lt;'), '>', '&gt;');
      v_safe_body := replace(replace(replace(v_existing.body,
        '&', '&amp;'), '<', '&lt;'), '>', '&gt;');
      v_message := '📝 <b>' || v_safe_title || '</b>' || E'\n'
        || case when coalesce(v_existing.anketa_code, '') <> ''
          then 'Анкета: <b>'
            || replace(replace(replace(v_existing.anketa_code, '&', '&amp;'), '<', '&lt;'), '>', '&gt;')
            || '</b>'
            || case when coalesce(v_existing.anketa_name, '') <> ''
              then ' · ' || replace(replace(replace(v_existing.anketa_name, '&', '&amp;'), '<', '&lt;'), '>', '&gt;')
              else '' end
            || E'\n\n'
          else E'\n'
        end
        || v_safe_body || E'\n\n'
        || 'Проверьте текст и выберите действие.';

      insert into public.notification_outbox (
        client_email, telegram_chat_id, telegram_username,
        kind, message, status, mentor_id, action_ref
      ) values (
        v_portal, v_member.telegram_chat_id, v_member.telegram_username,
        'client_text_approval', v_message, 'pending',
        v_existing.mentor_id, v_existing.id::text
      );

      insert into public.client_telegram_audit (
        portal_email, member_id, event_name, actor, details
      ) values (
        v_portal, v_member.id, 'text_approval_delivered',
        lower(coalesce(auth.jwt() ->> 'email', v_role)),
        jsonb_build_object(
          'request_id', v_existing.id,
          'source_review_id', v_source_review_id,
          'source_revision', v_existing.source_revision
        )
      );
    end if;
    return v_existing;
  end if;

  if v_existing.id is not null and v_existing.request_status = 'pending' then
    raise exception 'TEXT_APPROVAL_ALREADY_PENDING' using errcode = 'P0001';
  end if;
  if v_existing.id is not null then
    v_revision := v_existing.source_revision + 1;
  end if;

  insert into public.client_text_approval_requests (
    portal_email, mentor_id, anketa_code, anketa_name,
    title, body, request_status,
    delivered_to_member_id, delivered_to_telegram_user_id,
    created_by, source_review_id, source_revision
  ) values (
    v_portal, nullif(btrim(p_mentor_id), ''),
    v_anketa ->> 'code', v_anketa ->> 'name',
    coalesce(nullif(btrim(p_title), ''), 'Текст отзыва'),
    btrim(p_body), 'pending',
    v_member.id, v_member.telegram_user_id,
    lower(coalesce(auth.jwt() ->> 'email', v_role)),
    v_source_review_id, v_revision
  ) returning * into v_request;

  if v_member.id is not null then
    v_safe_title := replace(replace(replace(v_request.title,
      '&', '&amp;'), '<', '&lt;'), '>', '&gt;');
    v_safe_body := replace(replace(replace(v_request.body,
      '&', '&amp;'), '<', '&lt;'), '>', '&gt;');
    v_message := '📝 <b>' || v_safe_title || '</b>' || E'\n'
      || case when coalesce(v_request.anketa_code, '') <> ''
        then 'Анкета: <b>'
          || replace(replace(replace(v_request.anketa_code, '&', '&amp;'), '<', '&lt;'), '>', '&gt;')
          || '</b>'
          || case when coalesce(v_request.anketa_name, '') <> ''
            then ' · ' || replace(replace(replace(v_request.anketa_name, '&', '&amp;'), '<', '&lt;'), '>', '&gt;')
            else '' end
          || E'\n\n'
        else E'\n'
      end
      || v_safe_body || E'\n\n'
      || 'Проверьте текст и выберите действие.';

    insert into public.notification_outbox (
      client_email, telegram_chat_id, telegram_username,
      kind, message, status, mentor_id, action_ref
    ) values (
      v_portal, v_member.telegram_chat_id, v_member.telegram_username,
      'client_text_approval', v_message, 'pending',
      v_request.mentor_id, v_request.id::text
    );
  end if;

  insert into public.client_telegram_audit (
    portal_email, member_id, event_name, actor, details
  ) values (
    v_portal, v_member.id, 'text_approval_created',
    lower(coalesce(auth.jwt() ->> 'email', v_role)),
    jsonb_build_object(
      'request_id', v_request.id,
      'mentor_id', v_request.mentor_id,
      'source_review_id', v_source_review_id,
      'source_revision', v_request.source_revision,
      'telegram_delivered', v_member.id is not null
    )
  );

  return v_request;
end;
$$;

revoke all on function public.create_review_text_approval(text, text, text, text, text)
  from public, anon;
grant execute on function public.create_review_text_approval(text, text, text, text, text)
  to authenticated;

create or replace function public.resolve_my_client_text_approval(
  p_request_id bigint,
  p_decision text,
  p_comment text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_decision text := lower(btrim(coalesce(p_decision, '')));
  v_portal text := public.current_client_portal_email();
  v_request public.client_text_approval_requests;
  v_actor text := lower(coalesce(auth.jwt() ->> 'email', 'client'));
begin
  if auth.role() <> 'authenticated'
     or coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') <> 'client'
     or coalesce(v_portal, '') = '' then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;
  if v_decision not in ('approved', 'changes_requested') then
    raise exception 'DECISION_INVALID' using errcode = '22023';
  end if;
  if v_decision = 'changes_requested' and coalesce(btrim(p_comment), '') = '' then
    raise exception 'COMMENT_REQUIRED' using errcode = '22023';
  end if;
  if length(coalesce(p_comment, '')) > 1500 then
    raise exception 'COMMENT_TOO_LONG' using errcode = '22023';
  end if;

  select * into v_request
  from public.client_text_approval_requests
  where id = p_request_id and lower(portal_email) = lower(v_portal)
  for update;
  if v_request.id is null then
    return jsonb_build_object('ok', false, 'reason', 'REQUEST_NOT_FOUND');
  end if;
  if v_request.request_status <> 'pending' then
    return jsonb_build_object(
      'ok', false,
      'reason', 'ALREADY_RESOLVED',
      'status', v_request.request_status,
      'resolved_by', v_request.resolved_by_label
    );
  end if;

  update public.client_text_approval_requests
  set request_status = v_decision,
      updated_at = now(),
      resolved_at = now(),
      resolved_by_label = 'Личный кабинет',
      resolution_comment = nullif(btrim(p_comment), '')
  where id = v_request.id and request_status = 'pending'
  returning * into v_request;

  if v_request.id is null then
    return jsonb_build_object('ok', false, 'reason', 'ALREADY_RESOLVED');
  end if;

  -- If the client answered in the cabinet before the Telegram worker picked
  -- up the message, do not deliver stale action buttons afterwards.
  update public.notification_outbox
  set status = 'skipped',
      last_error = 'resolved in client portal'
  where kind = 'client_text_approval'
    and action_ref = v_request.id::text
    and status = 'pending';

  insert into public.client_telegram_audit (
    portal_email, member_id, event_name, actor, details
  ) values (
    v_request.portal_email, null, 'text_approval_resolved',
    'client_portal:' || v_actor,
    jsonb_build_object(
      'request_id', v_request.id,
      'decision', v_decision,
      'source_review_id', v_request.source_review_id
    )
  );

  return jsonb_build_object(
    'ok', true,
    'request_id', v_request.id,
    'status', v_request.request_status,
    'resolved_by', v_request.resolved_by_label
  );
end;
$$;

revoke all on function public.resolve_my_client_text_approval(bigint, text, text)
  from public, anon;
grant execute on function public.resolve_my_client_text_approval(bigint, text, text)
  to authenticated;

create or replace function public.cancel_review_text_approval(p_source_review_id text)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role text := coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '');
  v_request public.client_text_approval_requests;
  v_count integer := 0;
begin
  if auth.role() <> 'authenticated' or v_role not in ('owner', 'team') then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;
  if coalesce(btrim(p_source_review_id), '') = '' then
    raise exception 'INVALID_ARGUMENTS' using errcode = '22023';
  end if;

  for v_request in
    select *
    from public.client_text_approval_requests
    where source_review_id = btrim(p_source_review_id)
      and request_status <> 'cancelled'
    order by id
    for update
  loop
    v_count := v_count + 1;
    update public.client_text_approval_requests
    set request_status = 'cancelled',
        updated_at = now(),
        resolved_at = now(),
        resolved_by_label = 'CRM'
    where id = v_request.id;
    update public.notification_outbox
    set status = 'skipped',
        last_error = 'approval cancelled in CRM'
    where kind = 'client_text_approval'
      and action_ref = v_request.id::text
      and status = 'pending';
    insert into public.client_telegram_audit (
      portal_email, member_id, event_name, actor, details
    ) values (
      v_request.portal_email, v_request.delivered_to_member_id,
      'text_approval_cancelled',
      lower(coalesce(auth.jwt() ->> 'email', v_role)),
      jsonb_build_object(
        'request_id', v_request.id,
        'source_review_id', v_request.source_review_id,
        'previous_status', v_request.request_status
      )
    );
  end loop;
  return v_count;
end;
$$;

revoke all on function public.cancel_review_text_approval(text) from public, anon;
grant execute on function public.cancel_review_text_approval(text) to authenticated;

notify pgrst, 'reload schema';

commit;
