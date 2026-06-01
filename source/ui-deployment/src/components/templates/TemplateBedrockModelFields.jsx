// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import React, { useMemo } from 'react';
import { FormField, Select, StatusIndicator } from '@cloudscape-design/components';
import { FieldLabel } from '../commons/field-label';
import { USECASE_TYPES } from '../../utils/constants';
import { useModelNameQuery } from '../../hooks/useQueries';
import { formatModelNamesList } from '../wizard/Model/helpers';
import { MODEL_PROVIDER_NAME_MAP } from '../wizard/steps-config';

/** Passed to model-info API; Bedrock foundation listing does not depend on this partition. */
const MODEL_USE_CASE = USECASE_TYPES.AGENT_BUILDER;

function findSelectedOption(options, value) {
    if (!value) {
        return null;
    }
    for (const entry of options) {
        if (entry.options) {
            const match = entry.options.find((o) => o.value === value);
            if (match) {
                return match;
            }
        } else if (entry.value === value) {
            return entry;
        }
    }
    return { label: value, value };
}

/** Searchable picker for Bedrock on-demand foundation model IDs only. */
export default function TemplateFoundationModelSelect({ model, setModel }) {
    const foundationQuery = useModelNameQuery(MODEL_PROVIDER_NAME_MAP.Bedrock, MODEL_USE_CASE);

    const foundationOptions = useMemo(
        () => formatModelNamesList(foundationQuery.data, MODEL_PROVIDER_NAME_MAP.Bedrock),
        [foundationQuery.data]
    );

    return (
        <FormField
            label={<FieldLabel required>Foundation model</FieldLabel>}
            description="On-demand Model ID only (profile-only models are not listed). Use Inference profile for those."
            errorText={foundationQuery.isError ? 'Could not load models from Bedrock.' : undefined}
        >
            {foundationQuery.isPending ? (
                <StatusIndicator type="loading">Loading models…</StatusIndicator>
            ) : (
                <Select
                    selectedOption={findSelectedOption(foundationOptions, model.modelName)}
                    onChange={({ detail }) =>
                        setModel((m) => ({
                            ...m,
                            modelName: detail.selectedOption?.value ?? ''
                        }))
                    }
                    options={foundationOptions}
                    filteringType="auto"
                    placeholder="Choose a foundation model"
                    empty="No models found"
                    statusType={foundationQuery.isError ? 'error' : 'finished'}
                />
            )}
        </FormField>
    );
}
