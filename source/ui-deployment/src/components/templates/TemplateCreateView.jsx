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
    Select,
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

const COMMERCIAL_SCHEMA_VERSION = '1';

const BILLING_MODEL_OPTIONS = [
    { label: 'Contact sales', value: 'contact_sales' },
    { label: 'Subscription', value: 'subscription' },
    { label: 'Usage-based', value: 'usage_based' },
    { label: 'One-time', value: 'one_time' },
    { label: 'Free preview', value: 'free_preview' }
];

/** Mirror `formatPricingSummaryFromCommercial` in lambda/templates-api/catalog-fields.ts for the “Generate summary” button. */
function formatCommercialSummaryPreview(marketingLike) {
    const b = marketingLike.billing;
    if (!b || typeof b !== 'object') {
        return '';
    }
    const currency = String(b.currency ?? 'USD')
        .trim()
        .toUpperCase() || 'USD';
    const commercial = b.commercial;
    if (!commercial || typeof commercial !== 'object') {
        return '';
    }
    const rec = commercial.recurring;
    const usage = commercial.usage;
    if (!rec || !usage || typeof rec !== 'object' || typeof usage !== 'object') {
        return '';
    }
    const interval = String(rec.interval ?? '').trim().toLowerCase();
    const amountCents = Number(rec.amountCents);
    if (!Number.isFinite(amountCents) || amountCents <= 0 || (interval !== 'month' && interval !== 'year')) {
        return '';
    }
    const amountStr = (Math.round(amountCents) / 100).toFixed(2);
    const includedUnits = Number(usage.includedBillableUnits);
    const tpu = Number(usage.tokensPerBillableUnit);
    const overageCents = Number(usage.overageAmountCentsPerBillableUnit);
    if (
        !Number.isFinite(includedUnits) ||
        includedUnits < 0 ||
        !Number.isFinite(tpu) ||
        tpu < 1 ||
        !Number.isFinite(overageCents) ||
        overageCents < 0
    ) {
        return '';
    }
    const totalTokens = includedUnits * tpu;
    const overageStr = (Math.round(overageCents) / 100).toFixed(2);
    const period = interval === 'year' ? 'year' : 'month';
    let line = `${amountStr} ${currency} / ${period} — includes ${totalTokens.toLocaleString()} provider tokens (${includedUnits.toLocaleString()} billable units × ${tpu.toLocaleString()} tokens); overage ${currency} ${overageStr} per billable unit.`;
    const trial = Number(b.trialPeriodDays);
    if (Number.isFinite(trial) && trial > 0) {
        line += ` ${Math.floor(trial)}-day trial.`;
    }
    return line;
}

function buildCommercialFromForm({
    billingModel,
    currency,
    trialPeriodDays,
    subscriptionInterval,
    baseAmountDollars,
    includedBillableUnits,
    tokensPerBillableUnit,
    overageCentsPerBillableUnit
}) {
    if (billingModel !== 'subscription') {
        return null;
    }
    const dollars = Number(baseAmountDollars);
    if (!Number.isFinite(dollars) || dollars <= 0) {
        throw new Error('Subscription requires a positive base price (USD).');
    }
    const amountCents = Math.round(dollars * 100);
    if (amountCents < 1) {
        throw new Error('Base price is too small after converting to cents.');
    }
    const included = parseInt(String(includedBillableUnits).trim(), 10);
    if (!Number.isFinite(included) || included < 0) {
        throw new Error('Included billable units must be a non-negative integer.');
    }
    const tpu = parseInt(String(tokensPerBillableUnit).trim(), 10);
    if (!Number.isFinite(tpu) || tpu < 1) {
        throw new Error('Tokens per billable unit must be a positive integer (e.g. 1000).');
    }
    const overage = parseInt(String(overageCentsPerBillableUnit).trim(), 10);
    if (!Number.isFinite(overage) || overage < 0) {
        throw new Error('Overage must be a non-negative integer (cents per billable unit).');
    }
    const intv = subscriptionInterval === 'year' ? 'year' : 'month';
    let trial = null;
    const tr = String(trialPeriodDays ?? '').trim();
    if (tr) {
        const t = parseInt(tr, 10);
        if (!Number.isFinite(t) || t < 0) {
            throw new Error('Trial days must be a non-negative integer when set.');
        }
        trial = t;
    }
    const cur = String(currency ?? 'USD')
        .trim()
        .toUpperCase();
    if (!/^[A-Z]{3}$/.test(cur)) {
        throw new Error('Currency must be a 3-letter code (e.g. USD).');
    }
    const commercial = {
        schemaVersion: COMMERCIAL_SCHEMA_VERSION,
        recurring: { interval: intv, amountCents },
        usage: {
            includedBillableUnits: included,
            tokensPerBillableUnit: tpu,
            overageAmountCentsPerBillableUnit: overage
        }
    };
    const billing = {
        model: 'subscription',
        currency: cur,
        commercial
    };
    if (trial !== null && trial > 0) {
        billing.trialPeriodDays = trial;
    }
    return billing;
}

