# Security Policy

## Reporting a vulnerability

Please do not file a public issue for a suspected vulnerability or include credentials, access tokens, private workspace content, or exploit payloads in public discussions. Use the repository's private GitHub security-advisory channel when available; otherwise contact the project maintainer through an established private channel and ask for a secure reporting route. Include the affected Axiom version, impact, reproduction steps using test data, and any suggested mitigation. The maintainer will acknowledge the report, investigate it, coordinate remediation, and disclose it only after affected users have a safe update path.

Never send a live secret. Revoke a credential before sharing a redacted example. The previously exposed GitHub OAuth client secret must be revoked or rotated; Axiom's GitHub Device Flow requires only its public client ID and must never contain a confidential client secret.

## Supported release

Security fixes target the current `1.0.5` desktop line until a newer supported release is announced. Electron is pinned to `33.2.0` for this release. Unsupported local modifications and unsigned development packages are not release artifacts.

## Security posture

Axiom separates Electron Main, preload, and renderer trust boundaries; enables sandboxing and context isolation; validates IPC and workspace paths in Main; restricts renderer navigation, permissions, downloads, and external URLs; and verifies update bytes against release metadata before execution. Credentials persisted by Main require Electron `safeStorage`; storage fails closed when OS encryption is unavailable. See [Security architecture](docs/security-architecture.md) and [Release hardening](docs/release-hardening.md).

These controls reduce risk but do not make workspace content trustworthy, replace dependency review, or establish publisher identity. ASAR packaging and minification do not hide source code. SHA-256 sidecars detect accidental or malicious byte changes only when compared with a trusted value; they are not signatures. Unsigned/local builds and hashes alone do not establish publisher authenticity. Compromise of a local administrator, the operating system, build host, signing key, or an already-authorized account is outside the application threat model.
