-- Keep client outreach notifications visually consistent and state the
-- operational start time explicitly. The trigger only writes to the isolated
-- notification outbox and never changes CRM state.

begin;

create or replace function public.notify_client_outreach_slot_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_message text;
  v_action_ref text;
  v_anketa_label text;
  v_divider constant text := '━━━━━━━━━━━━━━';
  v_start_note constant text := '🕜 Менеджер начнёт работу с откликом не раньше 13:30 по МСК.';
begin
  if coalesce(NEW.client_email, '') = '' then
    return NEW;
  end if;

  v_anketa_label := replace(replace(replace(
    coalesce(upper(NEW.anketa_code), '—')
      || case when coalesce(NEW.anketa_name, '') <> ''
        then ' · ' || NEW.anketa_name
        else ''
      end,
    '&', '&amp;'), '<', '&lt;'), '>', '&gt;');

  if TG_OP = 'INSERT' and NEW.slot_status = 'scheduled' then
    v_message := '📅 <b>ОТКЛИК ЗАПЛАНИРОВАН</b>' || E'\n'
      || v_divider || E'\n\n'
      || '📋 <b>Анкета:</b> ' || v_anketa_label || E'\n'
      || '🗓 <b>Дата:</b> ' || to_char(NEW.scheduled_date, 'DD.MM.YYYY') || E'\n\n'
      || v_start_note;
    v_action_ref := 'outreach:' || NEW.id::text || ':scheduled:' || NEW.scheduled_date::text;
  elsif TG_OP = 'UPDATE'
        and NEW.slot_status = 'scheduled'
        and OLD.scheduled_date is distinct from NEW.scheduled_date then
    v_message := '🔄 <b>ДАТА ОТКЛИКА ИЗМЕНЕНА</b>' || E'\n'
      || v_divider || E'\n\n'
      || '📋 <b>Анкета:</b> ' || v_anketa_label || E'\n'
      || '🗓 <b>Новая дата:</b> ' || to_char(NEW.scheduled_date, 'DD.MM.YYYY') || E'\n\n'
      || v_start_note;
    v_action_ref := 'outreach:' || NEW.id::text || ':moved:' || NEW.scheduled_date::text;
  elsif TG_OP = 'UPDATE'
        and OLD.slot_status = 'scheduled'
        and NEW.slot_status = 'cancelled' then
    v_message := '❌ <b>ОТКЛИК ОТМЕНЁН</b>' || E'\n'
      || v_divider || E'\n\n'
      || '📋 <b>Анкета:</b> ' || v_anketa_label || E'\n'
      || '🗓 <b>Дата:</b> ' || to_char(OLD.scheduled_date, 'DD.MM.YYYY') || E'\n\n'
      || '↩️ Отклик снова доступен для планирования.';
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
