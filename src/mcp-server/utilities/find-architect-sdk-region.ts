import platformClient from "purecloud-platform-client-v2";

/**
 * Finds the Architect SDK region (e.g. "prod_us_west_2") by the
 * Platform SDK region (e.g. "usw2.pure.cloud") that is passed in, or
 * undefined when the Platform SDK does not know the domain.
 */
export function findArchitectSdkRegion(domain: string): string | undefined {
    const awsRegion = Object.entries(platformClient.PureCloudRegionHosts).find(
        ([, host]) => host === domain,
    )?.[0];
    return awsRegion === undefined ? undefined : `prod_${awsRegion}`;
}

/** Every API domain the Platform SDK knows, for error messages. */
export function knownApiDomains(): string[] {
    return Object.values(platformClient.PureCloudRegionHosts);
}
