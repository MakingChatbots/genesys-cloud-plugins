/** A reference to another Genesys Cloud entity, as the API embeds them. */
export interface EntityRef {
    id: string;
    name?: string;
}

/** Null when the API gave no reference or one without an id. */
export function toEntityRef(
    ref: { id?: string; name?: string } | undefined,
): EntityRef | null {
    if (!ref?.id) return null;
    return { id: ref.id, ...(ref.name ? { name: ref.name } : {}) };
}
