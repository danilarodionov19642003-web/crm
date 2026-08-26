-- Client-facing Telegram confirmations for scheduled outreach slots and every
-- published review. Existing contact preferences remain authoritative.

begin;

drop index if exists public.notification_outbox_client_progress_unique_idx;
create unique index notification_outbox_client_progress_unique_idx
  on public.notification_outbox (kind, action_ref, telegram_chat_id)
  where kind in ('review_published', 'low_reviews', 'order_completed')
    and action_ref is not null and telegram_chat_id is not null;

create or replace function public.queue_client_progress_notification(
  p_portal_email text,
  p_kind text,
  p_message text,
  p_mentor_id text,
  p_profile_id text,
  p_action_ref text,
  p_created_by text default null
)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role text := coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '');
  v_kind text := lower(btrim(coalesce(p_kind, '')));
  v_count int;
begin
  if auth.role() <> 'authenticated' or v_role not in ('owner', 'team') then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;
  if v_kind not in ('review_published', 'low_reviews', 'order_completed')
     or coalesce(btrim(p_portal_email), '') = ''
     or coalesce(btrim(p_message), '') = ''
     or coalesce(btrim(p_action_ref), '') = '' then
    raise exception 'INVALID_ARGUMENTS' using errcode = '22023';
  end if;

  insert into public.notification_outbox (
    client_email, telegram_chat_id, telegram_username,
    kind, message, mentor_id, profile_id, action_ref, status
  )
  select
    lower(btrim(p_portal_email)), member.telegram_chat_id, member.telegram_username,
    v_kind, p_message, p_mentor_id, p_profile_id, btrim(p_action_ref), 'pending'
  from public.client_telegram_members member
  where lower(member.portal_email) = lower(btrim(p_portal_email))
    and member.is_active
    and case v_kind
      when 'review_published' then member.status_notifications
      when 'low_reviews' then member.low_reviews_notifications
      when 'order_completed' then member.order_completed_notifications
      else false
    end
  on conflict do nothing;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.queue_client_progress_notification(
  text, text, text, text, text, text, text
) from public, anon;
grant execute on function public.queue_client_progress_notification(
  text, text, text, text, text, text, text
) to authenticated;

create unique index if not exists notification_outbox_client_schedule_unique_idx
  on public.notification_outbox (kind, action_ref, telegram_chat_id)
  where kind = 'schedule'
    and action_ref is not null and telegram_chat_id is not null;

create or replace function public.notify_client_outreach_slot_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_message text;
  v_action_ref text;
begin
  if coalesce(NEW.client_email, '') = '' then return NEW; end if;

  if TG_OP = 'INSERT' and NEW.slot_status = 'scheduled' then
    v_message := '📅 Отклик запланирован' || E'\n'
      || 'Анкета: ' || coalesce(upper(NEW.anketa_code), '—')
      || case when coalesce(NEW.anketa_name, '') <> '' then ' · ' || NEW.anketa_name else '' end
      || E'\nДата: ' || to_char(NEW.scheduled_date, 'DD.MM.YYYY');
    v_action_ref := 'outreach:' || NEW.id::text || ':scheduled:' || NEW.scheduled_date::text;
  elsif TG_OP = 'UPDATE'
        and NEW.slot_status = 'scheduled'
        and OLD.scheduled_date is distinct from NEW.scheduled_date then
    v_message := '🔄 Отклик перенесён' || E'\n'
      || 'Анкета: ' || coalesce(upper(NEW.anketa_code), '—')
      || case when coalesce(NEW.anketa_name, '') <> '' then ' · ' || NEW.anketa_name else '' end
      || E'\nНовая дата: ' || to_char(NEW.scheduled_date, 'DD.MM.YYYY');
    v_action_ref := 'outreach:' || NEW.id::text || ':moved:' || NEW.scheduled_date::text;
  elsif TG_OP = 'UPDATE'
        and OLD.slot_status = 'scheduled'
        and NEW.slot_status = 'cancelled' then
    v_message := '❌ Запланированный отклик отменён' || E'\n'
      || 'Анкета: ' || coalesce(upper(NEW.anketa_code), '—')
      || case when coalesce(NEW.anketa_name, '') <> '' then ' · ' || NEW.anketa_name else '' end
      || E'\nДата: ' || to_char(OLD.scheduled_date, 'DD.MM.YYYY');
    v_action_ref := 'outreach:' || NEW.id::text || ':cancelled:' || OLD.scheduled_date::text;
  else
    return NEW;
  end if;

  insert into public.notification_outbox (
    client_email, telegram_chat_id, telegram_username,
    kind, message, mentor_id, action_ref, status
  )
  select
    lower(NEW.client_email), member.telegram_chat_id, member.telegram_username,
    'schedule', v_message, NEW.mentor_id, v_action_ref, 'pending'
  from public.client_telegram_members member
  where lower(member.portal_email) = lower(NEW.client_email)
    and member.is_active and member.schedule_notifications
  on conflict do nothing;

  return NEW;
end;
$$;

drop trigger if exists client_outreach_slots_client_notify_trg
  on public.client_outreach_slots;
create trigger client_outreach_slots_client_notify_trg
  after insert or update of scheduled_date, slot_status
  on public.client_outreach_slots
  for each row execute function public.notify_client_outreach_slot_change();

notify pgrst, 'reload schema';

commit;
