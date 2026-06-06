// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/** CreatePolicy accepts a plain string description. */
export function createPolicyDescription(description?: string): string | undefined {
    const value = description?.trim();
    return value || undefined;
}

/**
 * UpdatePolicy wire shape. Plain string causes SerializationException at runtime.
 * The shared aws-sdk-lib layer still types description as string, so callers cast the full input.
 */
export function updatePolicyDescriptionWire(description?: string): { optionalValue: string } | undefined {
    const value = description?.trim();
    if (!value) return undefined;
    return { optionalValue: value };
}
