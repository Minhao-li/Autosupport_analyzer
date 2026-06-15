"""Vertical / component taxonomy and file classification.

The taxonomy mirrors the live deployment's /api/plugins response. Each component
carries simple substring/regex patterns used to classify log file paths into a
component. (The original engine's exact patterns are not visible; these are a
best-effort reconstruction keyed off NetApp ASUP log conventions.)
"""
import re

# vertical -> (display_name, display_order, [components])
# component -> (key, display_name, [patterns])
TAXONOMY = [
    ("core", "Core", 10, [
        ("audit_mgmt", "Audit & Mgmt API", [
            "audit", "mgwd", "mgmt", "command-history", "apache", "zapi", "web_server",
            "web-crypto", "vserver_web", "multi-admin", "userprofile", "diff-svcs",
        ]),
        ("autosupport_config", "AutoSupport Config", [
            "autosupport.xml", "autosupport-check", "autosupport-trigger", "autosupport_budget",
            "autosupport_history", "autosupport-history", "autosupport-config", "autosupport-destination",
            "asup-config", "asup_config", "ems_asup", "ems-asup", "notifyd-diagnostics",
        ]),
        ("autosupport", "AutoSupport", ["autosupport", "asup", "notifyd", "spmgwd", "spider"]),
        ("ems_messages", "EMS & Messages", [
            "ems", "messages", "event-filter", "event-manager", "event-notification", "event-notification-destination",
            "frs-notification", "frs-package", "frs-subscriber", "pubsub", "mtrace-log", "notification",
            "qpid", "cm-daemon",
        ]),
        ("name_services", "Name Services (DNS/NIS/LDAP)", [
            "dns", "ddns", "nis", "nisdb", "ldap", "nsswitch", "ns-cache", "ns-options", "ns-switch",
            "unix-user", "unix-group", "ipcache", "krb5", "exports-host-to-ip", "netgroup",
        ]),
        ("kernel_sktrace", "Kernel / Core", [
            "kernel", "panic", "core.", "coredump", "all_coredump", "dmesg", "kenv",
            "memerr", "leak-data", "sldiag",
        ]),
        ("trace", "Trace (sktrace / rastrace)", [
            "sktrace", "rastrace", "ra-strace", "ra_strace", "backtrace",
            "trace-buffer", "tracebuffer", "wafltrace",
        ]),
        ("limits", "Limits", [
            "session-vserver-limits", "session-location-limits", "session-request-limits",
            "vserver-limits", "location-limits", "request-limits", "session-limits",
        ]),
        ("licensing", "Licensing / Inventory", [
            "license", "managed-feature", "capability-summary", "entitlement", "serial-number",
            "system-serial", "manufacturing-info", "software_image", "node-info", "nodelist",
            "system-info", "system_info", "ioxm-info", "vm-hypervisor",
        ]),
        ("rdb_quorum", "RDB / Cluster Quorum", [
            "rdb", "mgwd_rdb", "quorum", "vifmgr", "bcomd", "cluster", "clam", "smdb", "vldb",
            "jm_history", "jm_sched", "nextidtable", "msidtable", "familytable",
            "filerbladetable", "spider-list", "spider-history",
        ]),
        ("cluster_session_mgr", "Cluster Session Manager (CSM)", ["csm-", "csm_", "csm."]),
        ("security_auth", "Security & Auth", [
            "secd", "security", "auth", "login", "ssh", "cert", "ca_issued", "key-manager",
            "keymanager", "kma-", "kma_", "kmip", "ocsp", "tpm", "ipsec", "strongswan", "charon",
            "vs-firewall", "ipfilters", "crypto", "snaplock",
        ]),
        ("system_info", "System / Boot / Config", [
            "sysconfig", "boot", "config", "version", "registry", "options.txt", "options.xml",
            "usage", "timezone", "shutdown", "upgrade", "auto-update", "var-etc", "bsd-sysctl",
            "bsd-jls", "periodic", "fstab", "header", "x-header", "log_files", "backup",
            "detect-switchless", "bsd-tmp", "bsd-ipfw", "bsd-find", "service-usage", "bsd-du", "bsd-fstat",
            "node_root_mount", "node-root-mount", "partition",
        ]),
        ("misc", "Misc / Unknown", []),
    ]),
    ("storage", "Storage", 20, [
        ("aggregate", "Aggregate", ["aggr", "aggregate", "array_profile", "array-profile"]),
        ("snapshot_efficiency", "Snapshot / Dedupe / Efficiency", [
            "snapshot", "snap-", "snap_", "dedupe", "sis-", "sis_", "-sis", "_sis",
            "efficiency", "compaction", "garbage-collection", "cps-st-area",
        ]),
        ("volume", "Volume / FlexGroup / Quota", [
            "volume", "vol-", "vol_", "vol-status", "vol-language", "flexgroup", "quota", "qtree",
            "df.txt", "df-", "junction", "vvoltable",
        ]),
        ("wafl_raid", "WAFL / RAID / Disk", [
            "wafl", "raid", "disk", "storage_disk", "sysconfig-r", "spinvfs", "spinhi", "fibmap",
            "vsmap", "storage-dqp", "storage-path", "storage_path",
        ]),
        ("storage_devices", "Storage Ports / Bridges / Tape", [
            "storage-port", "storage-bridge", "storage-expander", "storage-hub", "storage-initiator",
            "storage-fault", "storage-shm", "storage-stackmon", "storage-master-node", "storage-tape",
            "device-discovery", "boot-device", "flash-card",
        ]),
        ("application_mgmt", "Applications / Provisioning", ["appdm", "aps-", "application"]),
    ]),
    ("network", "Network", 30, [
        ("lifs_ipspaces", "LIFs / IPspaces / Routes", [
            "lif", "ipspace", "route", "ifgrp", "broadcast-domain", "network-interface",
            "network-port", "network-service", "net-vserver-iface", "net-object-limits", "vif-ids",
            "cdb-net", "reachability", "netopts", "netsetup", "vlan", "ethernet",
        ]),
        ("netstat_traffic", "Netstat / Traffic / Adapters", [
            "netstat", "ifstat", "adapter", "nic", "traffic", "sockstat", "arp", "bgp", "cdpd",
            "ntpdc", "ntp-conf", "rtag-t-mbuf",
        ]),
    ]),
    ("protocols", "Protocols (NAS / SAN)", 40, [
        ("nas", "NAS (CIFS / NFS / S3)", [
            "cifs", "nfs", "smb", "fpolicy", "vscan", "antivirus", "nblade", "export", "copy-offload",
            "spinnp", "flexcache", "s3", "object-store", "object_store", "bucket",
        ]),
        ("san", "SAN (iSCSI / FCP / NVMe)", [
            "iscsi", "fcp", "nvme", "nvmf", "lun", "scsitarget", "fc-device", "fc-link", "fc-stats",
            "fc-",
        ]),
    ]),
    ("hardware", "Hardware", 50, [
        ("ha_interconnect", "HA / Storage Failover", [
            "cf-", "cf_", "cfmd", "sfo", "failover", "interconnect", "ic_", "ic-stats", "haic", "hamsg",
            "ha-rastrace", "mailbox", "ndo-manager", "fabriclink", "rdma-", "rdma_",
        ]),
        ("platform", "Platform / Motherboard / PCI", [
            "platform", "pci-", "-pci-", "_pci", "pci.", "motherboard", "sensors", "environment", "memerr-verbose",
            "dimm", "nvdimm", "hwassist",
        ]),
        ("shelf_sas", "Shelf / SAS / ACP", ["shelf", "sas", "acp", "ses-", "-ses-", "enclosure"]),
        ("sp_bmc", "Service Processor / BMC", ["^sp-", "^sp_", "bmc", "ipmi", "service-processor", "service_processor"]),
    ]),
    ("dp", "Data Protection", 60, [
        ("ndmp_vserver_dr", "NDMP / vServer DR / Peer", [
            "ndmp", "vserver-dr", "peer", "vsdr", "svm-migrate", "vserver-migrate", "vserver-info", "vserver",
        ]),
        ("snapmirror", "SnapMirror", ["snapmirror", "sm_", "dpmgrd", "crs-", "vsun"]),
        ("anti_ransomware", "Anti-Ransomware (ARW)", ["arw", "anti-ransomware", "ransomware"]),
    ]),
    ("performance", "Performance", 70, [
        ("cpu_mem_stats", "CPU / Memory / Stats", [
            "statit", "cpu", "memory", "perfstat", "sysstat", "rpc", "vmstat", "vm-stat", "top_",
            "top-", "ps-ax", "svstat", "cgstat", "swapinfo", "smf_metrics", "zapi-stats", "zapi-kern",
            "ctran-client-stats", "nperf", "performance.txt", "mroot-spinvfs-stats", "counters", "cm-stats",
        ]),
        ("qos_workload", "QoS / Workload", ["qos", "workload", "wafltop"]),
    ]),
    ("misc", "Other / Unclassified", 999, [
        ("mlog_misc", "Other mlog / debug", ["mlog", "debug", "syslog"]),
    ]),
]

