interface Named {
    name?: string;
}

export function isExactNameMatch(entity: Named, name: string): boolean {
    return (entity.name ?? "").toLowerCase() === name.toLowerCase();
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
