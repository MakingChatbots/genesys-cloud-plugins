import type { OrganizationApi } from "purecloud-platform-client-v2";
import {
    authHint,
    formatApiError,
    toApiError,
} from "../utilities/api-error.ts";
import type { ToolFactory } from "../utilities/types.ts";

interface OrgDetailsResult {
    id: string;
    name: string | null;
    /** The org's short name, typed on the Genesys Cloud login page. */
    shortName: string | null;
    domain: string | null;
    state: string | null;
}

export interface ToolConfig {
    organizationApi: OrganizationApi;
}

const inputSchema = {};

export const orgDetails: ToolFactory<ToolConfig, typeof inputSchema> = ({
    organizationApi,
}: ToolConfig) => ({
    config: {
        description:
            "Returns the Genesys Cloud organisation (org) this MCP server is " +
            "connected to: its id, name, shortName (the short name typed on " +
            "the login page), domain and state (e.g. active). The org is " +
            "fixed by the OAuth client the server was configured with, so every other tool reads from and " +
            "deploys to this org. Use it to answer 'Am I on org X?' or " +
            "'Which org am I connected to?', and to confirm the org before " +
            "deploying a flow when the user has named the org they expect. " +
            "To decide whether the user's org X is this one, compare X " +
            "case-insensitively against name, shortName and id; the user " +
            "may also mean an environment (e.g. 'prod', 'dev'), which " +
            "only matches if the name or shortName says so. If nothing " +
            "matches, say so and report the connected org's name and " +
            "shortName rather than guessing. A null " +
            "name or shortName means the API did not return it, not that " +
            "it is blank; say the value is unknown rather than treating it " +
            "as a mismatch.",
        annotations: {
            title: "Org Details",
            readOnlyHint: true,
            destructiveHint: false,
        },
        inputSchema,
    },
    handler: async () => {
        try {
            const org = await organizationApi.getOrganizationsMe();
            if (!org.id) {
                return {
                    isError: true,
                    content: [
                        {
                            type: "text",
                            text:
                                "The organisation API returned no org id, so " +
                                "the connected org could not be identified. " +
                                "Retry; if it persists, check the server's " +
                                "GENESYS_REGION and OAuth client.",
                        },
                    ],
                };
            }
            const result: OrgDetailsResult = {
                id: org.id,
                name: org.name || null,
                shortName: org.thirdPartyOrgName || null,
                domain: org.domain || null,
                state: org.state ?? null,
            };
            return {
                content: [{ type: "text", text: JSON.stringify(result) }],
            };
        } catch (err) {
            const { status } = toApiError(err);
            // GET /organizations/me needs no particular permission, so
            // authHint's 403 text (which names one) doesn't fit. The server
            // logs in with client credentials, whose access comes from the
            // roles assigned to the OAuth client.
            const hint =
                status === 403
                    ? " Check the roles assigned to the server's OAuth " +
                      "client in Genesys Cloud (Admin > Integrations > " +
                      "OAuth)."
                    : authHint(status, "");
            return {
                isError: true,
                content: [
                    {
                        type: "text",
                        text: `Failed to read the connected organisation: ${formatApiError(err)}${hint}`,
                    },
                ],
            };
        }
    },
});
