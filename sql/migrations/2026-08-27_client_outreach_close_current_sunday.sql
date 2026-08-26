-- Close every Sunday to new outreach planning starting with 2026-08-30.
-- Existing scheduled rows, including the one already placed on 2026-08-30,
-- are intentionally preserved. Only new or moved scheduled rows are blocked.

begin;

create or replace function public.client_outreach_day_off(p_date date)
returns boolean
language sql
immutable
set search_path = public
as $$
  select p_date is not null
    and p_date >= date '2026-08-30'
    and extract(isodow from p_date) = 7
$$;

revoke all on function public.client_outreach_day_off(date)
  from public, anon, authenticated;

create or replace function public.client_outreach_capacity(p_date date)
returns int
language sql
immutable
set search_path = public
as $$
  select case
    when p_date is null then 0
    when public.client_outreach_day_off(p_date) then 0
    when extract(isodow from p_date) = 6 then 3
    else 7
  end
$$;

revoke all on function public.client_outreach_capacity(date)
  from public, anon, authenticated;

notify pgrst, 'reload schema';

commit;
