import { config } from "../config.ts";

/**
 * Transactional email via Resend's HTTP API.
 *
 * HTTP rather than SMTP on purpose: no connection pooling, no port 587 (which
 * many hosts block outbound), and failures arrive as ordinary status codes.
 *
 * Deliverability is a DNS problem, not a code one — the sending domain needs
 * SPF and DKIM records or the mail lands in spam, and a magic link in a spam
 * folder is a broken login.
 */

const RESEND_ENDPOINT = "https://api.resend.com/emails";

export function isEmailConfigured(): boolean {
  return !!config.RESEND_API_KEY;
}

interface SendArgs {
  to: string;
  subject: string;
  html: string;
  text: string;
}

async function send(args: SendArgs): Promise<void> {
  if (!config.RESEND_API_KEY) {
    throw new Error("RESEND_API_KEY is not configured");
  }

  const response = await fetch(RESEND_ENDPOINT, {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.RESEND_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      from: config.EMAIL_FROM,
      to: [args.to],
      subject: args.subject,
      html: args.html,
      text: args.text,
    }),
  });

  if (!response.ok) {
    // The body carries Resend's reason (unverified domain, invalid address,
    // rate limit). Losing it would make delivery failures undiagnosable.
    throw new Error(
      `Resend rejected the message: ${response.status} ${await response.text()}`,
    );
  }
}

/**
 * Escapes text interpolated into the HTML body. The only interpolated values
 * are our own URL and product name, but an unescaped template is a standing
 * invitation for the next person to inject something user-controlled.
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export async function sendMagicLinkEmail(args: {
  to: string;
  url: string;
  ttlMinutes: number;
}): Promise<void> {
  const safeUrl = escapeHtml(args.url);
  const product = escapeHtml(config.EMAIL_PRODUCT_NAME);

  // Deliberately plain: heavy templates, tracking pixels and image-only
  // buttons all hurt inbox placement, and this mail has exactly one job.
  const html = `<!doctype html>
<html>
  <body style="font-family: system-ui, -apple-system, Segoe UI, sans-serif; line-height: 1.6; color: #111;">
    <p>Click the link below to sign in to ${product}:</p>
    <p><a href="${safeUrl}" style="display:inline-block;padding:12px 20px;background:#5865F2;color:#fff;text-decoration:none;font-weight:600;">Sign in</a></p>
    <p style="color:#555;font-size:14px;">Or paste this into your browser:<br><span style="word-break:break-all;">${safeUrl}</span></p>
    <p style="color:#555;font-size:14px;">This link expires in ${args.ttlMinutes} minutes and can only be used once.</p>
    <p style="color:#888;font-size:13px;">If you did not request this, you can ignore this email — nobody can sign in without the link.</p>
  </body>
</html>`;

  const text = [
    `Click the link below to sign in to ${config.EMAIL_PRODUCT_NAME}:`,
    "",
    args.url,
    "",
    `This link expires in ${args.ttlMinutes} minutes and can only be used once.`,
    "If you did not request this, you can ignore this email — nobody can sign in without the link.",
  ].join("\n");

  await send({
    to: args.to,
    subject: `Sign in to ${config.EMAIL_PRODUCT_NAME}`,
    html,
    text,
  });
}
