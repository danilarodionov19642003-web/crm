-- Sunday is a company-wide outreach day off starting 2026-09-06.
-- The already scheduled slot on Sunday 2026-08-30 is intentionally preserved.

begin;

create or replace function public.client_outreach_day_off(p_date date)
returns boolean
language sql
immutable
set search_path = public
as $$
  select p_date is not null
    and p_date >= date '2026-09-06'
    and extract(isodow from p_date) = 7
$$;

revoke all on function public.client_outreach_day_off(date)
  from public, anon, authenticated;

create or replace function public.enforce_client_outreach_day_off()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.slot_status = 'scheduled'
     and public.client_outreach_day_off(new.scheduled_date) then
    raise exception 'OUTREACH_DAY_OFF' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

revoke all on function public.enforce_client_outreach_day_off()
  from public, anon, authenticated;

drop trigger if exists client_outreach_slots_day_off_trg
  on public.client_outreach_slots;
create trigger client_outreach_slots_day_off_trg
before insert or update of scheduled_date on public.client_outreach_slots
for each row execute function public.enforce_client_outreach_day_off();

notify pgrst, 'reload schema';

commit;