# pattern counts shown in the original UI (per component)
PATTERN_COUNTS = {
    "audit_mgmt": 16, "autosupport": 11, "autosupport_config": 13, "ems_messages": 12,
    "misc": 0, "rdb_quorum": 21, "security_auth": 11, "system_info": 31,
    "kernel_sktrace": 9, "trace": 8,
    "aggregate": 12, "snapshot_efficiency": 9, "volume": 12, "wafl_raid": 12,
    "lifs_ipspaces": 15, "netstat_traffic": 13, "nas": 17, "san": 6,
    "ha_interconnect": 8, "platform": 17, "shelf_sas": 11, "sp_bmc": 7,
    "ndmp_vserver_dr": 9, "snapmirror": 11, "cpu_mem_stats": 9, "qos_workload": 5,
    "mlog_misc": 7,
}

# Generic, file-type-ish patterns (all under system_info) that should only win
# when no more specific feature pattern matches — otherwise broad tokens like
# "config"/"version" steal feature files (e.g. cifs-config, crs-config) from
# their proper component, which sits in a later vertical.
_GENERIC = {
    "config", "version", "boot", "usage", "backup", "periodic", "registry",
    "options.txt", "options.xml", "header", "x-header", "log_files",
    "upgrade", "shutdown", "timezone", "fstab", "var-etc",
}