function buildUsageBasedBillingFromForm({ currency, usageHowBilled, usageIncludedWithPlan, usageBeyondIncluded }) {
    const cur = String(currency ?? 'USD')
        .trim()
        .toUpperCase();
    if (!/^[A-Z]{3}$/.test(cur)) {
        throw new Error('Currency must be a 3-letter code (e.g. USD).');
    }
    return {
        model: 'usage_based',
        currency: cur,
        usageHowBilled: String(usageHowBilled ?? '').trim(),
        usageIncludedWithPlan: String(usageIncludedWithPlan ?? '').trim(),
        usageBeyondIncluded: String(usageBeyondIncluded ?? '').trim()
    };
}

function buildFreePreviewBillingFromForm({
    currency,
    previewDurationDays,
    previewIncludes,
    previewAfter
}) {
    const cur = String(currency ?? 'USD')
        .trim()
        .toUpperCase();
    if (!/^[A-Z]{3}$/.test(cur)) {
        throw new Error('Currency must be a 3-letter code (e.g. USD).');
    }
    const rawDays = String(previewDurationDays ?? '').trim();
    let previewDurationDaysNum;
    if (rawDays) {
        const d = parseInt(rawDays, 10);
        if (!Number.isFinite(d) || d < 0) {
            throw new Error('Preview length must be a non-negative number of days, or leave empty.');
        }
        previewDurationDaysNum = d;
    }
    const billing = {
        model: 'free_preview',
        currency: cur,
        previewIncludes: String(previewIncludes ?? '').trim(),
        previewAfter: String(previewAfter ?? '').trim()
    };
    if (previewDurationDaysNum !== undefined) {
        billing.previewDurationDays = previewDurationDaysNum;
    }
    return billing;
}

function formatUsageSummaryForPricingField(billingLike) {
    const b = billingLike?.billing ?? billingLike;
    if (!b || typeof b !== 'object' || b.model !== 'usage_based') {
        return '';
    }
    const parts = [];
    const how = String(b.usageHowBilled ?? '').trim();
    const inc = String(b.usageIncludedWithPlan ?? '').trim();
    const beyond = String(b.usageBeyondIncluded ?? '').trim();
    if (how) {
        parts.push(`How you are billed: ${how}`);
    }
    if (inc) {
        parts.push(`Included: ${inc}`);
    }
    if (beyond) {
        parts.push(`Beyond that: ${beyond}`);
    }
    return parts.join('. ').trim();
}

