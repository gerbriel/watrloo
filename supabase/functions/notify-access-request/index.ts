// notify-access-request — Supabase Edge Function (Deno runtime)
//
// Emails the site admin when a company submits the "Request business access"
// form so the admin can follow up and set up payment (Stripe) manually.
//
// The web app invokes this right after recording the request:
//   supabase.functions.invoke('notify-access-request', {
//     body: { business_name, contact_email },
//   })
//
// This is BEST-EFFORT. The request itself is already persisted by the app, so
// the email is only a convenience notification. Until this function is
// deployed, the app silently ignores the invoke failure — nothing breaks.
//
// ── Deploy ──────────────────────────────────────────────────────────────────
//   supabase functions deploy notify-access-request
//
// ── Secrets ─────────────────────────────────────────────────────────────────
//   supabase secrets set RESEND_API_KEY=... NOTIFY_TO=gabrielriosemail@gmail.com
//
//   Optional: set NOTIFY_FROM once you have verified a domain in Resend, e.g.
//   supabase secrets set NOTIFY_FROM='Watrloo <notifications@yourdomain.com>'
//   Without a verified domain, the default 'onboarding@resend.dev' sender is
//   used, which Resend only lets you deliver to your own account address.
//
// If RESEND_API_KEY is not set, the function returns 200 with a note that email
// is not configured rather than erroring — the request is still recorded.
// The Resend API key is never included in any response body.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

interface AccessRequestPayload {
  business_name?: string;
  contact_email?: string;
}

Deno.serve(async (req) => {
  // CORS preflight.
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  // Parse the JSON body defensively — a malformed body should not throw.
  let payload: AccessRequestPayload = {};
  try {
    payload = (await req.json()) as AccessRequestPayload;
  } catch {
    payload = {};
  }

  const businessName = payload.business_name?.trim() || "(not provided)";
  const contactEmail = payload.contact_email?.trim() || "(not provided)";

  const resendApiKey = Deno.env.get("RESEND_API_KEY");

  // Email is optional infrastructure. If it is not configured, succeed quietly:
  // the access request has already been recorded by the app.
  if (!resendApiKey) {
    console.error(
      "notify-access-request: RESEND_API_KEY is not set; skipping email.",
    );
    return json({
      ok: true,
      emailed: false,
      note: "Email not configured; the access request is already recorded.",
    });
  }

  const from = Deno.env.get("NOTIFY_FROM") ?? "Watrloo <onboarding@resend.dev>";
  const to = Deno.env.get("NOTIFY_TO") ?? "gabrielriosemail@gmail.com";
  const subject = "New Watrloo business access request";

  const text = [
    "A company just requested business access on Watrloo.",
    "",
    `Business name: ${businessName}`,
    `Contact email: ${contactEmail}`,
    "",
    "Next steps:",
    "- Review and approve it in the admin queue: /admin/requests",
    "- Set up Stripe billing for this company manually.",
  ].join("\n");

  const html = `
    <div style="font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; line-height: 1.5; color: #111;">
      <h2 style="margin: 0 0 12px;">New Watrloo business access request</h2>
      <p style="margin: 0 0 16px;">A company just requested business access on Watrloo.</p>
      <table style="border-collapse: collapse; margin: 0 0 16px;">
        <tr>
          <td style="padding: 4px 12px 4px 0; font-weight: 600;">Business name</td>
          <td style="padding: 4px 0;">${escapeHtml(businessName)}</td>
        </tr>
        <tr>
          <td style="padding: 4px 12px 4px 0; font-weight: 600;">Contact email</td>
          <td style="padding: 4px 0;">${escapeHtml(contactEmail)}</td>
        </tr>
      </table>
      <p style="margin: 0 0 8px;"><strong>Next steps:</strong></p>
      <ul style="margin: 0; padding-left: 20px;">
        <li>Review and approve it in the admin queue: <code>/admin/requests</code></li>
        <li>Set up Stripe billing for this company manually.</li>
      </ul>
    </div>
  `.trim();

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${resendApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ from, to, subject, html, text }),
    });

    if (!res.ok) {
      // Read Resend's error detail for our logs, but never surface anything
      // that could echo the API key back to the caller.
      const detail = await res.text().catch(() => "");
      console.error(
        `notify-access-request: Resend responded ${res.status}: ${detail}`,
      );
      return json(
        { ok: false, error: `Email provider returned status ${res.status}` },
        502,
      );
    }

    return json({ ok: true, emailed: true });
  } catch (err) {
    console.error("notify-access-request: failed to send email:", err);
    return json(
      { ok: false, error: "Failed to send notification email." },
      502,
    );
  }
});

// Minimal HTML escaping for the values we interpolate into the email body.
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
