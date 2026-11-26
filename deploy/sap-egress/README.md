# SAP/FTP gateway

Dedicated DigitalOcean Basic Droplet in Bangalore, Debian 13, 512 MiB RAM,
10 GiB disk, 500 GiB monthly transfer. Server $4/month plus percentage-based
weekly backups $0.80/month, before tax. No other paid resources are required.

Provisioned on 26 November 2026:

- Name: `samrat-sap-gateway-blr1`
- Droplet ID: `623537109`
- IPv4: `168.144.21.82` (retained for the life of this Droplet)
- Dashboard: https://cloud.digitalocean.com/droplets/623537109
- Budget alert: $5/month, notifications at 50%, 75%, 90%, 100%. Notifications
  do not cap charges or stop the gateway.

## Completed production cutover — 26 November 2026

Client IT approved the fixed IP. Verified through the new gateway:

- Production SAP API reads, Service Layer authentication and a receipt read.
- A valid production PDF download, without importing a case.
- FTP `/prod/in` and `/prod/archive` listings and a PDF download from the archive.
  The verification probes did not move files or create cases.
- Legacy/Test API reads and Service Layer authentication, so older cases keep
  their existing SAP company routing.
- Live Chrome receipts page: SAP rows loaded and the FTP check refreshed to
  the current date without the connection error.

The production website and worker now use the gateway. The old paid QuotaGuard
add-on has been removed after a queued analysis job and its SAP matching job
finished. No manual edits to case contents were required. Extraction rules,
matching logic and SAP posting behavior were not changed by this cutover.

Application code: `8159376685860e3e8d0c601afd0ed018d1938fbe`.
Netlify cutover deployment: `6b085e64ca62ad8f90a9f38e`.
Private rollback/configuration backups remain in the local private directory
below. Local connection verification records are in
`output/audit/digitalocean-gateway-20261126/` and contain no credentials.

## Connection and security

The gateway forwards bytes; it does not parse invoices, run AI, change SAP
matching, or cache SAP responses. Both SAP HTTP CONNECT traffic and FTP control
and passive data connections use an authenticated HTTPS proxy on port 8443.
TLS continues end to end for SAP HTTPS destinations. FTP retains the client's
existing FTP/FTPS mode on the gateway-to-FTP-server connection.

- stunnel provides TLS 1.2+; tinyproxy listens on loopback only.
- High-entropy proxy password, never included in process arguments or logs.
- Private CA explicitly trusted for the proxy only. SAP's trust settings are
  independent; certificate verification is not disabled.
- Domain filtering and an outbound firewall restrict tinyproxy to the client's
  SAP/FTP host (`sbivan.samratgroup.com`, currently `183.82.101.98`).
- Inbound firewall allows SSH and HTTPS proxy only. SSH is key-only, with
  password login and forwarding disabled.
- Service restart policies, memory limits, 512 MiB swap, traffic counters and
  automatic Debian security updates are enabled. Automatic reboot is disabled.
- Weekly DigitalOcean backups are enabled. This is one server, without
  automatic failover. Restoring into a new Droplet may require IP reapproval.

## Private material

Local administration key: `/Users/apple/.ssh/samrat_gateway_ed25519`.
Local gateway credentials, certificates and connection settings:
`/Users/apple/.config/samrat-gateway/` (directory 0700, files 0600).
These files must never be committed. The CA private key stays on the local
machine. Only the server certificate/key and proxy password are on the gateway,
under `/etc/samrat-gateway/`.

The server certificate expires **28 February 2029**. Renew it using the existing
private CA before expiry, copy the new chain/key, and restart
`stunnel@samrat.service`. The CA expires in November 2036. Keep a secure copy of
the administration key, CA private key and connection settings for recovery.

## App configuration

Both Netlify and the Heroku worker require:

```
STATIC_EGRESS_PROXY_URL=https://USER:PASSWORD@168.144.21.82:8443
STATIC_EGRESS_PROXY_CA_BASE64=BASE64_OF_PRIVATE_CA_PEM
```

The private local `connection.json` contains the real values. For the FTP
worker, keep `FTP_INBOX_USE_STATIC_PROXY=true` and `FTP_INBOX_ROOT=/prod`.
The FTP code uses HTTPS CONNECT for the custom gateway, including passive data
connections. The existing QuotaGuard SOCKS gateway behavior is preserved when
the replacement URL is absent.

The code supports `QUOTAGUARDSTATIC_URL` as a migration fallback when the
replacement URL is absent. That fallback is no longer configured in the live
app after retiring the old add-on. Keep the replacement gateway URL and CA
configured. If a configured gateway fails, requests fail rather than bypassing
it over a direct connection.

## Deployment and cutover checklist

1. Run tests, typecheck, lint and production build. Deploy the compatible code
   while the new environment variables remain unset.
2. Have client IT approve the gateway IP for the same services currently
   approved for QuotaGuard: SAP API 9011, Service Layer 50000, attachments 5061,
   FTP 21 and the configured passive FTP data port range.
3. From the gateway, verify all required services. At initial setup API 9011
   and attachments 5061 were reachable; Service Layer 50000 and FTP 21 timed out.
   HTTP 404 on a probe demonstrates connectivity, not a successful SAP login.
4. Verify read-only SAP authentication/query, an attachment, and an FTP listing
   and download through the new proxy. Do not use live files for an archive
   test. Automated tests exercise archiving against a disposable local FTP
   server and confirm that downloaded bytes are unchanged.
5. Configure the two new environment variables on Netlify and Heroku, redeploy
   Netlify and restart the worker. Verify the receipts page and scheduled work.
   Do not create/post SAP drafts as a connection test.
6. Keep QuotaGuard settings during the transition. After success is verified,
   remove the old paid add-on in a separate deliberate step; do not remove
   rollback configuration before the new route is proven.

After retirement, **do not unset the gateway variables as a rollback**: the old
QuotaGuard account is unavailable. Recover this gateway from its backup or
repair its configuration while retaining the approved IP. If a new IP is
needed, have client IT approve it before switching. Application rollback must
retain/reapply the new gateway URL and CA and use a code version with gateway
support; older deployment snapshots may contain the retired proxy settings.

## Maintenance

SSH using the dedicated key, then check:

```
systemctl is-active tinyproxy stunnel@samrat nftables vnstat
journalctl -u tinyproxy -u stunnel@samrat --since '15 minutes ago'
vnstat --months
free -m
openssl x509 -in /etc/samrat-gateway/server-chain.pem -noout -dates
```

Check DigitalOcean bandwidth and billing projections as well; vnstat counts
both directions and local counters are not the provider's bill. If the client's
DNS address changes, update the outbound firewall and allowed IP after
verifying the new address. Do not broaden the gateway to arbitrary internet
destinations. Test recovery, updates and certificate renewal before relying on
them during an outage.

`install.sh` configures a **dedicated new server** after its packages and private
files are installed. It replaces the gateway firewall ruleset; do not run it on
a shared application/database host. Install packages from Debian's repositories:
`tinyproxy stunnel4 nftables unattended-upgrades vnstat openssl`.
