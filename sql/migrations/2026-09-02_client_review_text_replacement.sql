-- Let the primary client contact replace a proposed review with a complete
-- alternative in Telegram. The replacement is accepted as the canonical
-- client-approved text and is copied to the exact linked CRM review atomically.

begin;

alter table public.client_text_approval_requests
  add column if not exists original_body text,
  add column if not exists client_replacement_body text;

do $$
begin
  alter table public.client_text_approval_requests
    add constraint client_text_approval_original_body_length_chk
    check (original_body is null or length(original_body) between 1 and 3000);
exception when duplicate_object then null;
end;
$$;

do $$
begin
  alter table public.client_text_approval_requests
    add constraint client_text_approval_replacement_body_length_chk
    check (client_replacement_body is null or length(client_replacement_body) between 1 and 3000);
exception when duplicate_object then null;
end;
$$;

create or replace function public.resolve_client_text_approval(
  p_request_id bigint,
  p_decision text,
  p_telegram_user_id bigint,
  p_telegram_chat_id bigint,
  p_comment text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_decision text := lower(btrim(coalesce(p_decision, '')));
  v_replacement text := btrim(coalesce(p_comment, ''));
  v_request public.client_text_approval_requests;
  v_member public.client_telegram_members;
  v_actor_label text;
  v_state jsonb;
  v_reviews jsonb;
  v_review jsonb;
  v_review_index integer;
  v_now_text text := to_char(
    clock_timestamp() at time zone 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
  );
begin
  if auth.role() <> 'service_role' then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;
  if v_decision not in ('approved', 'changes_requested', 'replacement') then
    raise exception 'DECISION_INVALID' using errcode = '22023';
  end if;
  if v_decision in ('changes_requested', 'replacement') and v_replacement = '' then
    raise exception 'COMMENT_REQUIRED' using errcode = '22023';
  end if;
  if v_decision = 'replacement' and length(v_replacement) > 3000 then
    raise exception 'TEXT_TOO_LONG' using errcode = '22023';
  end if;
  if v_decision <> 'replacement' and length(coalesce(p_comment, '')) > 1500 then
    raise exception 'COMMENT_TOO_LONG' using errcode = '22023';
  end if;

  select * into v_request
  from public.client_text_approval_requests
  where id = p_request_id
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

  select * into v_member
  from public.client_telegram_members
  where telegram_user_id = p_telegram_user_id
    and telegram_chat_id = p_telegram_chat_id
    and lower(portal_email) = lower(v_request.portal_email)
    and is_active and is_text_approver
  for update;
  if v_member.id is null then
    raise exception 'TEXT_APPROVER_REQUIRED' using errcode = '42501';
  end if;

  v_actor_label := coalesce(
    nullif(v_member.contact_label, ''),
    nullif(v_member.telegram_first_name, ''),
    nullif(v_member.telegram_username, ''),
    'Контакт'
  );

  if v_decision = 'replacement' then
    if coalesce(btrim(v_request.source_review_id), '') = '' then
      return jsonb_build_object('ok', false, 'reason', 'LINKED_REVIEW_NOT_FOUND');
    end if;

    select data into v_state
    from public.crm_state
    where id = 'main'
    for update;
    if v_state is null then
      return jsonb_build_object('ok', false, 'reason', 'CRM_STATE_NOT_FOUND');
    end if;

    v_reviews := coalesce(v_state -> 'reviews', '[]'::jsonb);
    select item, (ordinality - 1)::integer
    into v_review, v_review_index
    from jsonb_array_elements(v_reviews) with ordinality as review_item(item, ordinality)
    where item ->> 'id' = v_request.source_review_id
    limit 1;

    if v_review is null then
      return jsonb_build_object('ok', false, 'reason', 'LINKED_REVIEW_NOT_FOUND');
    end if;
    if coalesce(v_request.mentor_id, '') <> ''
       and v_review ->> 'mentorId' is distinct from v_request.mentor_id then
      return jsonb_build_object('ok', false, 'reason', 'LINKED_REVIEW_MISMATCH');
    end if;
    if coalesce(v_request.source_profile_id, '') <> ''
       and v_review ->> 'profileId' is distinct from v_request.source_profile_id then
      return jsonb_build_object('ok', false, 'reason', 'LINKED_REVIEW_MISMATCH');
    end if;

    insert into public.crm_state_history (state_id, data, client_info)
    values ('main', v_state, 'client_review_text_replacement:' || v_request.id::text);

    v_review := v_review || jsonb_build_object(
      'text', v_replacement,
      'textEditedAt', v_now_text,
      'textEditedBy', 'telegram:' || v_member.telegram_user_id::text,
      'textEditSource', 'client_telegram_replacement',
      'clientTextReplacedAt', v_now_text,
      'clientTextReplacedBy', v_actor_label
    );
    v_reviews := jsonb_set(v_reviews, array[v_review_index::text], v_review, false);

    update public.crm_state
    set data = jsonb_set(v_state, '{reviews}', v_reviews, true),
        updated_at = clock_timestamp()
    where id = 'main';
  end if;

  update public.client_text_approval_requests
  set request_status = case when v_decision = 'replacement' then 'approved' else v_decision end,
      body = case when v_decision = 'replacement' then v_replacement else body end,
      original_body = case when v_decision = 'replacement' then body else original_body end,
      client_replacement_body = case
        when v_decision = 'replacement' then v_replacement
        else client_replacement_body
      end,
      updated_at = now(),
      resolved_at = now(),
      resolved_by_member_id = v_member.id,
      resolved_by_telegram_user_id = v_member.telegram_user_id,
      resolved_by_label = v_actor_label,
      resolution_comment = case
        when v_decision = 'changes_requested' then nullif(v_replacement, '')
        else null
      end
  where id = v_request.id and request_status = 'pending'
  returning * into v_request;

  if v_request.id is null then
    return jsonb_build_object('ok', false, 'reason', 'ALREADY_RESOLVED');
  end if;

  update public.notification_outbox
  set status = 'skipped',
      last_error = 'text approval resolved in Telegram'
  where kind = 'client_text_approval'
    and action_ref = v_request.id::text
    and status = 'pending';

  insert into public.client_telegram_audit (
    portal_email, member_id, event_name, actor, details
  ) values (
    v_request.portal_email, v_member.id, 'text_approval_resolved',
    'telegram:' || v_member.telegram_user_id::text,
    jsonb_build_object(
      'request_id', v_request.id,
      'decision', v_decision,
      'source_review_id', v_request.source_review_id,
      'source_profile_id', v_request.source_profile_id
    )
  );

  return jsonb_build_object(
    'ok', true,
    'request_id', v_request.id,
    'status', v_request.request_status,
    'decision', v_decision,
    'text_replaced', v_decision = 'replacement',
    'resolved_by', v_request.resolved_by_label
  );
end;
$$;

revoke all on function public.resolve_client_text_approval(bigint, text, bigint, bigint, text)
  from public, anon, authenticated;
grant execute on function public.resolve_client_text_approval(bigint, text, bigint, bigint, text)
  to service_role;

create or replace function public.notify_owner_text_approval_result()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  owner_chat bigint := 6876234451;
  v_comment text;
  v_replacement text;
  v_message text;
begin
  if OLD.request_status <> 'pending'
     or NEW.request_status not in ('approved', 'changes_requested') then
    return NEW;
  end if;
  v_comment := replace(replace(replace(coalesce(NEW.resolution_comment, ''),
    '&', '&amp;'), '<', '&lt;'), '>', '&gt;');
  v_replacement := replace(replace(replace(coalesce(NEW.client_replacement_body, ''),
    '&', '&amp;'), '<', '&lt;'), '>', '&gt;');
  v_message := case
      when v_replacement <> '' then '✍️ <b>Клиент прислал свой вариант текста</b>'
      when NEW.request_status = 'approved' then '✅ <b>Клиент согласовал текст</b>'
      else '✏️ <b>Клиент прислал правки по тексту</b>'
    end || E'\n'
    || 'Кабинет: ' || coalesce(NEW.portal_email, '—')
    || case when coalesce(NEW.anketa_code, '') <> ''
      then E'\nАнкета: ' || NEW.anketa_code
        || case when coalesce(NEW.anketa_name, '') <> '' then ' · ' || NEW.anketa_name else '' end
      else '' end
    || E'\nОтветил: ' || coalesce(NEW.resolved_by_label, 'контакт')
    || case when v_replacement <> '' then E'\n\nНовый согласованный текст:\n' || v_replacement else '' end
    || case when v_comment <> '' then E'\n\nКомментарий:\n' || v_comment else '' end;

  insert into public.notification_outbox (
    telegram_chat_id, kind, message, status,
    mentor_id, client_email, action_ref
  ) values (
    owner_chat, 'client_text_approval_result', v_message, 'pending',
    NEW.mentor_id, NEW.portal_email, NEW.id::text
  );
  return NEW;
end;
$$;

notify pgrst, 'reload schema';

commit;
