/**
 * The wire format between the deploy runner (a child process) and the MCP
 * server: the single `{type:"result"}` JSON line the runner writes to stdout.
 */

/** How far the flow got. `published` and `checked_in` are both unlocked;
 *  `saved` means the flow exists but is still checked out. */
export type DeployStatus = "published" | "checked_in" | "saved" | "failed";

export interface DeployValidation {
    errors: string[];
    warnings: string[];
}

export interface DeployResultPayload {
    success: boolean;
    status: DeployStatus;
    flowId?: string;
    flowName?: string;
    flowType?: string;
    flowUrl?: string;
    /** Id of a same-name flow the SDK deleted before creating this one. */
    replacedFlowId?: string;
    validation: DeployValidation;
    sdkVersion?: string;
    error?: string;
}
