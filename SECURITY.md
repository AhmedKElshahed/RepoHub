# Security policy

## Reporting a vulnerability

Please **do not open a public issue** for security problems. Use GitHub's private reporting instead: [report a vulnerability](https://github.com/AhmedKElshahed/RepoHub/security/advisories/new), or open the repository's **Security** tab and choose **Report a vulnerability**.

Include what you found, the steps to reproduce it, and the impact you see. I will acknowledge a report as soon as I can and keep you updated while it is fixed.

## What counts as a vulnerability

RepoHub is built to run third-party code *on request*, so these are in scope:

- Running a command without the user's confirmation (trust-gate bypass).
- Any way for a web page, or another machine, to reach the API (`Host`/`Origin` check bypass, binding beyond localhost).
- Command or argument injection through the API, or path traversal outside `managed_repos/`.
- Leaking the stored GitHub token (to logs, API responses, or any host other than `api.github.com`).

Out of scope: malicious or buggy code inside a repository that you chose to trust and run. RepoHub shows you the commands but cannot judge the code behind them.

## Supported versions

Only the latest release on the default branch receives fixes.
