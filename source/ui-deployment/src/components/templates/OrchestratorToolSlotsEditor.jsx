// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useMemo, useState } from 'react';
import { Alert, Box, Button, FormField, Input, Select, SpaceBetween, StatusIndicator } from '@cloudscape-design/components';
import { FieldLabel } from '../commons/field-label';
import { loadPublishedSpecialistTemplates } from './loadPublishedSpecialistTemplates';

function emptySlot() {
    return {
        slotId: '',
        label: '',
        type: 'agent',
        required: true,
        catalogAgentTemplateId: '',
        catalogTemplateSlug: ''
    };
}

export default function OrchestratorToolSlotsEditor({
    slots,
    onChange,
    readOnly,
    excludeTemplateId
}) {
    const [published, setPublished] = useState([]);
    const [loading, setLoading] = useState(true);
    const [loadError, setLoadError] = useState(null);

    useEffect(() => {
        let cancelled = false;
        (async () => {
            setLoading(true);
            setLoadError(null);
            try {
                const rows = await loadPublishedSpecialistTemplates(excludeTemplateId);
                if (!cancelled) {
                    setPublished(rows);
                }
            } catch (e) {
                if (!cancelled) {
                    setLoadError(e?.message || String(e));
                    setPublished([]);
                }
            } finally {
                if (!cancelled) {
                    setLoading(false);
                }
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [excludeTemplateId]);

    const options = useMemo(
        () =>
            published.map((t) => ({
                label: `${t.displayName} (${t.slug})`,
                value: t.templateId,
                description: t.shortDescription || undefined
            })),
        [published]
    );

    const usedTemplateIds = useMemo(
        () => new Set((slots ?? []).map((s) => s.catalogAgentTemplateId).filter(Boolean)),
        [slots]
    );

    function updateSlot(index, patch) {
        onChange((prev) => prev.map((row, i) => (i === index ? { ...row, ...patch } : row)));
    }

    function onSelectTemplate(index, templateId) {
        const template = published.find((t) => t.templateId === templateId);
        if (!template) {
            updateSlot(index, emptySlot());
            return;
        }
        updateSlot(index, {
            slotId: template.slug,
            label: template.displayName,
            type: 'agent',
            required: true,
            catalogAgentTemplateId: template.templateId,
            catalogTemplateSlug: template.slug
        });
    }

    function addSlot() {
        onChange((prev) => [...prev, emptySlot()]);
    }

    function removeSlot(index) {
        onChange((prev) => prev.filter((_, i) => i !== index));
    }

    return (
        <SpaceBetween size="m">
            <Box variant="p" color="text-body-secondary">
                Pick published specialist templates from the AIW catalog. Each slot is a catalog template identity in
                GAAB; AIW tenants later map the slot to their own running deployment (GAAB use case id) at provision
                time.
            </Box>
            {loading ? <StatusIndicator type="loading">Loading published templates…</StatusIndicator> : null}
            {loadError ? <Alert type="error">{loadError}</Alert> : null}
            {!loading && !loadError && published.length === 0 ? (
                <Alert type="warning">
                    No published AgentBuilder templates found. Publish at least one specialist template before defining
                    orchestrator tool slots.
                </Alert>
            ) : null}
            {(slots ?? []).map((slot, index) => {
                const selectOptions = options.filter(
                    (o) => o.value === slot.catalogAgentTemplateId || !usedTemplateIds.has(o.value)
                );
                return (
                    <SpaceBetween key={`slot-${index}`} size="s">
                        <FormField
                            label={<FieldLabel required>Published specialist template</FieldLabel>}
                            description="Slot id and label are set from the catalog template slug and display name."
                        >
                            <Select
                                selectedOption={
                                    slot.catalogAgentTemplateId
                                        ? selectOptions.find((o) => o.value === slot.catalogAgentTemplateId) ?? {
                                              label: slot.catalogTemplateSlug || slot.slotId || 'Selected template',
                                              value: slot.catalogAgentTemplateId
                                          }
                                        : null
                                }
                                onChange={({ detail }) => onSelectTemplate(index, detail.selectedOption?.value ?? '')}
                                options={selectOptions}
                                placeholder="Choose a published template…"
                                disabled={readOnly || loading || published.length === 0}
                                filteringType="auto"
                            />
                        </FormField>
                        {slot.slotId ? (
                            <SpaceBetween size="xs" direction="horizontal">
                                <FormField label="Slot id (from slug)">
                                    <Input value={slot.slotId} readOnly />
                                </FormField>
                                <FormField label="Label">
                                    <Input
                                        value={slot.label}
                                        onChange={({ detail }) => updateSlot(index, { label: detail.value })}
                                        disabled={readOnly}
                                    />
                                </FormField>
                            </SpaceBetween>
                        ) : null}
                        {!readOnly && (slots?.length ?? 0) > 1 ? (
                            <Button onClick={() => removeSlot(index)}>Remove slot</Button>
                        ) : null}
                    </SpaceBetween>
                );
            })}
            {!readOnly ? (
                <Button onClick={addSlot} disabled={loading || published.length === 0}>
                    Add tool slot
                </Button>
            ) : null}
        </SpaceBetween>
    );
}

export { emptySlot as emptyOrchestratorToolSlot };
