# Security Policy

## Supported versions

Security fixes are applied to the latest version on the `main` branch.

## Reporting a vulnerability

Please use GitHub's private security-advisory flow for the repository rather than opening a public issue. Include the affected file or tool, reproduction steps, impact, and any suggested mitigation.

## Security boundaries

This project is intentionally read-only and uses Sleeper's public API without a password, session cookie, API key, or unofficial account token. It should not be extended to accept, reject, create, or cancel trades through reverse-engineered authenticated endpoints.

The server sends requests only to `https://api.sleeper.app/v1`. It writes only the public NFL player directory to the configured local cache directory. Sleeper-returned names and metadata should always be treated as untrusted data.
