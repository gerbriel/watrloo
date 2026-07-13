import type { ReactNode } from 'react';

/**
 * The published privacy policy. Kept faithful to docs/legal/PRIVACY_POLICY.md
 * (which was fact-checked against the code and primary legal sources). If the
 * app's data handling changes, update both this page and that document.
 */

const EFFECTIVE_DATE = 'July 12, 2026';
const CONTACT = 'hello@watrloo.com';

function H2({ children }: { children: ReactNode }) {
  return (
    <h2 className="mt-10 font-display text-xl font-bold tracking-tight text-app">
      {children}
    </h2>
  );
}

function P({ children }: { children: ReactNode }) {
  return <p className="mt-3 text-sm leading-relaxed text-muted">{children}</p>;
}

function Strong({ children }: { children: ReactNode }) {
  return <span className="font-semibold text-app">{children}</span>;
}

function Bullets({ items }: { items: ReactNode[] }) {
  return (
    <ul className="mt-3 flex list-disc flex-col gap-2 pl-5 text-sm leading-relaxed text-muted">
      {items.map((it, i) => (
        <li key={i}>{it}</li>
      ))}
    </ul>
  );
}

function Mail() {
  return (
    <a href={`mailto:${CONTACT}`} className="font-medium text-flush-500 hover:underline">
      {CONTACT}
    </a>
  );
}