function formatPreviewSummaryForPricingField(billingLike) {
    const b = billingLike?.billing ?? billingLike;
    if (!b || typeof b !== 'object' || b.model !== 'free_preview') {
        return '';
    }
    const parts = [];
    const days = b.previewDurationDays;
    if (typeof days === 'number' && Number.isFinite(days) && days > 0) {
        parts.push(`Free preview for ${days} day${days === 1 ? '' : 's'}.`);
    } else {
        parts.push('Free preview.');
    }
    const inc = String(b.previewIncludes ?? '').trim();
    if (inc) {
        parts.push(`What's included: ${inc}`);
    }
    const after = String(b.previewAfter ?? '').trim();
    if (after) {
        parts.push(`After the preview: ${after}`);
    }
    return parts.join(' ').trim();
}

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
    const billing = m.billing ?? {};
    const commercial = billing.commercial ?? {};
    const rec = commercial.recurring ?? {};
    const usage = commercial.usage ?? {};
    const amountCents = Number(rec.amountCents);
    const baseAmountDollars =
        Number.isFinite(amountCents) && amountCents > 0 ? String(amountCents / 100) : '';
    return {
        slug: String(apiTemplate?.slug ?? ''),
        displayName: String(m.displayName ?? ''),
        shortDescription: String(m.shortDescription ?? ''),
        author: String(m.author ?? DEFAULT_AUTHOR),
        billingModel: String(billing.model ?? 'contact_sales'),
        currency: String(billing.currency ?? 'USD'),
        trialPeriodDays:
            billing.trialPeriodDays !== undefined && billing.trialPeriodDays !== null
                ? String(billing.trialPeriodDays)
                : '',
        subscriptionInterval: rec.interval === 'year' ? 'year' : 'month',
        baseAmountDollars,
        includedBillableUnits:
            usage.includedBillableUnits !== undefined ? String(usage.includedBillableUnits) : '',
        tokensPerBillableUnit:
            usage.tokensPerBillableUnit !== undefined ? String(usage.tokensPerBillableUnit) : '1000',
        overageCentsPerBillableUnit:
            usage.overageAmountCentsPerBillableUnit !== undefined
                ? String(usage.overageAmountCentsPerBillableUnit)
                : '',
        usageHowBilled: String(billing.usageHowBilled ?? ''),
        usageIncludedWithPlan: String(billing.usageIncludedWithPlan ?? ''),
        usageBeyondIncluded: String(billing.usageBeyondIncluded ?? ''),
        previewDurationDays:
            billing.previewDurationDays !== undefined && billing.previewDurationDays !== null
                ? String(billing.previewDurationDays)
                : '',
        previewIncludes: String(billing.previewIncludes ?? ''),
        previewAfter: String(billing.previewAfter ?? ''),
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
    const [billingModel, setBillingModel] = useState('contact_sales');
    const [currency, setCurrency] = useState('USD');
    const [trialPeriodDays, setTrialPeriodDays] = useState('');
    const [subscriptionInterval, setSubscriptionInterval] = useState('month');
    const [baseAmountDollars, setBaseAmountDollars] = useState('');
    const [includedBillableUnits, setIncludedBillableUnits] = useState('');
    const [tokensPerBillableUnit, setTokensPerBillableUnit] = useState('1000');
    const [overageCentsPerBillableUnit, setOverageCentsPerBillableUnit] = useState('');
    const [usageHowBilled, setUsageHowBilled] = useState('');
    const [usageIncludedWithPlan, setUsageIncludedWithPlan] = useState('');
    const [usageBeyondIncluded, setUsageBeyondIncluded] = useState('');
    const [previewDurationDays, setPreviewDurationDays] = useState('');
    const [previewIncludes, setPreviewIncludes] = useState('');
    const [previewAfter, setPreviewAfter] = useState('');
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
                        'Published templates cannot be edited here. Create a new draft in GAAB if you need a new catalog entry, or decommission this one from the templates list to remove it from the public catalog.'
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
                setBillingModel(fields.billingModel);
                setCurrency(fields.currency);
                setTrialPeriodDays(fields.trialPeriodDays);
                setSubscriptionInterval(fields.subscriptionInterval);
                setBaseAmountDollars(fields.baseAmountDollars);
                setIncludedBillableUnits(fields.includedBillableUnits);
                setTokensPerBillableUnit(fields.tokensPerBillableUnit);
                setOverageCentsPerBillableUnit(fields.overageCentsPerBillableUnit);
                setUsageHowBilled(fields.usageHowBilled);
                setUsageIncludedWithPlan(fields.usageIncludedWithPlan);
                setUsageBeyondIncluded(fields.usageBeyondIncluded);
                setPreviewDurationDays(fields.previewDurationDays);
                setPreviewIncludes(fields.previewIncludes);
                setPreviewAfter(fields.previewAfter);
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

    const buildSavePayload = (deployRequestBody) => {
        let billing;
        if (billingModel === 'subscription') {
            billing = buildCommercialFromForm({
                billingModel,
                currency,
                trialPeriodDays,
                subscriptionInterval,
                baseAmountDollars,
                includedBillableUnits,
                tokensPerBillableUnit,
                overageCentsPerBillableUnit
            });
        } else if (billingModel === 'usage_based') {
            billing = buildUsageBasedBillingFromForm({
                currency,
                usageHowBilled,
                usageIncludedWithPlan,
                usageBeyondIncluded
            });
        } else if (billingModel === 'free_preview') {
            billing = buildFreePreviewBillingFromForm({
                currency,
                previewDurationDays,
                previewIncludes,
                previewAfter
            });
        } else {
            billing = {
                model: billingModel,
                currency: currency.trim().toUpperCase() || 'USD'
            };
        }
        return {
            slug: slug.trim(),
            displayName: displayName.trim() || undefined,
            shortDescription: shortDescription.trim() || undefined,
            author: author.trim() || DEFAULT_AUTHOR,
            billing,
            pricingSummary: pricingSummary.trim(),
            pricingDetailUrl: pricingDetailUrl.trim() || undefined,
            slaLink: slaLink.trim(),
            slaDocument: slaDocument.trim(),
            recommendedOnboardingSteps: recommendedOnboardingSteps.trim(),
            useCaseType,
            devops: buildDevopsPayload(useCaseType, deployRequestBody)
        };
    };

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
                                { text: 'Templates', href: '/templates' },
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
                        <Alert type="info" header="Before tenants commit">
                            Complete <strong>Pricing</strong>, <strong>SLA</strong>, and <strong>Onboarding</strong>. For{' '}
                            <strong>Subscription</strong>, fill in the plan details below; GAAB checks them when you publish.
                            For <strong>Usage-based</strong> or <strong>Free preview</strong>, describe terms in the fields for
                            that model, then use the button to draft the pricing summary if you like.{' '}
                            <strong>Ratings</strong> are not edited in this form.
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
                        <Header variant="h2">Billing model</Header>
                        <FormField
                            label="Commercial model"
                            description="Pick how this template is sold. Subscription includes detailed plan fields. Usage-based and free preview have their own fields; everyone still needs a clear pricing summary before publish."
                        >
                            <Select
                                selectedOption={
                                    BILLING_MODEL_OPTIONS.find((o) => o.value === billingModel) ?? BILLING_MODEL_OPTIONS[0]
                                }
                                onChange={({ detail }) => {
                                    setBillingModel(detail.selectedOption?.value ?? 'contact_sales');
                                }}
                                options={BILLING_MODEL_OPTIONS}
                                disabled={readOnlyLocked}
                            />
                        </FormField>
                        {billingModel === 'subscription' ? (
                            <SpaceBetween size="m">
                                <FormField label="Currency (ISO 4217)">
                                    <Input
                                        value={currency}
                                        onChange={({ detail }) => setCurrency(detail.value)}
                                        disabled={readOnlyLocked}
                                    />
                                </FormField>
                                <FormField label="Billing interval">
                                    <Select
                                        selectedOption={
                                            subscriptionInterval === 'year'
                                                ? { label: 'Yearly', value: 'year' }
                                                : { label: 'Monthly', value: 'month' }
                                        }
                                        onChange={({ detail }) =>
                                            setSubscriptionInterval(detail.selectedOption?.value === 'year' ? 'year' : 'month')
                                        }
                                        options={[
                                            { label: 'Monthly', value: 'month' },
                                            { label: 'Yearly', value: 'year' }
                                        ]}
                                        disabled={readOnlyLocked}
                                    />
                                </FormField>
                                <FormField
                                    label="Base subscription price"
                                    description="Per billing interval, before usage — decimal major units (e.g. 99.00 for US $99)."
                                >
                                    <Input
                                        value={baseAmountDollars}
                                        onChange={({ detail }) => setBaseAmountDollars(detail.value)}
                                        disabled={readOnlyLocked}
                                    />
                                </FormField>
                                <FormField
                                    label="Included billable units / period"
                                    description="Number of bundled usage units included each billing period (each unit represents a fixed number of model tokens)."
                                >
                                    <Input
                                        value={includedBillableUnits}
                                        onChange={({ detail }) => setIncludedBillableUnits(detail.value)}
                                        disabled={readOnlyLocked}
                                    />
                                </FormField>
                                <FormField
                                    label="Model tokens per billable unit"
                                    description="How many model tokens one billable unit represents (often 1000)."
                                >
                                    <Input
                                        value={tokensPerBillableUnit}
                                        onChange={({ detail }) => setTokensPerBillableUnit(detail.value)}
                                        disabled={readOnlyLocked}
                                    />
                                </FormField>
                                <FormField
                                    label="Overage (cents per billable unit)"
                                    description="Price in cents for each extra billable unit beyond the included allowance."
                                >
                                    <Input
                                        value={overageCentsPerBillableUnit}
                                        onChange={({ detail }) => setOverageCentsPerBillableUnit(detail.value)}
                                        disabled={readOnlyLocked}
                                    />
                                </FormField>
                                <FormField label="Trial period (days)" description="Optional; leave empty for no trial.">
                                    <Input
                                        value={trialPeriodDays}
                                        onChange={({ detail }) => setTrialPeriodDays(detail.value)}
                                        disabled={readOnlyLocked}
                                    />
                                </FormField>
                                <Button
                                    disabled={readOnlyLocked}
                                    onClick={() => {
                                        try {
                                            const b = buildCommercialFromForm({
                                                billingModel,
                                                currency,
                                                trialPeriodDays,
                                                subscriptionInterval,
                                                baseAmountDollars,
                                                includedBillableUnits,
                                                tokensPerBillableUnit,
                                                overageCentsPerBillableUnit
                                            });
                                            const line = formatCommercialSummaryPreview({ billing: b });
                                            if (line) {
                                                setPricingSummary(line);
                                            }
                                        } catch (e) {
                                            setError(e?.message || String(e));
                                        }
                                    }}
                                >
                                    Draft pricing summary from subscription fields
                                </Button>
                            </SpaceBetween>
                        ) : null}
                        {billingModel === 'usage_based' ? (
                            <SpaceBetween size="m">
                                <FormField
                                    label="Currency (ISO 4217)"
                                    description="For display consistency with other billing fields (e.g. USD)."
                                >
                                    <Input
                                        value={currency}
                                        onChange={({ detail }) => setCurrency(detail.value)}
                                        disabled={readOnlyLocked}
                                    />
                                </FormField>
                                <FormField
                                    label="How usage is billed"
                                    description="Explain what drives cost (per request, per token, tiers, etc.). Tenants see this in the structured billing data."
                                >
                                    <Textarea
                                        value={usageHowBilled}
                                        onChange={({ detail }) => setUsageHowBilled(detail.value)}
                                        rows={3}
                                        disabled={readOnlyLocked}
                                    />
                                </FormField>
                                <FormField
                                    label="What is included"
                                    description="Allowances, minimums, or what a typical month looks like."
                                >
                                    <Textarea
                                        value={usageIncludedWithPlan}
                                        onChange={({ detail }) => setUsageIncludedWithPlan(detail.value)}
                                        rows={3}
                                        disabled={readOnlyLocked}
                                    />
                                </FormField>
                                <FormField
                                    label="Beyond included usage (optional)"
                                    description="How variable or overage charges work, if applicable."
                                >
                                    <Textarea
                                        value={usageBeyondIncluded}
                                        onChange={({ detail }) => setUsageBeyondIncluded(detail.value)}
                                        rows={2}
                                        disabled={readOnlyLocked}
                                    />
                                </FormField>
                                <Button
                                    disabled={readOnlyLocked}
                                    onClick={() => {
                                        try {
                                            const b = buildUsageBasedBillingFromForm({
                                                currency,
                                                usageHowBilled,
                                                usageIncludedWithPlan,
                                                usageBeyondIncluded
                                            });
                                            const line = formatUsageSummaryForPricingField({ billing: b });
                                            if (line) {
                                                setPricingSummary(line);
                                            }
                                        } catch (e) {
                                            setError(e?.message || String(e));
                                        }
                                    }}
                                >
                                    Draft pricing summary from usage fields
                                </Button>
                            </SpaceBetween>
                        ) : null}
                        {billingModel === 'free_preview' ? (
                            <SpaceBetween size="m">
                                <FormField label="Currency (ISO 4217)" description="For consistency (e.g. USD).">
                                    <Input
                                        value={currency}
                                        onChange={({ detail }) => setCurrency(detail.value)}
                                        disabled={readOnlyLocked}
                                    />
                                </FormField>
                                <FormField
                                    label="Preview length (days)"
                                    description="Optional. How long the free preview lasts; leave empty if you describe timing only in text."
                                >
                                    <Input
                                        value={previewDurationDays}
                                        onChange={({ detail }) => setPreviewDurationDays(detail.value)}
                                        disabled={readOnlyLocked}
                                    />
                                </FormField>
                                <FormField
                                    label="What the preview includes"
                                    description="Features, limits, or support level during the preview."
                                >
                                    <Textarea
                                        value={previewIncludes}
                                        onChange={({ detail }) => setPreviewIncludes(detail.value)}
                                        rows={3}
                                        disabled={readOnlyLocked}
                                    />
                                </FormField>
                                <FormField
                                    label="After the preview"
                                    description="What happens next (upgrade path, contact sales, automatic stop, etc.)."
                                >
                                    <Textarea
                                        value={previewAfter}
                                        onChange={({ detail }) => setPreviewAfter(detail.value)}
                                        rows={3}
                                        disabled={readOnlyLocked}
                                    />
                                </FormField>
                                <Button
                                    disabled={readOnlyLocked}
                                    onClick={() => {
                                        try {
                                            const b = buildFreePreviewBillingFromForm({
                                                currency,
                                                previewDurationDays,
                                                previewIncludes,
                                                previewAfter
                                            });
                                            const line = formatPreviewSummaryForPricingField({ billing: b });
                                            if (line) {
                                                setPricingSummary(line);
                                            }
                                        } catch (e) {
                                            setError(e?.message || String(e));
                                        }
                                    }}
                                >
                                    Draft pricing summary from preview fields
                                </Button>
                            </SpaceBetween>
                        ) : null}
                        <Header variant="h2">Pricing (before commit)</Header>
                        <FormField
                            label="Pricing summary"
                            description="Short statement tenants see before they agree to cost. Required to publish. For subscription, you can draft it from the subscription fields, or publish may fill it when those fields are complete and this is empty."
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
                                    headerDescription="Deployment payload sent when a tenant activates this template (same shape as the deployment API)."
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
                                description="Deployment payload sent when a tenant activates this template (same shape as the deployment API)."
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
