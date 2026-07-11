import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';

const EFFECTIVE_DATE = 'July 11, 2026';
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

export function Terms() {
  return (
    <div className="mx-auto max-w-3xl py-10">
      <h1 className="font-display text-3xl font-bold tracking-tight text-app">
        Terms & Conditions
      </h1>
      <p className="mt-2 text-sm text-muted">
        Effective {EFFECTIVE_DATE} · Operator: Watrloo (“we,” “us”) · Contact:{' '}
        <a href={`mailto:${CONTACT}`} className="text-flush-500 hover:underline">
          {CONTACT}
        </a>
      </p>

      <H2>1. What Watrloo is, and accepting these terms</H2>
      <P>
        Watrloo is a community directory where people find, rate, and review
        public bathrooms. By creating an account or using the service you agree
        to these Terms and to our{' '}
        <Link to="/privacy" className="text-flush-500 hover:underline">
          Privacy Policy
        </Link>
        . If you don’t agree, don’t use Watrloo.
      </P>

      <H2>2. Who can use it</H2>
      <P>
        You must be at least <Strong>13 years old</Strong> and able to form a
        binding agreement. You’re responsible for your account and for keeping
        your password secure. One person per account; don’t impersonate anyone.
      </P>

      <H2>3. Your content</H2>
      <P>
        Reviews, ratings, photos, and bathroom entries you post are{' '}
        <Strong>yours</Strong> — but by posting, you grant us a worldwide,
        non-exclusive, royalty-free license to host, display, reproduce, and
        distribute that content as part of operating and promoting the service.
        This license ends for content you delete, except where it has already
        been shared with others or is retained for legal reasons.
      </P>
      <Bullets
        items={[
          <>You must have the right to post what you post (your own photos, your own words).</>,
          <>
            Reviews must reflect a <Strong>genuine visit or experience</Strong>. No
            fake reviews, no reviewing your own business, no paid or bartered
            reviews.
          </>,
          <>
            Photos must be of the facility. Don’t photograph people without their
            consent — bathrooms are a privacy-sensitive setting; photos of
            identifiable people inside restrooms are prohibited and will be removed.
          </>,
        ]}
      />

      <H2>4. Prohibited conduct</H2>
      <Bullets
        items={[
          <>Harassment, hate speech, threats, or sexual content.</>,
          <>Spam, scraping, bulk data extraction, or automated account creation.</>,
          <>Posting others’ personal information (doxxing), or content you have no right to share.</>,
          <>Deliberately false entries — fake bathrooms, wrong locations, misleading amenity claims.</>,
          <>Interfering with the service, probing or breaking its security, or circumventing rate limits and access controls.</>,
        ]}
      />

      <H2>5. Moderation</H2>
      <P>
        We may remove content, restrict features, or suspend or terminate
        accounts that violate these Terms — including hiding (rather than
        erasing) content pending review. Moderation decisions are logged. You can
        report content from any listing or review; we review reports but don’t
        guarantee a response time.
      </P>

      <H2>6. Advertising and sponsored content</H2>
      <P>
        Watrloo is free to use and is supported by advertising. Local businesses
        can buy <Strong>sponsored placements</Strong> — promotional cards shown
        in-context to people browsing in the relevant area. By using Watrloo you
        agree to see these placements as part of the free service.
      </P>
      <Bullets
        items={[
          <>
            Sponsored placements are always <Strong>clearly labeled</Strong>{' '}
            (“Sponsored”) and never disguised as ordinary listings or reviews.
          </>,
          <>
            They are <Strong>contextual</Strong>, not behavioral: what you see is
            based on the area you’re browsing and your approximate city (derived
            from your network address, never precise GPS). We do{' '}
            <Strong>not</Strong> build an advertising profile of you from your
            activity, and we do not sell your personal information to advertisers.
          </>,
          <>
            We do not send marketing email or push you unsolicited messages — any
            promotional content appears in-app, in context, only.
          </>,
          <>
            You can reduce tailoring anytime in your profile’s Privacy &
            personalization settings; sponsored placements themselves are part of
            the free service.
          </>,
        ]}
      />
      <P>
        Businesses can also claim their listings, keep facts accurate, and
        respond to reviews under a paid plan. A business can{' '}
        <Strong>never edit, remove, or reorder user reviews</Strong> — review
        integrity is not for sale. Business accounts are additionally governed by
        the plan terms presented at purchase.
      </P>

      <H2>7. The service is informational — use judgment</H2>
      <P>
        Bathroom information is <Strong>community-sourced and can be wrong or
        stale</Strong>: places close, hours change, keys get lost, accessibility
        varies. We don’t verify listings and make no promise that a listed
        facility exists, is open, is clean, is safe, or is accessible.{' '}
        <Strong>Watrloo is provided “as is” and “as available,” without
        warranties of any kind</Strong>, express or implied, including fitness
        for a particular purpose and non-infringement.
      </P>

      <H2>8. Limitation of liability</H2>
      <P>
        To the maximum extent permitted by law, Watrloo and its operator are not
        liable for indirect, incidental, special, consequential, or punitive
        damages, or for lost profits or data, arising from your use of the
        service — including anything that happens at a listed location. Our
        total liability for any claim is capped at the greater of{' '}
        <Strong>$100</Strong> or the amount you paid us in the 12 months before
        the claim. Some jurisdictions don’t allow these limits, so parts may not
        apply to you.
      </P>

      <H2>9. Indemnity</H2>
      <P>
        If someone brings a claim against us because of content you posted or
        your breach of these Terms, you agree to indemnify us for the resulting
        losses and reasonable legal costs.
      </P>

      <H2>10. Ending your account</H2>
      <P>
        You can delete your account anytime from your profile — that removes
        your account, reviews, and uploaded photos (bathroom entries you added
        stay, unlinked from you). We may suspend or terminate accounts for
        violations. Sections that by their nature survive (3, 7–9, 11–12) survive
        termination.
      </P>

      <H2>11. Governing law</H2>
      <P>
        These Terms are governed by the laws of the State of{' '}
        <Strong>California</Strong>, USA, without regard to conflict-of-law
        rules. Disputes will be resolved in the state or federal courts located
        in California, and you consent to their jurisdiction.
      </P>

      <H2>12. Changes</H2>
      <P>
        We may update these Terms. For material changes we’ll update the
        effective date above and give notice in the app. Continuing to use
        Watrloo after a change takes effect means you accept the updated Terms.
      </P>

      <P>
        Questions:{' '}
        <a href={`mailto:${CONTACT}`} className="text-flush-500 hover:underline">
          {CONTACT}
        </a>
        .
      </P>
    </div>
  );
}
