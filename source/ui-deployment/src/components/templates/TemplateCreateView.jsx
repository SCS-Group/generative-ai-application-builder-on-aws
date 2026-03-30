// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
    Alert,
    Box,
    BreadcrumbGroup,
    Button,
    ExpandableSection,
    FormField,
    Header,
    Input,
    SpaceBetween,
    StatusIndicator,
    Textarea
} from '@cloudscape-design/components';
import { CustomAppLayout, Navigation, Notifications } from '../commons/common-components';
import { createTemplate, getTemplate, updateTemplate } from '../../services/fetchTemplates';
import { USECASE_TYPES } from '../../utils/constants';
import AgentDeployBodyWizard from './AgentDeployBodyWizard';

const DEFAULT_DEPLOY_BODY = '{\n  \n}';
const DEFAULT_AUTHOR = 'SCS Group';

/** Normalize pasted text so "AgentBuilder" still matches after trim / invisible chars. */
function isAgentBuilderUseCaseType(value) {
    const v = String(value ?? '')
        .replace(/[\u200B-\u200D\uFEFF]/g, '')
        .trim();
    return v === USECASE_TYPES.AGENT_BUILDER || v.toLowerCase() === 'agentbuilder';
}

function buildDevopsPayload(useCaseType, deployRequestBody) {
    return {
        gaab: {
            variant: useCaseType,
            provisioning: {
                deployMethod: 'POST',
                deployPath: '/deployments/agents',
                deployRequestBody
            }
        }
    };
}

function deployBodyJsonFromTemplate(apiTemplate) {
    const body = apiTemplate?.devops?.gaab?.provisioning?.deployRequestBody;
    if (body != null && typeof body === 'object') {
        try {
            return JSON.stringify(body, null, 2);
        } catch {
            return DEFAULT_DEPLOY_BODY;
        }
    }
    return DEFAULT_DEPLOY_BODY;
}

function mapTemplateToFormFields(apiTemplate) {
    const m = apiTemplate?.marketing ?? {};
    const pricing = m.pricing ?? {};
    const sla = m.sla ?? {};
    return {
        slug: String(apiTemplate?.slug ?? ''),
        displayName: String(m.displayName ?? ''),
        shortDescription: String(m.shortDescription ?? ''),
        author: String(m.author ?? DEFAULT_AUTHOR),
        pricingSummary: String(pricing.summary ?? ''),
        pricingDetailUrl: String(pricing.detailUrl ?? ''),
        slaLink: String(sla.link ?? ''),
        slaDocument: String(sla.document ?? ''),
        recommendedOnboardingSteps: String(m.recommendedOnboardingSteps ?? ''),
        useCaseType: String(apiTemplate?.useCaseType ?? USECASE_TYPES.AGENT_BUILDER),
        deployBodyJson: deployBodyJsonFromTemplate(apiTemplate)
    };
}

