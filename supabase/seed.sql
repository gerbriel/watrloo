-- Watrloo seed data: ~10 real-world public bathrooms across SF and NYC.
--
-- Bathrooms only. Reviews, profiles, and photos are intentionally omitted:
-- they hang off real auth.users rows, which a seed can't create cleanly.
--
-- Idempotent: fixed UUIDs + `on conflict (id) do nothing`, so re-running is safe.
-- `created_by` is left null (community/unclaimed entries); the RLS insert policy
-- is bypassed here because seeds run as the table owner, not an API role.

insert into public.bathrooms
  (id, name, address, lat, lng, description,
   wheelchair_accessible, gender_neutral, changing_table, requires_key)
values
  -- San Francisco -----------------------------------------------------------
  ('a0000000-0000-4000-8000-000000000001',
   'Ferry Building Marketplace Restroom',
   'One Ferry Building, San Francisco, CA 94111',
   37.7955, -122.3937,
   'Ground-floor public restrooms inside the marketplace. Busy at lunch but well maintained.',
   true, false, true, false),

  ('a0000000-0000-4000-8000-000000000002',
   'Dolores Park Restroom',
   'Dolores St & 19th St, San Francisco, CA 94114',
   37.7596, -122.4269,
   'Renovated park restroom near the tennis courts. Gets long lines on sunny weekends.',
   true, true, false, false),

  ('a0000000-0000-4000-8000-000000000003',
   'San Francisco Public Library - Main Branch',
   '100 Larkin St, San Francisco, CA 94102',
   37.7786, -122.4159,
   'Multiple restrooms across floors. Cleanest ones are on the upper levels.',
   true, false, true, false),

  ('a0000000-0000-4000-8000-000000000004',
   'Conservatory of Flowers Restroom',
   '100 John F Kennedy Dr, San Francisco, CA 94118',
   37.7726, -122.4603,
   'Golden Gate Park restroom just east of the conservatory. Basic but usually stocked.',
   true, false, false, false),

  ('a0000000-0000-4000-8000-000000000005',
   'Blue Bottle Coffee - Mint Plaza',
   '66 Mint St, San Francisco, CA 94103',
   37.7825, -122.4090,
   'Single-occupancy cafe restroom. Ask a barista for the code by the counter.',
   false, true, false, true),

  -- New York City -----------------------------------------------------------
  ('a0000000-0000-4000-8000-000000000006',
   'Bryant Park Restrooms',
   'Bryant Park, New York, NY 10018',
   40.7536, -73.9832,
   'Famously upscale park restrooms with fresh flowers and an attendant. Worth the short wait.',
   true, false, true, false),

  ('a0000000-0000-4000-8000-000000000007',
   'Grand Central Terminal Restroom',
   '89 E 42nd St, New York, NY 10017',
   40.7527, -73.9772,
   'Lower-level restrooms near the dining concourse. High traffic; variable cleanliness.',
   true, false, true, false),

  ('a0000000-0000-4000-8000-000000000008',
   'Washington Square Park Restroom',
   'Washington Square, New York, NY 10012',
   40.7308, -73.9973,
   'Park restrooms in the southeast corner. Fine during the day, closes in the evening.',
   true, true, false, false),

  ('a0000000-0000-4000-8000-000000000009',
   'Stumptown Coffee - Ace Hotel',
   '18 W 29th St, New York, NY 10001',
   40.7449, -73.9884,
   'Restroom shared with the Ace Hotel lobby. Key or code from staff during busy hours.',
   false, true, false, true),

  ('a0000000-0000-4000-8000-00000000000a',
   'Central Park - Bethesda Terrace Restroom',
   'Bethesda Terrace, Central Park, New York, NY 10024',
   40.7736, -73.9712,
   'Stone restroom building near the fountain. Scenic location, expect a line midday.',
   true, false, false, false)
on conflict (id) do nothing;
