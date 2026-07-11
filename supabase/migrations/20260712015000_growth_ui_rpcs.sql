-- UI support for the in-app message center: recipients own their send rows but
-- have no read path to the campaign creative (ad_campaigns is member/admin
-- read). This definer RPC joins the two, scoped strictly to the caller.

create or replace function public.my_messages()
returns table (
  send_id uuid, campaign_id uuid, business_name text,
  creative jsonb, status text, created_at timestamptz, read_at timestamptz
)
language sql stable security definer set search_path = '' as $$
  select s.id, s.campaign_id, b.name, c.creative, s.status, s.created_at, s.read_at
  from public.campaign_sends s
  join public.ad_campaigns c on c.id = s.campaign_id
  join public.businesses b on b.id = c.business_id
  where s.user_id = (select auth.uid())
  order by s.created_at desc
  limit 200;
$$;
grant execute on function public.my_messages() to authenticated;
