-- Links global CRM income records to owner-only development projects.
-- The income itself stays in crm_state, so finance totals keep one source of truth.

begin;

create table if not exists public.development_project_income_links (
  income_id text primary key check (char_length(btrim(income_id)) between 1 and 200),
  project_id uuid not null references public.development_projects(id) on delete cascade,
  created_by uuid not null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists development_project_income_links_project_idx
  on public.development_project_income_links (project_id, created_at desc);

alter table public.development_project_income_links enable row level security;

drop policy if exists development_project_income_links_owner_all
  on public.development_project_income_links;
create policy development_project_income_links_owner_all
  on public.development_project_income_links
  for all to authenticated
  using ((auth.jwt() -> 'app_metadata' ->> 'role') = 'owner')
  with check ((auth.jwt() -> 'app_metadata' ->> 'role') = 'owner');

grant select, insert, update, delete
  on public.development_project_income_links to authenticated;
grant all on public.development_project_income_links to service_role;

drop trigger if exists development_project_income_links_touch_updated_at
  on public.development_project_income_links;
create trigger development_project_income_links_touch_updated_at
  before update on public.development_project_income_links
  for each row execute function public.touch_development_project_updated_at();

create or replace function public.list_development_project_payments(
  p_project_id uuid default null
)
returns table (
  project_id uuid,
  income_id text,
  payment_date date,
  client_name text,
  service_name text,
  amount numeric,
  comment text,
  linked_at timestamptz
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') <> 'owner' then
    raise exception 'owner role required' using errcode = '42501';
  end if;

  return query
  select
    link.project_id,
    link.income_id,
    case
      when entry.item ->> 'date' ~ '^\d{4}-\d{2}-\d{2}$'
        then (entry.item ->> 'date')::date
      else null
    end,
    coalesce(entry.item ->> 'client', ''),
    coalesce(entry.item ->> 'service', ''),
    case
      when entry.item ->> 'amount' ~ '^-?[0-9]+(?:\.[0-9]+)?$'
        then (entry.item ->> 'amount')::numeric
      else 0
    end,
    coalesce(entry.item ->> 'comment', ''),
    link.created_at
  from public.development_project_income_links as link
  join public.crm_state as state on state.id = 'main'
  cross join lateral jsonb_array_elements(coalesce(state.data -> 'income', '[]'::jsonb)) as entry(item)
  where entry.item ->> 'id' = link.income_id
    and (p_project_id is null or link.project_id = p_project_id)
  order by
    case
      when entry.item ->> 'date' ~ '^\d{4}-\d{2}-\d{2}$'
        then (entry.item ->> 'date')::date
      else null
    end desc nulls last,
    link.created_at desc;
end;
$$;

revoke all on function public.list_development_project_payments(uuid)
  from public, anon, authenticated;
grant execute on function public.list_development_project_payments(uuid)
  to authenticated, service_role;

notify pgrst, 'reload schema';

commit;
