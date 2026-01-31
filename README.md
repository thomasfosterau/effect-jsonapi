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
- 🔧 Customizable resource schemas with type constraints
- ⚡ Minimal dependencies (only Effect)

## Installation

```bash
npm install effect-jsonapi effect
```

## Quick Start

### Validate a JSON:API document

```typescript
import * as JsonApi from "effect-jsonapi"
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
const result = S.decodeUnknownSync(JsonApi.Document)(document)
```

### Define custom resource schemas

```typescript
import * as JsonApi from "effect-jsonapi"
import * as S from "effect/Schema"

// Define a typed User resource
const User = JsonApi.ResourceObject({
  type: S.Literal("users"),
  id: S.UUID,
  attributes: S.Struct({
    name: S.String,
    email: S.String
  }),
  relationships: S.Struct({
    posts: JsonApi.Relationship
  })
})

// Validate a user resource
const user = {
  type: "users",
  id: "550e8400-e29b-41d4-a716-446655440000",
  attributes: {
    name: "John Doe",
    email: "john@example.com"
  }
}

const validatedUser = S.decodeUnknownSync(User)(user)
```

### Validate resources with local IDs

```typescript
// Resources can use 'lid' (local id) for client-generated temporary identifiers
const createRequest = {
  data: {
    type: "articles",
    lid: "temp-1",
    attributes: {
      title: "New Article",
      body: "Content"
    }
  }
}

const result = S.decodeUnknownSync(JsonApi.Document)(createRequest)
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

const result = S.decodeUnknownSync(JsonApi.Document)(document)
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

const result = S.decodeUnknownSync(JsonApi.Document)(errorDoc)
```

## API Reference

### Schema Types

#### `ResourceObject(options?)`
Factory function that creates a Resource Object schema with optional type constraints.

**Parameters:**
- `type` - Schema for resource type (default: `S.String`)
- `id` - Schema for resource id (default: `S.String`)
- `lid` - Schema for resource lid (default: `S.String`)
- `attributes` - Schema for resource attributes
- `relationships` - Schema for relationships object
- `links` - Schema for links object
- `meta` - Schema for meta object

**Returns:** A schema that validates resource objects

#### `Document`
The top-level JSON:API document structure. Can contain:
- `data` - Single resource, array of resources, or null
- `errors` - Array of error objects
- `meta` - Meta information
- `jsonapi` - JSON:API version information
- `links` - Navigation links
- `included` - Related resources

#### `ResourceIdentifier`
Reference to a resource with:
- `type` (required) - Resource type
- `id` (optional) - Resource identifier (for saved resources)
- `lid` (optional) - Local identifier (for unsaved resources)
- `meta` (optional) - Metadata

**Note:** Must have either `id` or `lid` (or both)

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

#### `Link`
A link can be:
- A string containing the URL
- An object with `href` and optional metadata

#### `Links`
Navigation links object (record of named links)

#### `JsonApiObject`
JSON:API version information:
- `version` - JSON:API version (e.g., "1.1")
- `meta` - Additional metadata

## Specification Compliance

This library implements the [JSON:API v1.1 specification](https://jsonapi.org/format/1.1/):

- ✅ Document structure (data, errors, meta, links, included)
- ✅ Resource objects (type, id/lid, attributes, relationships)
- ✅ Resource identifier objects
- ✅ Relationship objects
- ✅ Error objects with source pointers
- ✅ Links objects (string or object form)
- ✅ Local identifiers (lid) for unsaved resources
- ✅ Meta information

## Usage with Effect

The schemas can be used with Effect's validation and decoding functions:

```typescript
import * as Effect from "effect/Effect"
import * as JsonApi from "effect-jsonapi"
import * as S from "effect/Schema"

// Decode with Effect
const decodeDocument = S.decodeUnknown(JsonApi.Document)

const program = Effect.gen(function* () {
  const doc = yield* decodeDocument(unknownData)
  // Work with validated document
  return doc
})
```

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

See [CONTRIBUTING.md](CONTRIBUTING.md) for more details.

## License

MIT © Thomas Foster

## Links

- [JSON:API Specification](https://jsonapi.org/)
- [Effect Documentation](https://effect.website/)
- [Effect Schema Documentation](https://effect.website/docs/schema/introduction)
- [GitHub Repository](https://github.com/thomasfosterau/effect-jsonapi)
