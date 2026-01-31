# effect-jsonapi

Type-safe JSON:API v1.1 schema definitions using Effect Schema.

[![npm version](https://badge.fury.io/js/effect-jsonapi.svg)](https://www.npmjs.com/package/effect-jsonapi)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## Overview

This library provides type-safe schema definitions for [JSON:API v1.1](https://jsonapi.org/format/1.1/) using [Effect Schema](https://effect.website/docs/schema/introduction). It allows you to validate and type JSON:API documents, resources, relationships, and errors in your Effect applications.

## Features

- 🔥 Type-safe JSON:API schema definitions using Effect Schema
- 📝 Full JSON:API v1.1 specification compliance
- 🎯 Validates documents, resources, relationships, and errors
- ⚡ Minimal dependencies (only Effect)

## Installation

```bash
npm install effect-jsonapi effect
```

## Quick Start

### Import the schemas

```typescript
import * as Schema from "effect-jsonapi"
import * as S from "effect/Schema"
```

### Validate a JSON:API document

```typescript
import * as Schema from "effect-jsonapi"
import * as S from "effect/Schema"

const document = {
  data: {
    type: "articles",
    id: "1",
    attributes: {
      title: "JSON:API with Effect",
      body: "Learn how to use JSON:API schemas with Effect",
    },
    relationships: {
      author: {
        data: { type: "people", id: "9" }
      }
    }
  }
}

// Validate the document
const result = S.decodeUnknownSync(Schema.Document)(document)
```

### Validate multiple resources

```typescript
const document = {
  data: [
    {
      type: "articles",
      id: "1",
      attributes: { title: "First Article" }
    },
    {
      type: "articles",
      id: "2",
      attributes: { title: "Second Article" }
    }
  ],
  meta: { total: 2 }
}

const result = S.decodeUnknownSync(Schema.Document)(document)
```

### Validate error documents

```typescript
const errorDoc = {
  errors: [
    {
      status: "422",
      title: "Validation Error",
      detail: "Title must be at least 3 characters",
      source: { pointer: "/data/attributes/title" }
    }
  ]
}

const result = S.decodeUnknownSync(Schema.Document)(errorDoc)
```

## API Reference

### Schema Types

The library exports the following JSON:API schema types:

#### `Document`
The top-level JSON:API document structure. Can contain:
- `data` - Single resource, array of resources, or null
- `errors` - Array of error objects
- `meta` - Meta information
- `jsonapi` - JSON:API version information
- `links` - Navigation links
- `included` - Related resources

#### `DocumentCreate`
The top-level JSON:API document structure for create requests. Same as `Document` but uses `ResourceObjectCreate` for the data field, allowing resources without IDs.

#### `ResourceObject`
A JSON:API resource with:
- `type` (required) - Resource type
- `id` (required) - Resource identifier
- `attributes` - Resource attributes
- `relationships` - Relationships to other resources
- `links` - Resource-specific links
- `meta` - Resource-specific metadata

#### `ResourceObjectCreate`
A JSON:API resource for create requests with:
- `type` (required) - Resource type
- `id` (optional) - Resource identifier (can be omitted for server-generated IDs)
- `attributes` - Resource attributes
- `relationships` - Relationships to other resources
- `links` - Resource-specific links
- `meta` - Resource-specific metadata

#### `ResourceIdentifier`
Reference to a resource:
- `type` (required) - Resource type
- `id` (required) - Resource identifier
- `meta` - Optional metadata

#### `Relationship`
Describes a relationship to another resource:
- `data` - Resource identifier(s), array, or null
- `links` - Relationship links
- `meta` - Relationship metadata

#### `ErrorObject`
JSON:API error information:
- `id` - Unique error identifier
- `status` - HTTP status code as string
- `code` - Application-specific error code
- `title` - Error title
- `detail` - Detailed error description
- `source` - Source of the error (pointer, parameter, or header)
- `meta` - Additional metadata

#### `ErrorSource`
Points to the source of an error:
- `pointer` - JSON Pointer to the error location
- `parameter` - Query parameter name
- `header` - Header name

#### `Links`
Navigation links object (string URLs or link objects with href and meta)

#### `JsonApiObject`
JSON:API version information:
- `version` - JSON:API version (e.g., "1.1")
- `meta` - Additional metadata

## Specification Compliance

This library implements the [JSON:API v1.1 specification](https://jsonapi.org/format/1.1/):

- ✅ Document structure (data, errors, meta, links, included)
- ✅ Resource objects (type, id, attributes, relationships)
- ✅ Resource identifier objects
- ✅ Relationship objects
- ✅ Error objects with source pointers
- ✅ Links objects
- ✅ Meta information

## Usage with Effect

The schemas can be used with Effect's validation and decoding functions:

```typescript
import * as Effect from "effect/Effect"
import * as Schema from "effect-jsonapi"
import * as S from "effect/Schema"

// Decode with Effect
const decodeDocument = S.decodeUnknown(Schema.Document)

const program = Effect.gen(function* () {
  const doc = yield* decodeDocument(unknownData)
  // Work with validated document
  return doc
})
```

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

MIT © Thomas Foster

## Links

- [JSON:API Specification](https://jsonapi.org/)
- [Effect Documentation](https://effect.website/)
- [Effect Schema Documentation](https://effect.website/docs/schema/introduction)
- [GitHub Repository](https://github.com/thomasfosterau/effect-jsonapi)

