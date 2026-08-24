-- Clients need one full preparation day after payment/access is arranged.
-- New and moved outreach slots therefore start no earlier than tomorrow.
-- Existing slots for today remain visible and may still be cancelled.

begin;

create or replace function public.manage_client_outreach_slot(
  p_action text,
  p_slot_id bigint default null,
  p_mentor_id text default null,
  p_target_date date default null
)
returns public.client_outreach_slots
language plpgsql
security definer
set search_path = public
as $$
declare
  action_name text := lower(btrim(coalesce(p_action, '')));
  slot_row public.client_outreach_slots;
begin
  perform public.expire_past_client_outreach_slots();

  if action_name in ('add', 'move')
     and (p_target_date is null or p_target_date < current_date + 1) then
    raise exception 'OUTREACH_PREPARATION_DAY' using errcode = '22023';
  end if;

  select * into slot_row
  from public.manage_client_outreach_slot_v1(
    p_action, p_slot_id, p_mentor_id, p_target_date
  );
  return slot_row;
end;
$$;

revoke all on function public.manage_client_outreach_slot(text, bigint, text, date)
  from public, anon;
grant execute on function public.manage_client_outreach_slot(text, bigint, text, date)
  to authenticated;

notify pgrst, 'reload schema';

commit;
