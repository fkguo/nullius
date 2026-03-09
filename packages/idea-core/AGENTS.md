# idea-core — Agent Notes

## Repo hygiene

- Do not check raw reviewer prompts, transcripts, per-run receipts, or local review workflow files into this repo.
- Keep local review materials outside the repo; distill only durable conclusions into checked-in docs or trackers.

## Network / push policy

- Mandatory before `git push`: always export proxy variables in the current shell.
- Default proxy values on this machine:
  - `https_proxy=http://127.0.0.1:7890`
  - `http_proxy=http://127.0.0.1:7890`
  - `all_proxy=socks5://127.0.0.1:7890`
