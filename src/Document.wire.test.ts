/**
 * `Document.wire`: the link fields become strings, everything else — ids,
 * `Date` codecs, optionality, unions — is untouched.
 */
import { describe, expect, it } from "vite-plus/test";
import { Schema } from "effect";
import * as Document from "./Document.js";
import * as Relationship from "./Relationship.js";
import * as Resource from "./Resource.js";

const decode = <S extends Schema.Top>(schema: S) =>
  Schema.decodeUnknownSync(schema as unknown as Schema.Codec<S["Type"]>);

const Place = Resource.make("places", { attributes: { name: Schema.NonEmptyString } });
const Person = Resource.make("people", {
  attributes: { name: Schema.NonEmptyString, bornAt: Schema.Date },
  relationships: { birthPlace: Relationship.one(() => Place) },
});

describe("Document.wire", () => {
  it("accepts string links where the resource declared `URL | string`, and never revives a URL", () => {
    const wired = decode(Document.wire(Person))({
      type: "people",
      id: "1",
      attributes: { name: "Ada", bornAt: new Date("1815-12-10T00:00:00.000Z") },
      relationships: {
        birthPlace: {
          data: { type: "places", id: "p1" },
          links: { related: "https://example.test/people/1/birthPlace" },
        },
      },
      links: { self: "https://example.test/people/1" },
    });
    expect(typeof wired.links?.self).toBe("string");
    expect(wired.relationships?.birthPlace?.links?.related).toBe(
      "https://example.test/people/1/birthPlace",
    );
    // Everything else keeps its codec: the date is still a date.
    expect(wired.attributes.bornAt).toBeInstanceOf(Date);
  });

  it("keeps every link member optional, and the blocks themselves", () => {
    const Wire = Document.wire(Person);
    expect(() =>
      decode(Wire)({
        type: "people",
        id: "1",
        attributes: { name: "Ada", bornAt: new Date("2020-01-01T00:00:00.000Z") },
      }),
    ).not.toThrow();
    expect(() =>
      decode(Wire)({
        type: "people",
        id: "1",
        attributes: { name: "Ada", bornAt: new Date("2020-01-01T00:00:00.000Z") },
        relationships: { birthPlace: { data: { type: "places", id: "p1" } } },
      }),
    ).not.toThrow();
  });

  it("rejects a URL object where the wire schema wants a string", () => {
    expect(() =>
      decode(Document.wire(Person))({
        type: "people",
        id: "1",
        attributes: { name: "Ada", bornAt: new Date("2020-01-01T00:00:00.000Z") },
        links: { self: new URL("https://example.test/people/1") },
      }),
    ).toThrow();
  });

  it("wires each member of a union, and passes a non-struct through", () => {
    const Wire = Document.wire(Schema.Union([Person, Place]));
    expect(
      decode(Wire)({
        type: "places",
        id: "p1",
        attributes: { name: "London" },
        links: { self: "/places/p1" },
      }).type,
    ).toBe("places");
    expect(Document.wire(Schema.String)).toBe(Schema.String);
  });
});
