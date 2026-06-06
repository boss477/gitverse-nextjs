# Changelog

All notable changes to this project will be documented here.

## [Unreleased]

### Added
- Initial changelog created

### Changed

### Deprecated

### Removed

### Fixed
- TOCTOU race condition in checkRateLimit — replaced non-atomic count-then-create with atomic upsert on a @@unique([key, expiresAt]) constraint
- P2002 catch block is no longer dead code; it enforces limits under concurrent writes
- Switched from sliding-window per-request entries to fixed-window single-entry upsert for atomicity

### Security
