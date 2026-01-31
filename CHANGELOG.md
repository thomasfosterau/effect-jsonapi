# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-01-31

### Added
- Initial release of effect-jsonapi
- Core JSON:API schema definitions using Effect Schema
- Type-safe validation for JSON:API documents, resources, relationships, and errors
- Full TypeScript support with type definitions
- Comprehensive test suite with vitest
- Complete documentation with JSDoc comments from JSON:API spec
- `ResourceObject` factory function for creating typed resource schemas
- Support for `lid` (local identifiers) for unsaved resources
- `Link` schema supporting both string and object forms

### Features
- ✅ JSON:API v1.1 specification compliance
- ✅ Type-safe schema definitions with Effect Schema
- ✅ Document validation (data, errors, meta, links, included)
- ✅ Resource object validation (type, id/lid, attributes, relationships)
- ✅ Error object validation with source pointers
- ✅ Relationship validation (to-one, to-many)
- ✅ Customizable resource schemas with type constraints

[0.1.0]: https://github.com/thomasfosterau/effect-jsonapi/releases/tag/v0.1.0
