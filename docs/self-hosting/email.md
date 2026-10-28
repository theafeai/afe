# SMTP and account emails

Email is optional. Manual user creation and credential reset continue to work
without SMTP. Email adds invitations, administrator-triggered reset links, and
self-service recovery for users with an email address on their account.

## Configure delivery

Configure the **server and worker** with the same settings:

```dotenv
AFE_PUBLIC_URL=https://afe.example.com
AFE_ENCRYPTION_KEY_FILE=/run/secrets/encryption_key
AFE_SMTP_HOST=smtp.example.com
AFE_SMTP_PORT=587
AFE_SMTP_SECURE=false
AFE_SMTP_FROM=afe@example.com
AFE_SMTP_USERNAME=afe
AFE_SMTP_PASSWORD_FILE=/run/secrets/smtp_password
```

Use the existing encryption-key configuration documented in
[configuration.md](configuration.md). Never commit passwords or keys. The SMTP
password accepts either `AFE_SMTP_PASSWORD` or `_FILE`, never both. Username and
password must be provided together; omit both for an operator-controlled relay
which does not require authentication. Use a dedicated sending-only SMTP account
and rotate its password by replacing the secret and restarting server/worker.
SMTP authentication is operator configuration; it is never exposed through the API.

`AFE_SMTP_FROM` accepts one bare email address, not a display name or recipient
list. Configure and verify that sender/domain with the provider. Set SPF, DKIM
and DMARC according to the provider's instructions. Afe does not provision DNS
records or a mail provider.

Port 587 requires STARTTLS. For implicit TLS on port 465, set
`AFE_SMTP_SECURE=true`. Certificate verification is always enabled. Use
`NODE_EXTRA_CA_CERTS` for a private CA. Private/loopback SMTP hosts require
`AFE_ALLOW_PRIVATE_NETWORK_TARGETS=true`. Afe validates DNS and pins a checked
address for each delivery, preserving the hostname for certificate verification.
Connections time out after 10 seconds, inactive sockets after 20 seconds, and an
entire SMTP connection after 30 seconds.

For a local mail-capture server only, plaintext SMTP requires all three flags:
`AFE_SMTP_ALLOW_PLAINTEXT=true`, `AFE_ALLOW_PRIVATE_NETWORK_TARGETS=true`, and
`AFE_ALLOW_INSECURE_HTTP_TARGETS=true`. The last two flags also allow an HTTP
`AFE_PUBLIC_URL` in a lab. Production email links require an HTTPS origin, with
no path, query, fragment or embedded credentials. Link construction never uses
the browser's Host header.

Run `afe migrate` before starting the updated application (migration 0028).
Restart both processes after changing configuration. The worker's
`email.deliver` job checks pending messages every minute, including messages
committed before a server crash. A server-only deployment queues email but needs
an `afe worker` process to deliver it; `afe all` includes both roles.

## Verify and use

1. Open **Users → Email delivery**, enter a test recipient and choose **Send test
   email**. Refresh delivery status until it shows `sent` or `failed`.
2. Create a user with **Send an invitation by email** selected. The new user has
   no tool access until an administrator assigns permissions.
3. Existing users can receive email after the administrator saves an email
   address. **Resend invitation** and **Email reset link** queue new links.
4. The recipient opens the email and chooses **Continue**. Afe generates a new
   access credential, shown once, which they save and use on the sign-in page.
   Any previous credential and sessions end when the link is redeemed.
5. **Forgot your access credential?** on the sign-in screen requests a reset
   link. The response is the same for unknown, disabled and active accounts.

Addresses are unique within each tenant and normalized to lowercase. Changing
an account's email invalidates its existing sessions and pending links.
Invitations expire after 24 hours; reset links after 30 minutes. Links are
single-use, and issuing a new link invalidates earlier ones. Manual credential
rotation and disabling/re-enabling a user also invalidate earlier email links.
Email security scanners cannot consume links by following a GET: redemption
requires an explicit POST from the confirmation screen. The token is in the URL
fragment, removed from browser history when the page opens, and is not sent in
HTTP paths or referrers. No third-party scripts or resources are loaded there.

Public recovery is available only with Afe's built-in local authentication and
tenant resolver. A hosted build supplying custom authentication or tenant
resolution must provide its own recovery flow; Afe never takes a tenant from a
reset request. Possession of an unguessable link is verified against its
stored digest before credential rotation. Email sign-in does not grant any
additional tool permissions.

## Delivery and troubleshooting

Delivery status means the configured SMTP relay accepted the message; it does
not prove inbox delivery. Check provider bounce/spam reports separately.
The UI shows the latest 20 delivery states and attempt counts, without email
bodies or tokens. Worker logs contain only tenant/outbox IDs and attempt numbers;
SMTP response bodies, passwords and recipients are never logged.

Failed sends retry after 1, 2, 4 and 8 minutes (five attempts total). Expired or
invalidated links are discarded. A terminal send destroys the encrypted message
payload. Payloads use the existing tenant-bound credentials repository; jobs
contain no tokens, message bodies or SMTP passwords. Metadata and link digests
are removed seven days after expiry by the worker. User email addresses remain
on their user records until an administrator clears/replaces them.

SMTP has no transactional acknowledgement shared with PostgreSQL. A crash after
relay acceptance but before database commit can cause a duplicate email. Retries
use the same Message-ID and link; redemption still succeeds at most once.

Self-service recovery permits one email per account per 15 minutes and ten
recovery/redemption attempts per source IP per 15 minutes per server process.
Run a shared ingress rate limiter for multiple replicas. Afe uses the direct
peer IP by default; do not trust arbitrary forwarded headers. Administrators can
reissue links independently. Users can always ask an administrator for a manual
credential reset when mail delivery fails.

If email is disabled, check that SMTP is configured on the server. If email is
pending, check that the worker is running with the same database and encryption
key. For repeated failures, verify SMTP reachability, network policy, TLS trust,
authentication and sender verification at the provider. Restart after correcting
settings, then issue a fresh link if the previous delivery failed or expired.
