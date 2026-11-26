#!/bin/bash
# Run on the dedicated Debian gateway after copying its certificate, key and
# proxy-password into /etc/samrat-gateway (root-owned, mode 0600).
set -euo pipefail
umask 077

if [[ $EUID -ne 0 ]]; then echo "Run as root." >&2; exit 1; fi
for file in server-chain.pem server.key proxy-password; do
  test -s "/etc/samrat-gateway/$file"
done
password=$(cat /etc/samrat-gateway/proxy-password)
if [[ ! $password =~ ^[a-f0-9]{64}$ ]]; then
  echo "Invalid gateway credential file." >&2; exit 1
fi
sap_ip=$(getent ahostsv4 sbivan.samratgroup.com | awk 'NR==1 {print $1}')
if [[ ! $sap_ip =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]]; then
  echo "Could not resolve the SAP server." >&2; exit 1
fi

cat >/etc/tinyproxy/tinyproxy.conf <<EOF
User tinyproxy
Group tinyproxy
Port 8888
Listen 127.0.0.1
Timeout 120
MaxClients 64
Allow 127.0.0.1
BasicAuth samrat $password
LogFile "/var/log/tinyproxy/tinyproxy.log"
LogLevel Warning
PidFile "/run/tinyproxy/tinyproxy.pid"
Filter "/etc/tinyproxy/samrat-allowed-hosts"
FilterType ere
FilterDefaultDeny Yes
FilterCaseSensitive No
DisableViaHeader Yes
EOF
printf '^sbivan\\.samratgroup\\.com$\n^%s$\n' "${sap_ip//./\\.}" >/etc/tinyproxy/samrat-allowed-hosts
chown root:tinyproxy /etc/tinyproxy/tinyproxy.conf /etc/tinyproxy/samrat-allowed-hosts
chmod 640 /etc/tinyproxy/tinyproxy.conf /etc/tinyproxy/samrat-allowed-hosts

cat >/etc/stunnel/samrat.conf <<'EOF'
foreground = yes
debug = warning
setuid = stunnel4
setgid = stunnel4
socket = l:TCP_NODELAY=1
socket = r:TCP_NODELAY=1
[samrat]
accept = 0.0.0.0:8443
connect = 127.0.0.1:8888
cert = /etc/samrat-gateway/server-chain.pem
key = /etc/samrat-gateway/server.key
sslVersionMin = TLSv1.2
EOF

mkdir -p /etc/systemd/system/tinyproxy.service.d /etc/systemd/system/stunnel@samrat.service.d
cat >/etc/systemd/system/tinyproxy.service.d/samrat.conf <<'EOF'
[Service]
Restart=on-failure
RestartSec=3
MemoryMax=160M
NoNewPrivileges=true
ProtectHome=true
EOF
cat >/etc/systemd/system/stunnel@samrat.service.d/samrat.conf <<'EOF'
[Service]
Restart=on-failure
RestartSec=3
MemoryMax=96M
NoNewPrivileges=true
ProtectHome=true
EOF

# This is a dedicated new server. No application/database services run here.
cat >/etc/nftables.conf <<EOF
#!/usr/sbin/nft -f
flush ruleset
table inet samrat_gateway {
  chain input {
    type filter hook input priority 0; policy drop;
    iifname "lo" accept
    ct state established,related accept
    ct state invalid drop
    meta l4proto icmp accept
    meta l4proto ipv6-icmp accept
    udp sport 67 udp dport 68 accept
    tcp dport 22 ct state new limit rate 30/minute burst 20 packets accept
    tcp dport 8443 accept
  }
  chain output {
    type filter hook output priority 0; policy accept;
    meta skuid "tinyproxy" ip daddr 127.0.0.0/8 accept
    meta skuid "tinyproxy" ip daddr $sap_ip accept
    meta skuid "tinyproxy" reject
  }
}
EOF
nft --check --file /etc/nftables.conf

cat >/etc/ssh/sshd_config.d/00-samrat-gateway.conf <<'EOF'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password
MaxAuthTries 3
LoginGraceTime 20
AllowAgentForwarding no
AllowTcpForwarding no
X11Forwarding no
PermitTunnel no
EOF
sshd -t

cat >/etc/apt/apt.conf.d/52samrat-security <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
Unattended-Upgrade::Automatic-Reboot "false";
EOF
mkdir -p /etc/systemd/resolved.conf.d
printf '[Resolve]\nLLMNR=no\nMulticastDNS=no\n' >/etc/systemd/resolved.conf.d/20-samrat.conf

if ! swapon --noheadings --show | grep -q .; then
  fallocate -l 512M /swapfile
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >>/etc/fstab
fi
printf 'vm.swappiness=10\n' >/etc/sysctl.d/80-samrat-gateway.conf
sysctl --load /etc/sysctl.d/80-samrat-gateway.conf >/dev/null

systemctl disable --now exim4.service 2>/dev/null || true
systemctl daemon-reload
systemctl enable --now nftables.service vnstat.service
nft --file /etc/nftables.conf
systemctl restart tinyproxy.service
systemctl enable --now stunnel@samrat.service
systemctl restart systemd-resolved.service
systemctl reload ssh.service

for service in tinyproxy.service stunnel@samrat.service nftables.service vnstat.service; do
  systemctl is-active --quiet "$service"
done
echo "Dedicated gateway configured. Only authenticated TLS traffic to the SAP/FTP host is permitted."
