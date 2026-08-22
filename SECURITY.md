# Security Policy

## Supported versions

OMP Remote is pre-1.0 software. Security support for the current `0.1.x` line is best effort; older lines are not supported. Updates may require upgrading to the latest `0.1.x` release.

## Reporting a vulnerability

Do not open a public issue, discussion, or pull request for a suspected vulnerability.

Until GitHub private vulnerability reporting is enabled when this repository is published, contact [`@howarewoo`](https://github.com/howarewoo) privately using the contact details on that profile. Include the affected version, impact, reproduction steps, and any suggested mitigation. Do not include secrets, private transcripts, credentials, or data belonging to other people unless they are necessary and safe to share.

The maintainer will acknowledge a report when possible, investigate it, and coordinate remediation and disclosure with the reporter. Please allow a reasonable period for a fix before publishing details. There is no bug-bounty program and no guaranteed response or remediation timeline.

## Security model

OMP Remote is designed for one trusted user. The daemon and extension listener remain loopback-only. Tailscale Serve provides private HTTPS access, and Tailnet membership and ACLs are the remote-access boundary; OMP Remote has no application login or authorization layer. Treat every device and user admitted to the Tailnet path as able to access session transcripts and controls.

Do not expose the daemon directly to a LAN or the public internet. Review Tailnet membership and ACLs, keep the host and dependencies updated, and avoid sharing logs or transcripts that may contain prompts, tool output, paths, or process details.

GitHub controls that require a public repository, including private vulnerability reporting and applicable public-repository security features, are intentionally deferred until publication.