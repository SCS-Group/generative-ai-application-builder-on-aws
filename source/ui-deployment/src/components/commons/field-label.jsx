// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import React from 'react';

/**
 * Form field label with optional red asterisk for required fields (publish / catalog validation).
 */
export function FieldLabel({ children, required = false }) {
    return (
        <span>
            {children}
            {required ? (
                <span style={{ color: '#d91515' }} aria-hidden="true">
                    {' *'}
                </span>
            ) : null}
        </span>
    );
}
