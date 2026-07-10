-- Watrloo seed data: ~16 real-world public bathrooms.
-- Fresno, CA is featured most prominently — listed first and with the most
-- entries — followed by SF and NYC.
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
  -- Fresno, CA (featured) -----------------------------------------------------
  ('f0000000-0000-4000-8000-000000000001',
   'Woodward Park Restroom',
   '7775 Friant Rd, Fresno, CA 93720',
   36.8600, -119.7735,
   'Regional park restrooms near the lake and playgrounds. Basic but generally clean; can close around dusk.',
   true, false, false, false),

  ('f0000000-0000-4000-8000-000000000002',
   'River Park Shopping Center',
   '71 E Nees Ave, Fresno, CA 93720',
   36.8399, -119.7745,
   'Well-kept shopping-center restrooms near the fountains and food. Reliable and easy to find.',
   true, false, true, false),

  ('f0000000-0000-4000-8000-000000000003',
   'Fresno Yosemite International Airport',
   '5175 E Clinton Way, Fresno, CA 93727',
   36.7742, -119.7181,
   'Landside and post-security restrooms. Clean and well-stocked, with a family restroom available.',
   true, false, true, false),

  ('f0000000-0000-4000-8000-000000000004',
   'Fresno County Public Library - Central Branch',
   '2420 Mariposa St, Fresno, CA 93721',
   36.7377, -119.7862,
   'Downtown library restrooms across several floors. Quiet and usually tidy on weekday mornings.',
   true, false, true, false),

  ('f0000000-0000-4000-8000-000000000005',
   'Chukchansi Park',
   '1800 Tulare St, Fresno, CA 93721',
   36.7304, -119.7857,
   'Ballpark concourse restrooms. Easy access on off days; long lines on Grizzlies game nights.',
   true, false, true, false),

  ('f0000000-0000-4000-8000-000000000006',
   'Kuppa Joy Coffee House - Tower District',
   '833 E Fern Ave, Fresno, CA 93728',
   36.7590, -119.7930,
   'Single-occupancy cafe restroom in the Tower District. Ask a barista for the code.',
   false, true, false, true),

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
