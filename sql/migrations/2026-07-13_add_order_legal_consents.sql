-- Separate evidence for public-offer acceptance and personal-data consent.
-- Existing rows stay valid; new client code fills these fields for both a new
-- order and a remainder payment.

begin;

alter table public.client_orders add column if not exists offer_version text;
alter table public.client_orders add column if not exists personal_data_agreed boolean default false;
alter table public.client_orders add column if not exists personal_data_consent_text text;
alter table public.client_orders add column if not exists personal_data_consent_version text;
alter table public.client_orders add column if not exists consent_user_agent text;

comment on column public.client_orders.offer_version is
  'Version of the public offer accepted by the client.';
comment on column public.client_orders.personal_data_agreed is
  'Separate personal-data processing consent checkbox.';
comment on column public.client_orders.personal_data_consent_text is
  'Exact personal-data consent snapshot shown when the order was submitted.';
comment on column public.client_orders.personal_data_consent_version is
  'Version of the personal-data consent accepted by the client.';
comment on column public.client_orders.consent_user_agent is
  'Browser user-agent stored in the consent audit record.';

commit;
