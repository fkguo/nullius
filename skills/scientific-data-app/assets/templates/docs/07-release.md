# Release — <APP>

Version: TODO · Build: TODO · Date: TODO

## Toolchain

Only measured values. A version is listed after it has produced a successful build.

| Item | Value | How verified |
| --- | --- | --- |
| OS / architecture | TODO | TODO |
| Framework / runtime | TODO | TODO |
| SDK / compiler | TODO | TODO |
| Package manager / lockfile | TODO | TODO |

## Data licensing

| Dataset | Terms | Attribution | Redistributed in app? |
| --- | --- | --- | --- |
| TODO | TODO | TODO | yes / no |

Rules: code licence and data licence are separate; a bundled asset lists its terms in the
About/Help surface; assets that may not be redistributed are downloaded instead.

## Signing

| Platform | Identity | Key location | Custody / backup | What breaks if lost |
| --- | --- | --- | --- | --- |
| TODO | TODO | outside repo | TODO | TODO |

Never delete, regenerate or commit keys. If a key is lost, record the consequence for
existing installs before generating a new one.

## Update channel

- Manifest URL and fallback:
  TODO.
- What the app compares (version, build, platform):
  TODO.
- How a released build was checked against the manifest:
  TODO.

## Platform matrix

| Platform | Build | Smoke test | Notes |
| --- | --- | --- | --- |
| TODO | pass / fail / untested | pass / fail / untested | TODO |

A build on one platform is not evidence for another.

## Checklist

- [ ] version and build number consistent across app, manifest and store metadata
- [ ] dataset asset hash verified after packaging
- [ ] analyse/tests green on the release configuration
- [ ] data terms and attribution present in the app
- [ ] signing identity matches the recorded one
- [ ] update manifest points at this version
- [ ] known issues listed in the release notes
- [ ] rollback described

## Rollback

What a user does if this release is bad, and what the maintainer does to the update
manifest.
TODO.
