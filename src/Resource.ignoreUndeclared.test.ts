/**
 * `Resource.make(…, { undeclaredMembers: "ignore" })`: write bodies drop the
 * members they don't declare instead of answering 400, which JSON:API
 * permits. The default `"reject"` is `Resource.undeclared.test.ts`.
 */
import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import * as Atomic from "./Atomic.js";
import * as Relationship from "./Relationship.js";
import * as Resource from "./Resource.js";

const Person = Resource.make("people", { attributes: { name: Schema.String } });
const Note = Resource.make("notes", {
  attributes: { body: Schema.String },
  relationships: { author: Relationship.optional(() => Person) },
  undeclaredMembers: "ignore",
});
const Empty = Resource.make("empties", { attributes: {}, undeclaredMembers: "ignore" });

describe("undeclaredMembers: ignore", () => {
  it("drops an undeclared attribute and relationship from a create", () => {
    const decoded = Schema.decodeUnknownSync(Note.createPayload)({
      data: {
        type: "notes",
        attributes: { body: "b", color: "red" },
        relationships: { reviewer: { data: null } },
      },
    });
    expect(decoded.data.attributes).toEqual({ body: "b" });
    expect(decoded.data.relationships).toEqual({});
  });

  it("drops them from an update and the flat inputs", () => {
    const decoded = Schema.decodeUnknownSync(Note.updatePayload)({
      data: { type: "notes", id: "1", attributes: { color: "red" } },
    });
    expect(decoded.data.attributes).toEqual({});
    expect(Schema.decodeUnknownSync(Note.createInput)({ body: "b", color: "red" })).toEqual({
      body: "b",
    });
  });

  it("drops them from a struct that declares no member", () => {
    const decoded = Schema.decodeSync(Empty.createPayload)({
      data: { type: "empties", attributes: { anything: 1 } },
    });
    expect(decoded.data.attributes).toEqual({});
  });

  it("applies to the atomic add operation", () => {
    const decoded = Schema.decodeUnknownSync(Atomic.AddOperation(Note))({
      op: "add",
      data: { type: "notes", attributes: { body: "b", color: "red" } },
    });
    expect(decoded.data.attributes).toEqual({ body: "b" });
  });

  it("is inherited by extend, which can switch back to reject", () => {
    const Child = Resource.extend(Note, "children");
    expect(
      Schema.decodeUnknownSync(Child.createPayload)({
        data: { type: "children", attributes: { body: "b", color: "red" } },
      }).data.attributes,
    ).toEqual({ body: "b" });
    const Strict = Resource.extend(Note, "stricts", { undeclaredMembers: "reject" });
    expect(() =>
      Schema.decodeUnknownSync(Strict.createPayload)({
        data: { type: "stricts", attributes: { body: "b", color: "red" } },
      }),
    ).toThrow(/Expected no excess property/);
  });

  it("leaves the default rejecting", () => {
    expect(() =>
      Schema.decodeUnknownSync(Person.createPayload)({
        data: { type: "people", attributes: { name: "n", color: "red" } },
      }),
    ).toThrow(/Expected no excess property/);
  });
});
