import assert from "node:assert/strict";
import { test } from "node:test";
import { findArchitectSdkRegion } from "./find-architect-sdk-region.ts";

const cases: [domain: string, sdkRegion: string | undefined][] = [
    ["mypurecloud.com", "prod_us_east_1"],
    ["use2.us-gov-pure.cloud", "prod_us_east_2"],
    ["usw2.pure.cloud", "prod_us_west_2"],
    ["cac1.pure.cloud", "prod_ca_central_1"],
    ["mxc1.pure.cloud", "prod_mx_central_1"],
    ["sae1.pure.cloud", "prod_sa_east_1"],
    ["mypurecloud.ie", "prod_eu_west_1"],
    ["euw2.pure.cloud", "prod_eu_west_2"],
    ["mypurecloud.de", "prod_eu_central_1"],
    ["euc2.pure.cloud", "prod_eu_central_2"],
    ["edee1.eusc-pure.cloud", "prod_eusc_de_east_1"],
    ["mec1.pure.cloud", "prod_me_central_1"],
    ["aps1.pure.cloud", "prod_ap_south_1"],
    ["apse1.pure.cloud", "prod_ap_southeast_1"],
    ["mypurecloud.com.au", "prod_ap_southeast_2"],
    ["mypurecloud.jp", "prod_ap_northeast_1"],
    ["apne2.pure.cloud", "prod_ap_northeast_2"],
    ["apne3.pure.cloud", "prod_ap_northeast_3"],
    // Unknown domain
    ["not-a-region.example", undefined],
];

for (const [domain, sdkRegion] of cases) {
    test(`${domain} maps to ${sdkRegion}`, () => {
        assert.equal(findArchitectSdkRegion(domain), sdkRegion);
    });
}
