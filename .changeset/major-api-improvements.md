---
"effect-jsonapi": major
---

Major API improvements and JSON:API compliance fixes:

- Split ResourceIdentifier into ResourceIdentifierWithId and ResourceIdentifierWithLid for better type safety
- Split ResourceObject into ResourceObjectWithId and ResourceObjectWithLid, with ResourceObject as a union
- Made Relationship a factory function accepting custom identifier schemas
- Made Document a factory function with support for separate data and included schemas
- Moved test file from __tests__ directory to alongside main file
- Set up changesets for version management
- Improved type system enforcement for id/lid requirements
- Fixed Relationship to require at least one of data, links, or meta per JSON:API spec
- Fixed Document to require at least one top-level member (data, errors, or meta)
- Document now uses union types to separate data documents from error documents
- Added separate schema support for included resources (can differ from data schema)
- Updated to require Node.js 20+ (for vitest compatibility)
- Added "type": "module" to package.json for proper ESM support

**BREAKING CHANGES:**
- ResourceObject is now a factory function, must be called: `ResourceObject()` instead of `ResourceObject`
- ResourceIdentifier is now a union type; use ResourceIdentifierWithId or ResourceIdentifierWithLid for specific cases
- Relationship is now a factory function: `Relationship()` instead of `Relationship`
- Document is now a factory function with new API: `Document({ data?, included? })` instead of `Document(dataSchema?)`
- Document enforces at least one top-level member (data, errors, or meta)
- Relationship enforces at least one member (data, links, or meta)
- Node.js 20+ now required (was 18+)
- Package is now explicitly ESM ("type": "module")