export default function TemplateCreateView() {
    const navigate = useNavigate();
    const { templateId } = useParams();
    const isEditMode = Boolean(templateId);

    const [slug, setSlug] = useState('');
    const [displayName, setDisplayName] = useState('');
    const [shortDescription, setShortDescription] = useState('');
    const [author, setAuthor] = useState(DEFAULT_AUTHOR);
    const [pricingSummary, setPricingSummary] = useState('');
    const [pricingDetailUrl, setPricingDetailUrl] = useState('');
    const [slaLink, setSlaLink] = useState('');
    const [slaDocument, setSlaDocument] = useState('');
    const [recommendedOnboardingSteps, setRecommendedOnboardingSteps] = useState('');
    const [useCaseType, setUseCaseType] = useState(USECASE_TYPES.AGENT_BUILDER);
    const [deployBodyJson, setDeployBodyJson] = useState(DEFAULT_DEPLOY_BODY);
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState(null);
    const [loadError, setLoadError] = useState(null);
    const [readOnlyReason, setReadOnlyReason] = useState(null);
    const [loadingTemplate, setLoadingTemplate] = useState(isEditMode);
    const [templateStatus, setTemplateStatus] = useState(null);
    const [saveSuccess, setSaveSuccess] = useState(false);
    const [wizardMountKey, setWizardMountKey] = useState(0);

    const defaultProvisionedUseCaseNameHint = useMemo(
        () => displayName.trim() || slug.trim() || '',
        [displayName, slug]
    );

    useEffect(() => {
        if (!templateId) {
            return;
        }
        let cancelled = false;
        (async () => {
            setLoadingTemplate(true);
            setLoadError(null);
            setReadOnlyReason(null);
            try {
                const t = await getTemplate(templateId);
                if (cancelled) return;
                const st = t.status;
                setTemplateStatus(st);
                if (st === 'published') {
                    setReadOnlyReason(
                        'Published templates cannot be edited here. Create a new draft in GAAB if you need a new catalog entry, or decommission this one from the templates list to remove it from AIW.'
                    );
                } else if (st === 'archived') {
                    setReadOnlyReason(
                        'This template has been decommissioned. It cannot be edited or republished from this record. Create a new draft to publish again (you may reuse the slug if no other published template uses it).'
                    );
                }
                const fields = mapTemplateToFormFields(t);
                setSlug(fields.slug);
                setDisplayName(fields.displayName);
                setShortDescription(fields.shortDescription);
                setAuthor(fields.author);
                setPricingSummary(fields.pricingSummary);
                setPricingDetailUrl(fields.pricingDetailUrl);
                setSlaLink(fields.slaLink);
                setSlaDocument(fields.slaDocument);
                setRecommendedOnboardingSteps(fields.recommendedOnboardingSteps);
                setUseCaseType(fields.useCaseType);
                setDeployBodyJson(fields.deployBodyJson);
                if (st === 'draft') {
                    setWizardMountKey((k) => k + 1);
                }
            } catch (e) {
                if (!cancelled) {
                    setLoadError(e?.message || String(e));
                }
            } finally {
                if (!cancelled) {
                    setLoadingTemplate(false);
                }
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [templateId]);

    const onFollowNavigationHandler = (event) => {
        navigate(event.detail.href);
    };

    const onBreadcrumbFollow = (event) => {
        const href = event.detail.href;
        if (!href || href === '#') {
            event.preventDefault();
            return;
        }
        event.preventDefault();
        navigate(href);
    };

    const buildSavePayload = (deployRequestBody) => ({
        slug: slug.trim(),
        displayName: displayName.trim() || undefined,
        shortDescription: shortDescription.trim() || undefined,
        author: author.trim() || DEFAULT_AUTHOR,
        pricingSummary: pricingSummary.trim(),
        pricingDetailUrl: pricingDetailUrl.trim() || undefined,
        slaLink: slaLink.trim(),
        slaDocument: slaDocument.trim(),
        recommendedOnboardingSteps: recommendedOnboardingSteps.trim(),
        useCaseType,
        devops: buildDevopsPayload(useCaseType, deployRequestBody)
    });

    const onSubmit = async (e) => {
        e.preventDefault();
        setError(null);
        setSaveSuccess(false);
        let deployRequestBody;
        try {
            deployRequestBody = JSON.parse(deployBodyJson || '{}');
        } catch {
            setError('Deploy request body must be valid JSON.');
            return;
        }
        if (isEditMode && templateStatus !== 'draft') {
            setError('This template cannot be updated.');
            return;
        }
        setSubmitting(true);
        try {
            const payload = buildSavePayload(deployRequestBody);
            if (isEditMode) {
                await updateTemplate(templateId, payload);
                setSaveSuccess(true);
            } else {
                const created = await createTemplate(payload);
                const id = created?.templateId;
                if (id) {
                    navigate(`/templates/${id}/edit`, { replace: true });
                } else {
                    navigate('/templates');
                }
            }
        } catch (err) {
            setError(err?.message || String(err));
        } finally {
            setSubmitting(false);
        }
    };

    const readOnlyLocked = isEditMode && templateStatus !== 'draft';
    const navActiveHref = isEditMode ? '/templates' : '/templates/create';

    if (loadingTemplate) {
        return (
            <CustomAppLayout
                navigation={<Navigation activeHref={navActiveHref} onFollowHandler={onFollowNavigationHandler} />}
                contentType="default"
                content={
                    <Box padding="l">
                        <StatusIndicator type="loading">Loading template…</StatusIndicator>
                    </Box>
                }
                notifications={<Notifications successNotification={true} />}
            />
        );
    }

    return (
        <CustomAppLayout
            navigation={<Navigation activeHref={navActiveHref} onFollowHandler={onFollowNavigationHandler} />}
            contentType="default"
            content={
                <form onSubmit={onSubmit}>
                    <SpaceBetween size="l">
                        <BreadcrumbGroup
                            onFollow={onBreadcrumbFollow}
                            items={[
                                { text: 'AIW templates', href: '/templates' },
                                {
                                    text: isEditMode ? `Edit: ${slug || 'template'}` : 'Create template',
                                    href: '#'
                                }
                            ]}
                        />
                        <Header
                            variant="h1"
                            description={
                                isEditMode
                                    ? readOnlyLocked
                                        ? 'This record is read-only.'
                                        : 'Update the draft and save as often as needed. Publish from the templates list when pricing, SLA, and onboarding are complete.'
                                    : 'Creates a draft template. Before you can publish, GAAB requires pricing summary, SLA (link or text), and recommended onboarding steps so tenants know cost, terms, and next steps after deployment.'
                            }
                        >
                            {isEditMode ? (readOnlyLocked ? 'View template' : 'Edit template') : 'Create template'}
                        </Header>
                        <Alert type="info" header="Before tenants commit (in AIW)">
                            Complete the <strong>Pricing</strong>, <strong>SLA</strong>, and <strong>Onboarding</strong>{' '}
                            sections — publishing will fail until <code>pricing.summary</code>, an SLA link or document,
                            and onboarding steps are all non-empty. <strong>Ratings</strong> are not captured here; they
                            are reserved for a future AIW feature and are never shown in GAAB.
                        </Alert>
                        {loadError ? (
                            <Alert type="error" header="Could not load template">
                                {loadError}
                            </Alert>
                        ) : null}
                        {readOnlyReason ? (
                            <Alert type="info" header="Read-only">
                                {readOnlyReason}
                            </Alert>
                        ) : null}
                        {saveSuccess ? (
                            <Alert
                                type="success"
                                dismissible
                                onDismiss={() => setSaveSuccess(false)}
                                header="Draft saved"
                            >
                                Your changes were saved. You can keep editing or return to the list to publish when ready.
                            </Alert>
                        ) : null}
                        {error ? (
                            <Alert type="error" header={isEditMode ? 'Could not save template' : 'Could not create template'}>
                                {error}
                            </Alert>
                        ) : null}
                        <FormField label="Slug" description="URL-safe identifier (e.g. support-copilot). Required.">
                            <Input
                                value={slug}
                                onChange={({ detail }) => setSlug(detail.value)}
                                disabled={readOnlyLocked}
                            />
                        </FormField>
                        <FormField label="Display name">
                            <Input
                                value={displayName}
                                onChange={({ detail }) => setDisplayName(detail.value)}
                                disabled={readOnlyLocked}
                            />
                        </FormField>
                        <FormField label="Short description">
                            <Input
                                value={shortDescription}
                                onChange={({ detail }) => setShortDescription(detail.value)}
                                disabled={readOnlyLocked}
                            />
                        </FormField>
                        <FormField
                            label="Author"
                            description="Shown in the catalog. Defaults to SCS Group for templates created in GAAB."
                        >
                            <Input value={author} onChange={({ detail }) => setAuthor(detail.value)} disabled={readOnlyLocked} />
                        </FormField>
                        <Header variant="h2">Pricing (before commit)</Header>
                        <FormField
                            label="Pricing summary"
                            description="Short statement tenants see before accepting cost (e.g. tier, “from $X/mo”, usage model). Required to publish."
                        >
                            <Textarea
                                value={pricingSummary}
                                onChange={({ detail }) => setPricingSummary(detail.value)}
                                rows={3}
                                disabled={readOnlyLocked}
                            />
                        </FormField>
                        <FormField label="Pricing detail URL" description="Optional link to calculator, SKU list, or commercial FAQ.">
                            <Input
                                value={pricingDetailUrl}
                                onChange={({ detail }) => setPricingDetailUrl(detail.value)}
                                disabled={readOnlyLocked}
                            />
                        </FormField>
                        <Header variant="h2">SLA / terms</Header>
                        <FormField label="SLA or terms URL" description="Provide a URL and/or paste key terms below. Required to publish (at least one).">
                            <Input value={slaLink} onChange={({ detail }) => setSlaLink(detail.value)} disabled={readOnlyLocked} />
                        </FormField>
                        <FormField label="SLA or terms (inline)" description="Use when there is no single URL, or to summarize critical terms.">
                            <Textarea
                                value={slaDocument}
                                onChange={({ detail }) => setSlaDocument(detail.value)}
                                rows={5}
                                disabled={readOnlyLocked}
                            />
                        </FormField>
                        <Header variant="h2">After deployment</Header>
                        <FormField
                            label="Recommended onboarding steps"
                            description="Markdown or plain text checklist for the tenant after the use case is live. Required to publish."
                        >
                            <Textarea
                                value={recommendedOnboardingSteps}
                                onChange={({ detail }) => setRecommendedOnboardingSteps(detail.value)}
                                rows={8}
                                disabled={readOnlyLocked}
                            />
                        </FormField>
                        <Header variant="h2">Technical</Header>
                        <FormField
                            label="Use case type"
                            description="Must match the deployment API. The guided builder below applies when this is AgentBuilder."
                        >
                            <Input
                                value={useCaseType}
                                onChange={({ detail }) => setUseCaseType(detail.value)}
                                disabled={readOnlyLocked}
                            />
                        </FormField>
                        {isAgentBuilderUseCaseType(useCaseType) ? (
                            <SpaceBetween size="l">
                                <Box variant="p" color="text-body-secondary">
                                    Use the wizard to fill the same fields as an AgentBuilder deployment; on <strong>Generate JSON</strong> the
                                    payload is written into the raw JSON field (you can still edit it).
                                </Box>
                                {!readOnlyLocked ? (
                                    <AgentDeployBodyWizard
                                        key={wizardMountKey}
                                        defaultUseCaseName={defaultProvisionedUseCaseNameHint}
                                        onDeployBodyGenerated={setDeployBodyJson}
                                    />
                                ) : null}
                                <ExpandableSection
                                    variant="container"
                                    headerText="Edit raw JSON"
                                    headerDescription="Becomes devops.gaab.provisioning.deployRequestBody for POST /deployments/agents when AIW provisions a tenant."
                                >
                                    <Textarea
                                        value={deployBodyJson}
                                        onChange={({ detail }) => setDeployBodyJson(detail.value)}
                                        rows={12}
                                        disabled={readOnlyLocked}
                                    />
                                </ExpandableSection>
                            </SpaceBetween>
                        ) : (
                            <FormField
                                label="Agent deploy request body (JSON)"
                                description="Becomes devops.gaab.provisioning.deployRequestBody for POST /deployments/agents when AIW provisions a tenant."
                            >
                                <Textarea
                                    value={deployBodyJson}
                                    onChange={({ detail }) => setDeployBodyJson(detail.value)}
                                    rows={12}
                                    disabled={readOnlyLocked}
                                />
                            </FormField>
                        )}
                        <Box>
                            <SpaceBetween direction="horizontal" size="xs">
                                <Button
                                    variant="primary"
                                    disabled={submitting || !slug.trim() || readOnlyLocked}
                                    formAction="submit"
                                >
                                    Save draft
                                </Button>
                                <Button variant="link" onClick={() => navigate('/templates')}>
                                    {isEditMode ? 'Back to templates' : 'Cancel'}
                                </Button>
                            </SpaceBetween>
                        </Box>
                    </SpaceBetween>
                </form>
            }
            notifications={<Notifications successNotification={true} />}
        />
    );
}
