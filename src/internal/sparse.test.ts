/**
 * `sparseResource`: the partial-attributes resource object a read endpoint
 * that declares `fields` binds by default (#322). Its contract beyond the
 * attributes being optional: an attribute already optional is the declared
 * schema itself, the definition's annotations carry over to the partial
 * schema, and its `identifier` does not — that names the strict definition,
 * so the two would collide as one OpenAPI component.
 */
import { describe, expect, it } from "vite-plus/test";
import * as Predicate from "effect/Predicate";
import * as Rec from "effect/Record";
import * as Schema from "effect/Schema";
import { HttpApi, OpenApi } from "effect/http-api";
import * as Endpoint from "../Endpoint.js";
import * as Group from "../Group.js";
import * as Resource from "../Resource.js";
import { sparseResource } from "./sparse.js";

const subtitle = Schema.optionalKey(Schema.String);
const Article = Resource.make("articles", {
  attributes: { title: Schema.String, subtitle },
  annotations: { description: "An article", identifier: "Article" },
});

// Whether attribute `key` of a resource object struct is the schema `expected`.
const attributeIs = (schema: Schema.Top, key: string, expected: Schema.Top): boolean =>
  Predicate.hasProperty(schema, "fields") &&
  Predicate.hasProperty(schema.fields, "attributes") &&
  Predicate.hasProperty(schema.fields.attributes, "fields") &&
  Predicate.hasProperty(schema.fields.attributes.fields, key) &&
  schema.fields.attributes.fields[key] === expected;

// The OpenAPI document of an api serving `Article` strict (`list`) and
// partial (`get`).
const openApi = () =>
  OpenApi.fromApi(
    HttpApi.make("sparse").add(
      Group.make(
        Article,
        Endpoint.get(Article, { fields: true }),
        Endpoint.list(Article, { fields: false }),
      ),
    ),
  );

// An OpenAPI document whose `get` response `data` schema matches `data`.
const getData = <Data>(data: Data) => ({
  paths: {
    "/articles/{id}": {
      get: {
        responses: {
          200: { content: { "application/vnd.api+json": { schema: { properties: { data } } } } },
        },
      },
    },
  },
});

describe("sparseResource (#322)", () => {
  it("is built once per definition", () => {
    expect(sparseResource(Article)).toBe(sparseResource(Article));
  });

  it("keeps an already-optional attribute as declared and wraps the rest", () => {
    const sparse = sparseResource(Article);
    expect(attributeIs(sparse, "subtitle", subtitle)).toBe(true);
    expect(attributeIs(sparse, "title", Article.fields.attributes.fields.title)).toBe(false);
    // Positive control: the strict definition carries its declared `title`.
    expect(attributeIs(Article, "title", Article.fields.attributes.fields.title)).toBe(true);
  });

  it("carries the definition's annotations onto the partial schema", () => {
    expect(openApi()).toMatchObject(
      getData({
        description: "An article",
        // Positive control: this is the partial schema, no attribute required.
        properties: { attributes: expect.not.objectContaining({ required: expect.anything() }) },
      }),
    );
  });

  it("drops a user `identifier`, so the strict component is the only one named", () => {
    const document = openApi();
    expect(
      Rec.keys(document.components.schemas).filter((name) => name.startsWith("Article")),
    ).toEqual(["Article"]);
    // The component is the strict definition…
    expect(document.components.schemas).toMatchObject({
      Article: { properties: { attributes: { required: ["title"] } } },
    });
    // …and the partial schema is inlined rather than a reference to it.
    expect(document).toMatchObject(
      getData(expect.not.objectContaining({ $ref: expect.anything() })),
    );
    expect(document).toMatchObject(
      getData({ properties: { attributes: { properties: { title: { type: "string" } } } } }),
    );
  });
});
