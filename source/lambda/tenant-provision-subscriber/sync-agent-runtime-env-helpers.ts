// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

export function agentRuntimeNameFromUseCaseId(useCaseId: string): string {
    const short = useCaseId.trim().split('-')[0];
    return `gaab_agent_${short}`;
}
