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
- 🏷️ Separate types for saved (id) vs unsaved (lid) resources
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
const schema = JsonApi.Document()
const result = S.decodeUnknownSync(schema)(document)
```

### Define custom resource schemas

```typescript
import * as JsonApi from "effect-jsonapi"
import * as S from "effect/Schema"

// Define a typed User resource with id
const User = JsonApi.ResourceObjectWithId({
  type: S.Literal("users"),
  id: S.UUID,
  attributes: S.Struct({
    name: S.String,
    email: S.String
  }),
  relationships: S.Struct({
    posts: JsonApi.Relationship()
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

### Work with unsaved resources (local IDs)

```typescript
// Define a resource with lid for create requests
const NewArticle = JsonApi.ResourceObjectWithLid({
  type: S.Literal("articles"),
  id: S.String, // lid uses the same type parameter
  attributes: S.Struct({
    title: S.String,
    body: S.String
  })
})

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

const schema = JsonApi.Document(NewArticle)
const result = S.decodeUnknownSync(schema)(createRequest)
```

### Custom relationships with typed identifiers

```typescript
// Define a custom identifier schema for people
const PersonIdentifier = S.Struct({
  type: S.Literal("people"),
  id: S.UUID
})

// Use it in a relationship
const Article = JsonApi.ResourceObjectWithId({
  type: S.Literal("articles"),
  id: S.String,
  attributes: S.Struct({
    title: S.String
  }),
  relationships: S.Struct({
    author: JsonApi.Relationship(PersonIdentifier)
  })
})
```

### Typed documents with included resources

```typescript
const ArticleSchema = JsonApi.ResourceObjectWithId({
  type: S.Literal("articles"),
  id: S.String,
  attributes: S.Struct({ title: S.String })
})

const PersonSchema = JsonApi.ResourceObjectWithId({
  type: S.Literal("people"),
  id: S.String,
  attributes: S.Struct({ name: S.String })
})

// Document with separate schemas for data and included
const DocumentSchema = JsonApi.Document({
  data: ArticleSchema,
  included: S.Union(ArticleSchema, PersonSchema) // Can include multiple types
})

const document = {
  data: {
    type: "articles",
    id: "1",
    attributes: { title: "Hello" }
  },
  included: [
    {
      type: "people",
      id: "9",
      attributes: { name: "John Doe" }
    }
  ]
}

const result = S.decodeUnknownSync(DocumentSchema)(document)
```

## API Reference

### Schema Types

#### `ResourceObjectWithId(options?)`
Factory function that creates a Resource Object schema for **saved resources** with server-assigned IDs.

**Parameters:**
- `type` - Schema for resource type
- `id` - Schema for resource id
- `attributes` - Schema for resource attributes
- `relationships` - Schema for relationships object
- `links` - Schema for links object
- `meta` - Schema for meta object

**Returns:** A schema that validates resource objects with `id`

#### `ResourceObjectWithLid(options?)`
Factory function that creates a Resource Object schema for **unsaved resources** with client-generated local IDs.

**Parameters:**
- `type` - Schema for resource type
- `id` - Schema for resource lid (uses same parameter name)
- `attributes` - Schema for resource attributes
- `relationships` - Schema for relationships object
- `links` - Schema for links object
- `meta` - Schema for meta object

**Returns:** A schema that validates resource objects with `lid`

#### `ResourceObject(options?)`
Factory function that creates a Resource Object schema that accepts **either** id or lid.

**Returns:** Union of `ResourceObjectWithId` and `ResourceObjectWithLid`

#### `Document(options?)`
Factory function that creates a Document schema.

**Parameters:**
- `options.data` - Optional schema for the data field
- `options.included` - Optional schema for the included field (defaults to same as data)

**Returns:** A schema that validates JSON:API documents

**Note:** The Document schema enforces JSON:API constraints:
- At least one of `data`, `errors`, or `meta` must be present
- `data` and `errors` cannot coexist in the same document

#### `ResourceIdentifierWithId`
Schema for resource identifiers with server-assigned IDs:
- `type` (required) - Resource type
- `id` (required) - Resource identifier
- `meta` (optional) - Metadata

#### `ResourceIdentifierWithLid`
Schema for resource identifiers with client-generated local IDs:
- `type` (required) - Resource type
- `lid` (required) - Local identifier
- `meta` (optional) - Metadata

#### `ResourceIdentifier`
Union of `ResourceIdentifierWithId` and `ResourceIdentifierWithLid`

#### `Relationship(identifierSchema?)`
Factory function that creates a Relationship schema.

**Parameters:**
- `identifierSchema` - Optional custom schema for resource identifiers

**Returns:** A schema that validates relationship objects

**Note:** The Relationship schema enforces JSON:API constraints:
- At least one of `data`, `links`, or `meta` must be present

#### `ErrorObject`
Schema for JSON:API error objects:
- `id` - Unique error identifier
- `status` - HTTP status code as string
- `code` - Application-specific error code
- `title` - Error title
- `detail` - Detailed error description
- `source` - Source of the error (pointer, parameter, or header)
- `meta` - Additional metadata

#### `ErrorSource`
Schema for error source information:
- `pointer` - JSON Pointer to the error location
- `parameter` - Query parameter name
- `header` - Header name

#### `Link`
Schema for links (string URL or object with href and metadata)

#### `JsonApiObject`
Schema for JSON:API version information:
- `version` - JSON:API version (e.g., "1.1")
- `meta` - Additional metadata

## Specification Compliance

This library implements key parts of the [JSON:API v1.1 specification](https://jsonapi.org/format/1.1/):

- ✅ Document structure (data, errors, meta, links, included)
- ⚠️  Mutual exclusivity of data and errors (enforced via union types, but excess properties may be stripped during validation)
- ✅ Requires at least one top-level member (data, errors, or meta)
- ✅ Resource objects with id or lid
- ✅ Resource identifier objects (separate types for id/lid)
- ✅ Relationship objects with at least one member required
- ✅ Relationship custom identifier schemas
- ✅ Error objects with source pointers
- ✅ Links objects (string or object form)
- ✅ Local identifiers (lid) for unsaved resources
- ✅ Separate schemas for data and included resources
- ✅ Meta information

**Note:** This library focuses on schema validation. The Document schema uses a union type to separate data documents from error documents, which provides type safety. However, due to how Effect Schema handles unions and excess properties, documents with both `data` and `errors` may be accepted (matching one of the union variants). In practice, JSON:API servers should not send such malformed documents. Some aspects of JSON:API (like content negotiation, query parameters, etc.) are outside this library's scope.

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
