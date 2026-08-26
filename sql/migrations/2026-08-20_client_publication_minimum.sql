-- Enforce the niche-specific minimum time in status "Chosen" before a client
-- may request a publication date. The rule lives on the server as well as in
-- the UI, so changing the date field or calling the RPC directly cannot bypass it.

begin;

create or replace function public.client_publication_wait_days(
  p_client_email text,
  p_status_id text
)
returns integer
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_snapshot jsonb;
  v_anketa jsonb;
  v_state jsonb;
  v_client jsonb;
  v_config jsonb;
  v_niche text := '';
  v_value text := '';
  v_wait integer := 0;
  v_code text := '';
begin
  select snapshot.payload into v_snapshot
  from public.client_snapshots snapshot
  where lower(snapshot.email) = lower(btrim(coalesce(p_client_email, '')));

  select anketa.item into v_anketa
  from jsonb_array_elements(coalesce(v_snapshot -> 'anketas', '[]'::jsonb)) anketa(item)
  where exists (
    select 1
    from jsonb_array_elements(coalesce(anketa.item -> 'statuses', '[]'::jsonb)) status_item
    where status_item ->> 'id' = p_status_id
  )
  limit 1;

  if v_anketa is null then
    return 0;
  end if;

  v_niche := coalesce(v_anketa ->> 'niche', '');
  v_code := lower(translate(
    regexp_replace(coalesce(v_anketa ->> 'code', ''), '[[:space:]-]+', '', 'g'),
    'аА', 'aa'
  ));

  select state.data into v_state
  from public.crm_state state
  where state.id = 'main';

  if v_niche = '' and v_state is not null and v_code <> '' then
    select client.item into v_client
    from jsonb_array_elements(coalesce(v_state -> 'clients', '[]'::jsonb)) client(item)
    where lower(translate(
      regexp_replace(coalesce(client.item ->> 'code', ''), '[[:space:]-]+', '', 'g'),
      'аА', 'aa'
    )) = v_code
    limit 1;
    v_niche := coalesce(v_client ->> 'niche', '');
  end if;

  if v_niche <> '' then
    v_config := v_state -> 'nicheConfig' -> v_niche;
  end if;

  v_value := coalesce(v_config ->> 'clientMinPublicationDays', '');
  if v_value ~ '^[0-9]+$' then
    v_wait := v_value::integer;
  elsif v_niche = 'remont' then
    v_wait := 20;
  else
    v_value := coalesce(v_config ->> 'daysToPublish', '');
    if v_value ~ '^[0-9]+$' then
      v_wait := v_value::integer;
    else
      v_value := coalesce(v_anketa ->> 'publicationWaitDays', '');
      if v_value ~ '^[0-9]+$' then v_wait := v_value::integer; end if;
    end if;
  end if;

  return greatest(0, least(v_wait, 365));
end;
$$;

revoke all on function public.client_publication_wait_days(text, text)
  from public, anon, authenticated;

create or replace function public.enforce_client_publication_minimum()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_wait integer;
  v_minimum date;
  v_today date := (now() at time zone 'Europe/Moscow')::date;
begin
  if NEW.request_status not in ('pending', 'accepted') then
    return NEW;
  end if;

  v_wait := public.client_publication_wait_days(NEW.client_email, NEW.status_id);
  v_minimum := greatest(v_today, NEW.status_date + v_wait);
  if NEW.requested_date < v_minimum then
    raise exception 'PUBLICATION_TOO_EARLY:%:%', v_minimum, v_wait
      using errcode = '22023';
  end if;
  return NEW;
end;
$$;

drop trigger if exists client_publication_minimum_trg
  on public.client_publication_requests;
create trigger client_publication_minimum_trg
  before insert or update of requested_date, request_status, status_date
  on public.client_publication_requests
  for each row execute function public.enforce_client_publication_minimum();

notify pgrst, 'reload schema';

commit;
