interface Named {
    name?: string;
}

/**
 * The form two names (or other case-insensitive identifiers, e.g. language
 * tags) are compared in. Use as a Map key.
 */
export function nameKey(name: string | undefined): string {
    return (name ?? "").toLowerCase();
}

export function isExactNameMatch(entity: Named, name: string): boolean {
    return nameKey(entity.name) === nameKey(name);
}

export function moveExactMatchToTop<T extends Named>(
    entities: T[],
    name: string,
): T[] {
    return entities
        .slice()
        .sort(
            (a, b) =>
                Number(isExactNameMatch(b, name)) -
                Number(isExactNameMatch(a, name)),
        );
}
