-- Ответы клиентов на утренний опрос «Сможете сегодня сделать отзыв?»
-- Заполняется ботом (callback на inline-кнопки [Да]/[Нет]).
-- CRM-календарь читает таблицу и показывает значки ✓/❌ рядом с клиентом.
--
-- Запускать в Supabase SQL Editor (роль: postgres).

CREATE TABLE IF NOT EXISTS public.schedule_responses (
    id              BIGSERIAL PRIMARY KEY,
    client_email    TEXT,                          -- email клиентского portala
    client_name     TEXT,
    client_code     TEXT,                          -- a9 / a10 (код анкеты)
    mentor_id       TEXT,
    schedule_date   DATE NOT NULL,                 -- дата ИЗНАЧАЛЬНО запланированного отзыва
    response        TEXT NOT NULL CHECK (response IN ('yes','no','pending','asked')),
    chat_id         BIGINT,                        -- telegram chat_id клиента
    notified_at     TIMESTAMPTZ,                   -- когда бот спросил
    responded_at    TIMESTAMPTZ,                   -- когда клиент нажал последнюю кнопку
    note            TEXT,                          -- любой коммент от бота/клиента
    chosen_time     TEXT,                          -- выбранное клиентом время «HH:MM»
    chosen_date     DATE                           -- если перенёс — куда (на «нет→дата»)
);

-- Идемпотентный ALTER: для существующих установок добавим новые поля.
ALTER TABLE public.schedule_responses
    ADD COLUMN IF NOT EXISTS chosen_time TEXT;
ALTER TABLE public.schedule_responses
    ADD COLUMN IF NOT EXISTS chosen_date DATE;
-- applied_at: проставляется CRM-фронтом когда автоперенос даты в
-- state.clients[].schedule выполнен. Защищает от повторного применения.
ALTER TABLE public.schedule_responses
    ADD COLUMN IF NOT EXISTS applied_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS ix_sched_resp_date ON public.schedule_responses (schedule_date);
CREATE INDEX IF NOT EXISTS ix_sched_resp_email ON public.schedule_responses (client_email);
CREATE INDEX IF NOT EXISTS ix_sched_resp_chat ON public.schedule_responses (chat_id);

-- RLS: владелец/анон может читать (CRM рендерит ответы в календаре).
-- Запись только через service_role (бот). Никто из веба не должен писать.
ALTER TABLE public.schedule_responses ENABLE ROW LEVEL SECURITY;

-- anon SELECT — для CRM-фронта.
DROP POLICY IF EXISTS sched_resp_anon_select ON public.schedule_responses;
CREATE POLICY sched_resp_anon_select ON public.schedule_responses
    FOR SELECT TO anon USING (true);

-- authenticated SELECT — тоже разрешаем (CRM работает под service_role с
-- разными ключами, на всякий случай).
DROP POLICY IF EXISTS sched_resp_auth_select ON public.schedule_responses;
CREATE POLICY sched_resp_auth_select ON public.schedule_responses
    FOR SELECT TO authenticated USING (true);

-- anon UPDATE applied_at — нужно для авто-переноса даты со стороны
-- CRM-фронта (admin browser). Защита: можно обновить ТОЛЬКО запись где
-- applied_at ещё NULL. Это блокирует повторное применение / переоткат.
DROP POLICY IF EXISTS sched_resp_anon_apply ON public.schedule_responses;
CREATE POLICY sched_resp_anon_apply ON public.schedule_responses
    FOR UPDATE TO anon
    USING (applied_at IS NULL)
    WITH CHECK (true);

-- Trim: оставляем последние 10 000 строк, чтобы таблица не разрасталась.
CREATE OR REPLACE FUNCTION public.trim_schedule_responses() RETURNS trigger AS $$
BEGIN
    DELETE FROM public.schedule_responses
    WHERE id IN (
        SELECT id FROM public.schedule_responses
        ORDER BY id DESC OFFSET 10000
    );
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trim_schedule_responses_trg ON public.schedule_responses;
CREATE TRIGGER trim_schedule_responses_trg
    AFTER INSERT ON public.schedule_responses
    FOR EACH STATEMENT EXECUTE FUNCTION public.trim_schedule_responses();
