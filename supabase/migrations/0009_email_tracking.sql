-- Email open/click tracking. Outbound emails carry a 1x1 pixel and click-through
-- redirect keyed on the message id; these columns record the signals, and a lead
-- with a click (or 2+ opens) surfaces as "warm" in the daily queue.
alter table messages add column if not exists open_count  int not null default 0;
alter table messages add column if not exists opened_at   timestamptz;
alter table messages add column if not exists click_count int not null default 0;
alter table messages add column if not exists clicked_at  timestamptz;

-- Atomic increments so concurrent opens/clicks don't clobber each other. Called
-- from the pixel/click API routes via the service-role client.
create or replace function public.track_email_open(msg uuid) returns void
  language sql security definer as $$
  update messages set open_count = open_count + 1, opened_at = coalesce(opened_at, now()) where id = msg;
$$;

create or replace function public.track_email_click(msg uuid) returns void
  language sql security definer as $$
  update messages set click_count = click_count + 1, clicked_at = coalesce(clicked_at, now()) where id = msg;
$$;
