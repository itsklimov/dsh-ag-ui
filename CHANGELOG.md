# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Native `present` declarations project as durable `dsh-deliverables` activities with authenticated, bounded Session-filesystem downloads.

- Deterministic per-thread workspaces with DSH Web workspace registration when the Host provides it.
- Native `@ag-ui/a2ui-middleware` render settlement and canonical validated user-action continuation across DSH turns.
- Middleware-flagged A2UI render calls settle inside their run with `{"status":"rendered"}` instead of parking for a browser result the middleware never sends.
- Durable native projection of frontend Tool-result metadata through DSH presentation metadata.
- A `dsh-ag-ui/client` companion whose `DshHttpAgent` sends only messages relevant to the stateful Gateway's next admission while retaining full client history.
- Per-tenant `selectableAgentPresets` grants let a run select a blank thread composition through native `agentPresets.select`; history stays read-only and started threads keep their recorded preset.

