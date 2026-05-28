// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/** Matches use-case-management `UseCase.shortUUID` + CreateStackCommandInputBuilder stack name. */
export function expectedAgentStackName(useCaseName: string, useCaseId: string): string {
    const name = useCaseName.trim();
    const shortUUID = useCaseId.trim().substring(0, 8);
    return `${name}-${shortUUID}`;
}
