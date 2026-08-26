-- Client status notifications are intentionally narrow: Telegram receives a
-- status event only when an account moves from «Выбрать» to «Выбран».

begin;

create or replace function public.suppress_unselected_client_status_notification()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if NEW.kind = 'status_change'
     and not (
       NEW.old_status = '⭐ Выбрать'
       and NEW.new_status = '🏆 Выбран'
     ) then
    return null;
  end if;
  return NEW;
end;
$$;

drop trigger if exists notification_outbox_selected_status_only_trg
  on public.notification_outbox;
create trigger notification_outbox_selected_status_only_trg
  before insert on public.notification_outbox
  for each row execute function public.suppress_unselected_client_status_notification();

create or replace function public.queue_client_telegram_notification(
  p_portal_email text,
  p_kind text,
  p_message text,
  p_mentor_id text default null,
  p_profile_id text default null,
  p_new_status text default null,
  p_old_status text default null,
  p_created_by text default null
)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role text := coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '');
  v_kind text := lower(coalesce(nullif(btrim(p_kind), ''), 'status_change'));
  v_count int;
begin
  if auth.role() <> 'authenticated' or v_role not in ('owner', 'team') then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;
  if coalesce(btrim(p_portal_email), '') = '' or coalesce(btrim(p_message), '') = '' then
    raise exception 'INVALID_ARGUMENTS' using errcode = '22023';
  end if;
  if v_kind = 'status_change'
     and not (
       p_old_status = '⭐ Выбрать'
       and p_new_status = '🏆 Выбран'
     ) then
    return 0;
  end if;

  insert into public.notification_outbox (
    client_email, telegram_chat_id, telegram_username,
    kind, message, mentor_id, profile_id, new_status, old_status,
    status
  )
  select
    lower(btrim(p_portal_email)), member.telegram_chat_id, member.telegram_username,
    v_kind, p_message, p_mentor_id, p_profile_id, p_new_status, p_old_status,
    'pending'
  from public.client_telegram_members member
  where lower(member.portal_email) = lower(btrim(p_portal_email))
    and member.is_active
    and case v_kind
      when 'schedule' then member.schedule_notifications
      when 'low_reviews' then member.low_reviews_notifications
      when 'order_completed' then member.order_completed_notifications
      else member.status_notifications
    end;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.queue_client_telegram_notification(
  text, text, text, text, text, text, text, text
) from public, anon;
grant execute on function public.queue_client_telegram_notification(
  text, text, text, text, text, text, text, text
) to authenticated;

notify pgrst, 'reload schema';

commit;