export function Privacy() {
  return (
    <div className="mx-auto max-w-3xl py-10">
      <h1 className="font-display text-3xl font-bold tracking-tight text-app">
        Privacy Policy
      </h1>
      <p className="mt-2 text-sm text-muted">
        Effective {EFFECTIVE_DATE} · Operator: Watrloo (“Watrloo,” “we,” “us”) ·
        Contact: <Mail />
      </p>

      <H2>1. Who we are</H2>
      <P>
        Watrloo is a community directory where people find and rate public
        bathrooms, operated as an individual project based in California, United
        States. We are the “controller” of your personal information for the
        purposes of this policy. You can reach us at <Mail />.
      </P>
      <P>
        This policy explains what we collect, why, who we share it with, how long
        we keep it, and the rights you have.
      </P>

      <H2>2. The short version</H2>
      <Bullets
        items={[
          <>
            We collect <Strong>very little</Strong>: essentially your email and
            password (to make an account), a public username, and the reviews,
            ratings, and photos you choose to post.
          </>,
          <>
            <Strong>We do not sell or share your personal information</Strong>{' '}
            (see §8).
          </>,
          <>
            Watrloo is free and shows{' '}
            <Strong>contextual sponsored placements</Strong> from local
            businesses. These are chosen from the area you’re browsing — not from
            a profile of you. We use{' '}
            <Strong>
              no third-party ad trackers, no analytics or advertising cookies, and
              no cross-site tracking
            </Strong>{' '}
            (§8–9).
          </>,
          <>
            <Strong>
              Your reviews, username, and any photos you post are public
            </Strong>{' '}
            and can be seen and indexed by anyone (§10). Please don’t post
            anything you want to keep private.
          </>,
        ]}
      />

      <H2>3. What we collect</H2>
      <P>
        <Strong>a. Information you give us</Strong>
      </P>
      <Bullets
        items={[
          <>
            <Strong>Account details:</Strong> your email address and a password
            when you sign up. Your password is stored only in hashed form by our
            authentication provider; we never see or store it in plaintext.
          </>,
          <>
            <Strong>Your name and (optionally) phone number:</Strong> collected at
            sign-up. These are kept <Strong>private</Strong> — they are never shown
            on your public profile and are visible only to you and to
            administrators for support and account security.
          </>,
          <>
            <Strong>Username:</Strong> a public display name you choose at
            sign-up. If you sign up by a method that doesn’t supply one, we
            generate a random handle (e.g. <code>user_1a2b3c4d</code>); we never
            derive your username from your email address.
          </>,
          <>
            <Strong>Reviews and ratings:</Strong> the overall rating, optional
            sub-scores (cleanliness, privacy, accessibility), and any free-text
            review you write.
          </>,
          <>
            <Strong>Bathroom entries:</Strong> if you add a bathroom, the name,
            address, map location, and amenity details you provide.
          </>,
          <>
            <Strong>Photos (optional):</Strong> images you attach to a review.
            Before a photo leaves your device we re-encode it in your browser,
            which resizes it and{' '}
            <Strong>
              removes embedded metadata — including any GPS location and
              camera/device information (EXIF)
            </Strong>{' '}
            — so that data is not published with your photo.
          </>,
        ]}
      />
      <P>
        <Strong>b. Information collected automatically</Strong>
      </P>
      <Bullets
        items={[
          <>
            <Strong>Sign-in token:</Strong> to keep you logged in, we store an
            authentication token in your browser’s local storage. It is
            first-party and strictly necessary.
          </>,
          <>
            <Strong>Theme preference:</Strong> your light/dark choice is stored in
            your browser’s local storage. It never leaves your device and is not
            personal information.
          </>,
          <>
            <Strong>Technical/log data at our providers:</Strong> when your device
            connects to our service providers (below), they process technical data
            such as your IP address and standard request logs, as any web service
            does. We do not use this to track you across other websites.
          </>,
          <>
            <Strong>Approximate city (only if you opt in):</Strong> if you turn on
            “Approximate location” in your settings, we derive your city from your
            network (IP) address so nearby sponsored placements are more relevant.
            We keep only the city; the address itself is discarded immediately, and
            we never collect precise GPS location or track your movements.
          </>,
        ]}
      />
      <P>
        <Strong>We do NOT collect</Strong> precise device geolocation via your
        browser unless you explicitly use a “find me” feature on the map — and
        even then, your position is used on your device to move the map and is
        never sent to or stored on our servers; advertising identifiers;
        cross-site tracking data; data purchased from data brokers; or
        special-category data beyond anything you might voluntarily write in a
        review.
      </P>
      <P>
        <Strong>Directions are a hand-off, not a location feature of ours.</Strong>{' '}
        Tapping “Directions” on a bathroom opens your maps app (Apple Maps or
        Google Maps) with <Strong>only the bathroom’s address/coordinates</Strong>{' '}
        — never your location, which we don’t have. Your maps app then uses
        your live location under <Strong>its own</Strong> privacy policy, the
        same as if you had typed the address into it yourself.
      </P>

      <H2>4. Why we use it, and our legal basis (GDPR)</H2>
      <P>
        For users in the EU/EEA/UK, where the GDPR applies, our lawful bases
        (Art. 6(1)) are: performance of a contract{' '}
        <Strong>(b)</Strong> to create and operate your account and sign you in;
        legitimate interests <Strong>(f)</Strong> and, for the act of posting,
        your consent <Strong>(a)</Strong> to publish the reviews, ratings, and
        photos you submit to run a public directory; legitimate interests{' '}
        <Strong>(f)</Strong> to keep the service secure and prevent abuse; and
        contract <Strong>(b)</Strong> and legal obligation <Strong>(c)</Strong> to
        respond to your requests. We do not rely on legitimate interests to sell,
        share, or profile you — we don’t do those things.
      </P>

      <H2>5. Who we share it with</H2>
      <P>
        We share personal information only with{' '}
        <Strong>service providers (“processors”)</Strong> who process it on our
        behalf, under contract, to run the service — never with advertisers, data
        brokers, or partners for their own purposes.
      </P>
      <Bullets
        items={[
          <>
            <Strong>Supabase</Strong> — hosts our database, authentication, and
            photo storage. Processes: email, hashed password, all content you
            post, photos, IP addresses, and logs.
          </>,
          <>
            <Strong>Cloudflare (R2)</Strong> — hosts the map’s base imagery (a
            self-hosted map data file). Processes: the IP address of anyone
            loading the map. If no basemap host is configured, the map shows
            locations on a plain background and no third party receives your IP
            for the map.
          </>,
          <>
            <Strong>Apple Maps / Google Maps (only if you tap “Directions”)</Strong>{' '}
            — a link you choose to open, not a processor of ours. We pass them
            the bathroom’s coordinates only; anything they learn about you
            (including your location) is governed by their privacy policies,
            not this one.
          </>,
        ]}
      />
      <P>
        We may also disclose information if required by law, or to protect the
        rights, safety, or property of our users or us. Our providers offer
        data-processing agreements incorporating the Standard Contractual Clauses,
        which govern their processing of personal data on our behalf.
      </P>

      <H2>6. International data transfers</H2>
      <P>
        Our providers store and process data in the{' '}
        <Strong>United States</Strong> (our database region is US West). If you
        are in the EU/EEA/UK, your information is transferred to the US. Where such
        transfers happen, we rely on the Standard Contractual Clauses our providers
        offer, and/or the EU–US Data Privacy Framework where a provider is
        certified. You can ask us for more detail using the contact above.
      </P>

      <H2>7. How long we keep it</H2>
      <Bullets
        items={[
          <>
            <Strong>Account data (email, username):</Strong> for as long as your
            account exists.
          </>,
          <>
            <Strong>Reviews, ratings, bathroom entries, photos:</Strong> until you
            delete them or your account. Because these are public, others may have
            seen or copied them while they were posted.
          </>,
          <>
            <Strong>Sign-in token / theme preference:</Strong> stored in your
            browser until you sign out, it expires, or you clear your browser
            storage.
          </>,
          <>
            <Strong>Provider logs (e.g., IP address):</Strong> retained by our
            providers per their own schedules.
          </>,
        ]}
      />
      <P>
        You can delete your account at any time from your profile page. When you
        do, we delete your account, your reviews, and{' '}
        <Strong>your uploaded photo files</Strong>. Bathroom entries you added
        remain in the public directory but are no longer linked to you.
      </P>

      <H2>8. Advertising, and how we don’t sell or share your data</H2>
      <P>
        <Strong>
          We do not sell your personal information, and we do not share it for
          cross-context behavioral advertising
        </Strong>{' '}
        as those terms are defined under the California Consumer Privacy Act (as
        amended by the CPRA). We do not build advertising profiles about you, and
        we do not target ads based on tracking your behavior over time or across
        other apps and sites.
      </P>
      <P>
        Watrloo is free and shows <Strong>contextual sponsored placements</Strong>{' '}
        from local businesses. These are chosen from the area you’re browsing and,
        only if you opt in, your approximate city — never from a behavioral profile
        of you. Advertisers pay to be shown; they do{' '}
        <Strong>not</Strong> receive your personal information, and we do not embed
        third-party ad networks or tracking pixels to serve them. Contextual
        advertising of this kind is <Strong>not a “sale” or a “share”</Strong>{' '}
        under the CPRA, so there is still nothing for you to opt out of on that
        basis. If this ever changes, we will update this policy and provide any
        legally required choices before the change takes effect.
      </P>

      <H2>9. Cookies and local storage</H2>
      <P>
        <Strong>
          We do not use cookies, and we do not use advertising or analytics
          trackers.
        </Strong>{' '}
        The only information we store on your device is a strictly-necessary
        sign-in token and your theme (light/dark) preference, both in your
        browser’s local storage. Neither is used to track you or shared with
        anyone. Because we use only strictly-necessary, first-party storage, we do
        not display a cookie-consent banner. You can clear this storage anytime via
        your browser settings (which will sign you out).
      </P>

      <H2>10. Public content — please read before posting</H2>
      <P>
        Watrloo is a public directory.{' '}
        <Strong>
          Your username, your reviews and ratings, the bathrooms you add, and any
          photos you attach are visible to anyone
        </Strong>
        , including people who are not signed in, and may be indexed by search
        engines. Anyone can view the reviews associated with your username.
      </P>
      <P>
        We strip hidden location and device metadata (EXIF/GPS) from photos before
        upload, but that does not hide what is <Strong>visible</Strong> in the
        image. Please don’t include anything you consider private in a review or
        photo — faces, license plates, documents, or your home. You can edit or
        delete your own reviews and photos at any time.
      </P>

      <H2>11. Your rights</H2>
      <P>
        <Strong>If you are in the EU/EEA/UK (GDPR):</Strong> you have the right to
        access, rectify, erase, port, object to, and restrict processing of your
        data, subject to legal limits. Where we rely on consent, you may withdraw
        it at any time. You also have the right to lodge a complaint with your
        local data protection supervisory authority.
      </P>
      <P>
        <Strong>If you are a California resident (CCPA/CPRA):</Strong> you have the
        right to know, delete, and correct your personal information, and to opt
        out of sale/sharing — though, as stated in §8, we do not sell or share
        personal information, so there is nothing to opt out of. We will not
        discriminate against you for exercising any right.
      </P>
      <P>
        <Strong>To exercise any right</Strong>, email us at <Mail />. We’ll verify
        your request (usually by confirming control of your account email) and
        respond within the time required by applicable law.
      </P>

      <H2>12. Security</H2>
      <P>
        We take reasonable measures to protect your information. Our database uses
        row-level security so write access is limited to your own account, and
        photo uploads are confined to your own storage area. Your password is
        stored only in hashed form by our authentication provider.{' '}
        <Strong>No online service can be perfectly secure</Strong>, and we cannot
        guarantee absolute security — remember that anything you post is public by
        design (§10). If we become aware of a breach affecting your personal
        information, we will notify you and any regulators as required by law.
      </P>

      <H2>13. Children</H2>
      <P>
        Watrloo is not intended for children.{' '}
        <Strong>You must be at least 13 years old to use Watrloo.</Strong> We do
        not knowingly collect personal information from children under 13. If you
        believe a child has provided us personal information, contact us at{' '}
        <Mail /> and we will delete it.
      </P>

      <H2>14. How to contact us or complain</H2>
      <P>Questions or requests: <Mail />.</P>
      <Bullets
        items={[
          <>
            <Strong>EU/EEA/UK users:</Strong> you may lodge a complaint with your
            national data protection supervisory authority.
          </>,
          <>
            <Strong>California users:</Strong> you may contact the California
            Attorney General (oag.ca.gov) or the California Privacy Protection
            Agency (cppa.ca.gov).
          </>,
        ]}
      />
      <P>
        We’d appreciate the chance to address your concern first — please reach
        out.
      </P>

      <H2>15. Changes to this policy</H2>
      <P>
        We may update this policy from time to time. If we make a material change,
        we’ll update the “Effective” date above and, where appropriate, notify you.
        If a change would ever affect whether we sell or share personal information
        (§8), we’ll make the required disclosures and provide any legally required
        choices before the change takes effect.
      </P>
    </div>
  );
}
