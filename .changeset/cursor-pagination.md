---
"@thomasfosterau/effect-jsonapi": minor
---

Add `CursorPagination`, the Cursor Pagination profile: `page()` declares `page[size]` / `page[after]` / `page[before]` (a `page[size]` that is not a positive base-10 integer is a 400), `resolve` applies an endpoint's `maxSize`, `defaultSize` and range support, `MaxSizeExceeded`, `RangePaginationNotSupported`, `UnsupportedSort` and `InvalidCursor` are the profile's errors with its `links.type` and `meta.page.maxSize`, `CollectionMeta` / `ItemMeta` / `itemMeta` are its `meta.page` members, and `links` builds its required `prev` / `next`. The conformance kit's profile tier gains `profile/cursor-pagination/prev-next`, `page-size`, `invalid-size` and `max-size-exceeded`.
