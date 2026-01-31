---
"effect-jsonapi": major
---

Major API improvements based on maintainer feedback:

- Split ResourceIdentifier into ResourceIdentifierWithId and ResourceIdentifierWithLid for better type safety
- Split ResourceObject into ResourceObjectWithId and ResourceObjectWithLid, with ResourceObject as a union
- Made Relationship a factory function accepting custom identifier schemas
- Made Document a factory function to support typed data and included fields
- Moved test file from __tests__ directory to alongside main file
- Set up changesets for version management
- Changed Links from S.Record to properly support required keys
- Improved type system enforcement for id/lid requirements

**BREAKING CHANGES:**
- ResourceObject is now a factory function, must be called: `ResourceObject()` instead of `ResourceObject`
- ResourceIdentifier is now a union type; use ResourceIdentifierWithId or ResourceIdentifierWithLid for specific cases
- Relationship is now a factory function: `Relationship()` instead of `Relationship`
- Document is now a factory function: `Document()` instead of `Document`
