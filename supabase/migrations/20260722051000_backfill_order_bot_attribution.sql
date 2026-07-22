update public.bg_orders as orders
set bot_id = runs.bot_id
from public.bg_trades as trades
join public.bg_bot_runs as runs on runs.id = trades.run_id
where orders.trade_id = trades.id
  and orders.bot_id is null;

update public.bg_orders as orders
set bot_id = events.bot_id
from public.bg_bot_events as events
where orders.bot_id is null
  and events.bot_id is not null
  and events.details ->> 'broker_order_id' = orders.broker_order_id;