# (component_key, raw_token, substring_regex, prefix_regex, is_generic)
_COMPONENT_PATTERNS = []
_COMPONENT_VERTICAL = {}
for _vkey, _vname, _order, _comps in TAXONOMY:
    for _ckey, _cname, _pats in _comps:
        _COMPONENT_VERTICAL[_ckey] = _vkey
        for _p in _pats:
            _anchored = _p.startswith("^")
            _raw = _p[1:] if _anchored else _p
            _substr = re.compile(("^" if _anchored else "") + re.escape(_raw), re.IGNORECASE)
            _prefix = re.compile("^" + re.escape(_raw), re.IGNORECASE)
            _COMPONENT_PATTERNS.append((_ckey, _raw, _substr, _prefix, _raw in _GENERIC))


def plugins_payload():
    out = []
    for vkey, vname, order, comps in TAXONOMY:
        out.append({
            "vertical": vkey,
            "display_name": vname,
            "display_order": order,
            "components": [
                {"component": ckey, "display_name": cname, "patterns": len(pats)}
                for ckey, cname, pats in comps
            ],
        })
    return out


def vertical_of(component: str) -> str:
    return _COMPONENT_VERTICAL.get(component, "misc")


def classify_path(path: str) -> str:
    """Return the component key a file path belongs to.

    Resolution order (most to least specific):
      1. Longest pattern that matches the *start* of the filename. NetApp log
         names lead with their feature (e.g. ``cifs-config-count.xml`` →
         ``cifs``), so a leading-token match is the strongest signal.
      2. Substring match in the filename, feature patterns before generic
         file-type patterns (``config``/``version``/…), in taxonomy order.
      3. Substring match anywhere in the path.
    """
    low = path.lower().replace("\\", "/")
    name = low.rsplit("/", 1)[-1]

    # 1) longest leading-token (prefix) match on the filename.
    best = None
    best_len = -1
    for ckey, raw, _substr, prefix, _gen in _COMPONENT_PATTERNS:
        if prefix.match(name) and len(raw) > best_len:
            best, best_len = ckey, len(raw)
    if best is not None:
        return best

    # 2) substring in filename — feature patterns first, then generic.
    for ckey, _raw, substr, _prefix, gen in _COMPONENT_PATTERNS:
        if not gen and substr.search(name):
            return ckey
    for ckey, _raw, substr, _prefix, gen in _COMPONENT_PATTERNS:
        if gen and substr.search(name):
            return ckey

    # 3) substring anywhere in the path.
    for ckey, _raw, substr, _prefix, _gen in _COMPONENT_PATTERNS:
        if substr.search(low):
            return ckey
    return "mlog_misc"
