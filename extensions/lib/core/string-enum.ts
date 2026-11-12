/**
 * A string enum schema as `{ type: "string", enum: [...] }` (Google and other
 * providers reject anyOf/const patterns), typed for TypeBox's `Static` so it
 * infers inside `Type.Object`. pi-ai shipped this until 1.5.0, where its main
 * entry's `StringEnum` became a pi-schema `Schema` that infers as `unknown`
 * inside a TypeBox object; pi maps the bare import to a TypeBox copy only at
 * runtime, so typechecks and unit tests saw the other one. Owning it keeps
 * every pi version in the peer range on the same schema.
 */
import { type TUnsafe, Type } from "typebox";

export function StringEnum<T extends readonly string[]>(values: T, options?: { description?: string; default?: T[number] }): TUnsafe<T[number]> {
	return Type.Unsafe<T[number]>({
		type: "string",
		enum: values as unknown as T[number][],
		...(options?.description && { description: options.description }),
		...(options?.default && { default: options.default }),
	});
}
