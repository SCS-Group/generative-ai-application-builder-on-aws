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
import { FieldLabel } from '../commons/field-label';
import { createTemplate, getTemplate, updateTemplate } from '../../services/fetchTemplates';
import { USECASE_TYPES } from '../../utils/constants';
import AgentDeployBodyWizard from './AgentDeployBodyWizard';
import OrchestratorDeployBodyWizard from './OrchestratorDeployBodyWizard';
import OrchestratorToolSlotsEditor, { emptyOrchestratorToolSlot } from './OrchestratorToolSlotsEditor';
import { connectionsForEngineeringSpecialistSlug } from './engineeringSpecialistConnections';
import { DIGITAL_WORKER_ROLE_OPTIONS, digitalWorkerRoleFromDevops } from './digitalWorkerRoleOptions';

const TEMPLATE_KIND_AGENT = 'agent';
const TEMPLATE_KIND_ORCHESTRATOR = 'orchestrator';
const ORCHESTRATOR_GAAB_VARIANT = 'WorkflowOrchestrator';

function templateKindFromApiTemplate(apiTemplate) {
    const variant = apiTemplate?.devops?.gaab?.variant;
    if (variant === ORCHESTRATOR_GAAB_VARIANT) {
        return TEMPLATE_KIND_ORCHESTRATOR;
    }
    return TEMPLATE_KIND_AGENT;
}

function requiredToolSlotsFromDevops(apiTemplate) {
    const slots = apiTemplate?.devops?.gaab?.orchestrator?.requiredToolSlots;
    if (!Array.isArray(slots)) {
        return [];
    }
    return slots.map((s) => ({
        slotId: String(s?.slotId ?? ''),
        label: String(s?.label ?? ''),
        type: String(s?.type ?? 'agent'),
        required: s?.required !== false,
        catalogAgentTemplateId: String(s?.catalogAgentTemplateId ?? ''),
        catalogTemplateSlug: String(s?.catalogTemplateSlug ?? '')
    }));
}

function isOrchestratorTemplateKind(templateKind) {
    return templateKind === TEMPLATE_KIND_ORCHESTRATOR;
}

const DEFAULT_DEPLOY_BODY = '{\n  \n}';
const DEFAULT_AUTHOR = 'SCS Group';

const COMMERCIAL_SCHEMA_VERSION = '1';

const BILLING_MODEL_OPTIONS = [
    { label: 'Contact sales', value: 'contact_sales' },
    { label: 'Internal (SCS ops only)', value: 'internal' },
    { label: 'Subscription', value: 'subscription' },
    { label: 'Session subscription', value: 'subscription_sessions' },
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

function buildSessionSubscriptionBillingFromForm({ currency, sessionModelId, sessionTiers }) {
    const cur = String(currency ?? 'USD')
        .trim()
        .toUpperCase();
    if (!/^[A-Z]{3}$/.test(cur)) {
        throw new Error('Currency must be a 3-letter code (e.g. USD).');
    }
    const modelId = String(sessionModelId ?? '').trim();
    if (!modelId) {
        throw new Error('Session subscription requires a modelId on the template (select a model in the deploy body).');
    }
    if (!Array.isArray(sessionTiers) || sessionTiers.length === 0) {
        throw new Error('Session subscription requires at least one tier.');
    }
    const tiers = sessionTiers.map((t, idx) => {
        const tierId = String(t?.tierId ?? '').trim();
        const name = String(t?.name ?? '').trim();
        const amountDollars = Number(t?.amountDollars);
        const includedSessions = parseInt(String(t?.includedSessions ?? '').trim(), 10);
        if (!tierId) throw new Error(`Tier ${idx + 1} is missing tierId.`);
        if (!name) throw new Error(`Tier ${idx + 1} is missing name.`);
        if (!Number.isFinite(amountDollars) || amountDollars <= 0) {
            throw new Error(`Tier ${idx + 1} price must be a positive number.`);
        }
        const amountCents = Math.round(amountDollars * 100);
        if (amountCents < 1) throw new Error(`Tier ${idx + 1} price is too small after converting to cents.`);
        if (!Number.isFinite(includedSessions) || includedSessions < 1) {
            throw new Error(`Tier ${idx + 1} included sessions must be a positive integer.`);
        }
        return {
            tierId,
            name,
            recurring: { interval: 'month', amountCents },
            includedSessions
        };
    });
    return {
        model: 'subscription_sessions',
        currency: cur,
        sessionCommercial: {
            schemaVersion: '1',
            modelId,
            tiers
        }
    };
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

function buildDevopsPayload({ templateKind, useCaseType, deployRequestBody, requiredToolSlots, digitalWorkerRole, slug }) {
    const orchestrator = isOrchestratorTemplateKind(templateKind);
    const variant = orchestrator ? ORCHESTRATOR_GAAB_VARIANT : useCaseType;
    const deployPath = orchestrator ? '/deployments/workflows' : '/deployments/agents';
    const gaab = {
        variant,
        provisioning: {
            deployMethod: 'POST',
            deployPath,
            deployRequestBody
        }
    };
    if (orchestrator) {
        gaab.orchestrator = {
            schemaVersion: '1',
            requiredToolSlots: (requiredToolSlots || [])
                .map((s) => {
                    const row = {
                        slotId: String(s.slotId ?? '').trim(),
                        label: String(s.label ?? '').trim(),
                        type: String(s.type ?? 'agent').trim() || 'agent',
                        required: s.required !== false
                    };
                    const catalogId = String(s.catalogAgentTemplateId ?? '').trim();
                    const catalogSlug = String(s.catalogTemplateSlug ?? '').trim();
                    if (catalogId) {
                        row.catalogAgentTemplateId = catalogId;
                    }
                    if (catalogSlug) {
                        row.catalogTemplateSlug = catalogSlug;
                    }
                    return row;
                })
                .filter((s) => s.slotId && s.label)
        };
    } else {
        const role = String(digitalWorkerRole ?? '').trim();
        if (role) {
            gaab.specialist = {
                schemaVersion: '1',
                digitalWorkerRole: role
            };
        }
        const specialistConnections = connectionsForEngineeringSpecialistSlug(slug);
        if (specialistConnections) {
            gaab.connections = specialistConnections;
        }
    }
    return { gaab };
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
    const sessionCommercial = billing.sessionCommercial ?? {};
    const sessionTiers = Array.isArray(sessionCommercial.tiers)
        ? sessionCommercial.tiers.map((t) => {
              const recurring = t?.recurring ?? {};
              const cents = Number(recurring.amountCents);
              return {
                  tierId: String(t?.tierId ?? ''),
                  name: String(t?.name ?? ''),
                  amountDollars: Number.isFinite(cents) && cents > 0 ? String(cents / 100) : '',
                  includedSessions: t?.includedSessions !== undefined ? String(t?.includedSessions) : ''
              };
          })
        : [];
    return {
        slug: String(apiTemplate?.slug ?? ''),
        displayName: String(m.displayName ?? ''),
        shortDescription: String(m.shortDescription ?? ''),
        author: String(m.author ?? DEFAULT_AUTHOR),
        billingModel: String(billing.model ?? 'contact_sales'),
        currency: String(billing.currency ?? 'USD'),
        sessionTiers,
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
        deployBodyJson: deployBodyJsonFromTemplate(apiTemplate),
        templateKind: templateKindFromApiTemplate(apiTemplate),
        requiredToolSlots: requiredToolSlotsFromDevops(apiTemplate),
        digitalWorkerRole: digitalWorkerRoleFromDevops(apiTemplate)
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
    const [sessionTiers, setSessionTiers] = useState([]);
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
    const [templateKind, setTemplateKind] = useState(TEMPLATE_KIND_AGENT);
    const [requiredToolSlots, setRequiredToolSlots] = useState([]);
    const [digitalWorkerRole, setDigitalWorkerRole] = useState('');
    const [useCaseType, setUseCaseType] = useState(USECASE_TYPES.AGENT_BUILDER);
    const [deployBodyJson, setDeployBodyJson] = useState(DEFAULT_DEPLOY_BODY);
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState(null);
    const [loadError, setLoadError] = useState(null);
    const [readOnlyReason, setReadOnlyReason] = useState(null);
    const [loadingTemplate, setLoadingTemplate] = useState(isEditMode);
    const [templateStatus, setTemplateStatus] = useState(null);
    const [wizardMountKey, setWizardMountKey] = useState(0);

    const defaultProvisionedUseCaseNameHint = useMemo(
        () => displayName.trim() || slug.trim() || '',
        [displayName, slug]
    );

    const isOrchestrator = isOrchestratorTemplateKind(templateKind);

    useEffect(() => {
        if (!isOrchestrator) {
            return;
        }
        setBillingModel('subscription_sessions');
        setUseCaseType(USECASE_TYPES.WORKFLOW);
    }, [isOrchestrator]);

    const onTemplateKindChange = (kind) => {
        setTemplateKind(kind);
        setWizardMountKey((k) => k + 1);
        if (kind === TEMPLATE_KIND_ORCHESTRATOR) {
            setBillingModel('subscription_sessions');
            setUseCaseType(USECASE_TYPES.WORKFLOW);
            setDigitalWorkerRole('');
            if (!requiredToolSlots.length) {
                setRequiredToolSlots([emptyOrchestratorToolSlot()]);
            }
        } else {
            setUseCaseType(USECASE_TYPES.AGENT_BUILDER);
        }
    };

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
                } else if (st === 'in_testing') {
                    setReadOnlyReason(
                        'This template is in testing. You can update the draft, but changing deploy configuration marks testing as stale — use Restart testing on the templates list. Publish only after Mark validated.'
                    );
                }
                const fields = mapTemplateToFormFields(t);
                setSlug(fields.slug);
                setDisplayName(fields.displayName);
                setShortDescription(fields.shortDescription);
                setAuthor(fields.author);
                setBillingModel(fields.billingModel);
                setCurrency(fields.currency);
                setSessionTiers(fields.sessionTiers);
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
                setTemplateKind(fields.templateKind);
                setRequiredToolSlots(fields.requiredToolSlots);
                setDigitalWorkerRole(fields.digitalWorkerRole || '');
                setUseCaseType(fields.useCaseType);
                setDeployBodyJson(fields.deployBodyJson);
                if (st === 'draft' || st === 'in_testing') {
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
        } else if (billingModel === 'subscription_sessions') {
            const sessionModelId = deployRequestBody?.LlmParams?.BedrockLlmParams?.ModelId;
            billing = buildSessionSubscriptionBillingFromForm({
                currency,
                sessionModelId,
                sessionTiers
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
            useCaseType: isOrchestratorTemplateKind(templateKind) ? USECASE_TYPES.WORKFLOW : useCaseType,
            devops: buildDevopsPayload({
                templateKind,
                useCaseType: isOrchestratorTemplateKind(templateKind) ? USECASE_TYPES.WORKFLOW : useCaseType,
                deployRequestBody,
                requiredToolSlots,
                digitalWorkerRole,
                slug: slug.trim()
            })
        };
    };

    const onSubmit = async (e) => {
        e.preventDefault();
        setError(null);
        let deployRequestBody;
        try {
            deployRequestBody = JSON.parse(deployBodyJson || '{}');
        } catch (err) {
            setError(err?.message || 'Deploy request body must be valid JSON.');
            return;
        }
        const modelId = deployRequestBody?.LlmParams?.BedrockLlmParams?.ModelId;
        const needsBedrockModel =
            (isOrchestratorTemplateKind(templateKind) ||
                isAgentBuilderUseCaseType(useCaseType)) &&
            deployRequestBody?.LlmParams?.BedrockLlmParams?.BedrockInferenceType === 'OTHER_FOUNDATION';
        if (needsBedrockModel && !modelId?.trim()) {
            setError('Bedrock foundation model ID is required before saving.');
            return;
        }
        if (isOrchestratorTemplateKind(templateKind)) {
            const slots = (requiredToolSlots || []).filter(
                (s) => String(s.slotId ?? '').trim() && String(s.label ?? '').trim()
            );
            if (slots.length === 0) {
                setError('Add at least one required tool slot for orchestrator templates.');
                return;
            }
            const missingCatalog = slots.filter((s) => !String(s.catalogAgentTemplateId ?? '').trim());
            if (missingCatalog.length) {
                setError('Each tool slot must select a published specialist template from the catalog.');
                return;
            }
            const catalogIds = slots.map((s) => s.catalogAgentTemplateId);
            if (new Set(catalogIds).size !== catalogIds.length) {
                setError('Each published specialist template can only be used once as a tool slot.');
                return;
            }
        }
        if (
            !isOrchestratorTemplateKind(templateKind) &&
            isAgentBuilderUseCaseType(useCaseType) &&
            needsBedrockModel &&
            !String(digitalWorkerRole ?? '').trim()
        ) {
            setError('Select a digital worker role for this specialist (required for AIW policy starters).');
            return;
        }
        if (isEditMode && templateStatus !== 'draft' && templateStatus !== 'in_testing') {
            setError('This template cannot be updated.');
            return;
        }
        setSubmitting(true);
        try {
            const payload = buildSavePayload(deployRequestBody);
            if (isEditMode) {
                await updateTemplate(templateId, payload);
                navigate('/templates', {
                    replace: true,
                    state: { templateSavedMessage: 'Draft saved.' }
                });
            } else {
                await createTemplate(payload);
                navigate('/templates', {
                    replace: true,
                    state: { templateSavedMessage: 'Draft created.' }
                });
            }
        } catch (err) {
            setError(err?.message || String(err));
        } finally {
            setSubmitting(false);
        }
    };

    const readOnlyLocked =
        isEditMode && templateStatus !== 'draft' && templateStatus !== 'in_testing';
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
                                isOrchestrator
                                    ? isEditMode
                                        ? readOnlyLocked
                                            ? 'This record is read-only.'
                                            : 'Orchestrator workflow template. Save the draft, then use Publish to catalog on the templates list (no GAAB test stack — tenants map specialists in AIW).'
                                        : 'Creates an orchestrator draft. Publish from the templates list when marketing, tool slots, and workflow JSON are complete.'
                                    : isEditMode
                                      ? readOnlyLocked
                                          ? 'This record is read-only.'
                                          : templateStatus === 'in_testing'
                                            ? 'Save changes while in testing. Use the templates list to open the test app, mark validated, and publish (test stack is removed on publish).'
                                            : 'Update the draft and save as often as needed. Start testing from the templates list when the Agent configuration is complete.'
                                      : 'Creates a draft template. Start testing deploys a temporary stack; publish (after validation) sends the template to the AIW catalog.'
                            }
                        >
                            {isEditMode ? (readOnlyLocked ? 'View template' : 'Edit template') : 'Create template'}
                        </Header>
                        <Alert type="info" header="Before tenants commit">
                            Fields marked with <span style={{ color: '#d91515' }}>*</span> are required to{' '}
                            <strong>publish</strong> to the catalog. Complete <strong>Pricing</strong>, <strong>SLA</strong>, and{' '}
                            <strong>Onboarding</strong>. For <strong>Subscription</strong>, fill in the plan details below. For{' '}
                            <strong>Usage-based</strong> or <strong>Free preview</strong>, use the draft buttons to build the pricing
                            summary. <strong>Ratings</strong> are not edited in this form.
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
                        {error ? (
                            <Alert type="error" header={isEditMode ? 'Could not save template' : 'Could not create template'}>
                                {error}
                            </Alert>
                        ) : null}
                        <FormField
                            label={<FieldLabel required>Slug</FieldLabel>}
                            description="URL-safe identifier (e.g. support-copilot)."
                        >
                            <Input
                                value={slug}
                                onChange={({ detail }) => setSlug(detail.value)}
                                disabled={readOnlyLocked}
                            />
                        </FormField>
                        <FormField label={<FieldLabel required>Display name</FieldLabel>}>
                            <Input
                                value={displayName}
                                onChange={({ detail }) => setDisplayName(detail.value)}
                                disabled={readOnlyLocked}
                            />
                        </FormField>
                        <FormField label={<FieldLabel required>Short description</FieldLabel>}>
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
                        <FormField
                            label={<FieldLabel required>Template type</FieldLabel>}
                            description="Orchestrator templates publish workflow definitions with session-tier pricing; tenants map specialist agents to tool slots in AIW."
                        >
                            <Select
                                selectedOption={{
                                    label:
                                        templateKind === TEMPLATE_KIND_ORCHESTRATOR
                                            ? 'Orchestrator template (workflow)'
                                            : 'Agent template (AgentBuilder)',
                                    value: templateKind
                                }}
                                onChange={({ detail }) => onTemplateKindChange(detail.selectedOption.value)}
                                options={[
                                    { label: 'Agent template (AgentBuilder)', value: TEMPLATE_KIND_AGENT },
                                    {
                                        label: 'Orchestrator template (workflow)',
                                        value: TEMPLATE_KIND_ORCHESTRATOR
                                    }
                                ]}
                                disabled={readOnlyLocked || isEditMode}
                            />
                        </FormField>
                        <Header variant="h2">Billing model</Header>
                        <FormField
                            label={<FieldLabel required>Commercial model</FieldLabel>}
                            description={
                                billingModel === 'internal'
                                    ? 'Internal templates publish to AIW but are visible only to allowlisted SCS operators (not the public catalog).'
                                    : 'How this template is sold. Subscription shows plan fields below.'
                            }
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
                        {billingModel === 'internal' ? (
                            <Alert type="info">
                                Published as <strong>internal</strong>. AIW catalog shows this only to the SCS
                                allowlist (currently robinson@mydicoin.com). Everyone else will not see it.
                            </Alert>
                        ) : null}
                        {billingModel === 'subscription' ? (
                            <SpaceBetween size="m">
                                <FormField label={<FieldLabel required>Currency (ISO 4217)</FieldLabel>}>
                                    <Input
                                        value={currency}
                                        onChange={({ detail }) => setCurrency(detail.value)}
                                        disabled={readOnlyLocked}
                                    />
                                </FormField>
                                <FormField label={<FieldLabel required>Billing interval</FieldLabel>}>
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
                                    label={<FieldLabel required>Base subscription price</FieldLabel>}
                                    description="Per billing interval, before usage — decimal major units (e.g. 99.00 for US $99)."
                                >
                                    <Input
                                        value={baseAmountDollars}
                                        onChange={({ detail }) => setBaseAmountDollars(detail.value)}
                                        disabled={readOnlyLocked}
                                    />
                                </FormField>
                                <FormField
                                    label={<FieldLabel required>Included billable units / period</FieldLabel>}
                                    description="Bundled usage units each billing period."
                                >
                                    <Input
                                        value={includedBillableUnits}
                                        onChange={({ detail }) => setIncludedBillableUnits(detail.value)}
                                        disabled={readOnlyLocked}
                                    />
                                </FormField>
                                <FormField
                                    label={<FieldLabel required>Model tokens per billable unit</FieldLabel>}
                                    description="Model tokens per billable unit (often 1000)."
                                >
                                    <Input
                                        value={tokensPerBillableUnit}
                                        onChange={({ detail }) => setTokensPerBillableUnit(detail.value)}
                                        disabled={readOnlyLocked}
                                    />
                                </FormField>
                                <FormField
                                    label={<FieldLabel required>Overage (cents per billable unit)</FieldLabel>}
                                    description="Cents per billable unit beyond the included allowance."
                                >
                                    <Input
                                        value={overageCentsPerBillableUnit}
                                        onChange={({ detail }) => setOverageCentsPerBillableUnit(detail.value)}
                                        disabled={readOnlyLocked}
                                    />
                                </FormField>
                                <FormField label="Trial period (days)" description="Leave empty for no trial.">
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
                        {billingModel === 'subscription_sessions' ? (
                            <SpaceBetween size="m">
                                <FormField label={<FieldLabel required>Currency (ISO 4217)</FieldLabel>}>
                                    <Input
                                        value={currency}
                                        onChange={({ detail }) => setCurrency(detail.value)}
                                        disabled={readOnlyLocked}
                                    />
                                </FormField>
                                <FormField
                                    label={<FieldLabel required>Model ID (from deploy body)</FieldLabel>}
                                    description="Model is part of the published template version. Change model by creating a new template/version."
                                >
                                    <Input
                                        value={
                                            (() => {
                                                try {
                                                    const body = JSON.parse(deployBodyJson || '{}');
                                                    return String(body?.LlmParams?.BedrockLlmParams?.ModelId ?? '');
                                                } catch {
                                                    return '';
                                                }
                                            })()
                                        }
                                        disabled={true}
                                    />
                                </FormField>
                                <Header variant="h3">Session tiers (monthly)</Header>
                                <Box variant="p" color="text-body-secondary">
                                    Add one or more tiers. Tenants will see these tiers in the AIW catalog listing for this
                                    template version (model-bound).
                                </Box>
                                <SpaceBetween size="s">
                                    {(sessionTiers.length ? sessionTiers : [{ tierId: '', name: '', amountDollars: '', includedSessions: '' }]).map(
                                        (t, idx) => {
                                            const tier = sessionTiers[idx] ?? t;
                                            const rows = sessionTiers.length ? sessionTiers : [tier];
                                            return (
                                                <Box key={idx} padding="m" borderRadius="medium" borderVariant="bordered">
                                                    <SpaceBetween size="s">
                                                        <FormField label={<FieldLabel required>Tier ID</FieldLabel>}>
                                                            <Input
                                                                value={tier.tierId}
                                                                onChange={({ detail }) => {
                                                                    const next = [...rows];
                                                                    next[idx] = { ...next[idx], tierId: detail.value };
                                                                    setSessionTiers(next);
                                                                }}
                                                                disabled={readOnlyLocked}
                                                            />
                                                        </FormField>
                                                        <FormField label={<FieldLabel required>Name</FieldLabel>}>
                                                            <Input
                                                                value={tier.name}
                                                                onChange={({ detail }) => {
                                                                    const next = [...rows];
                                                                    next[idx] = { ...next[idx], name: detail.value };
                                                                    setSessionTiers(next);
                                                                }}
                                                                disabled={readOnlyLocked}
                                                            />
                                                        </FormField>
                                                        <FormField
                                                            label={<FieldLabel required>Monthly price (major units)</FieldLabel>}
                                                            description="Example: 20.00 for $20/month."
                                                        >
                                                            <Input
                                                                value={tier.amountDollars}
                                                                onChange={({ detail }) => {
                                                                    const next = [...rows];
                                                                    next[idx] = { ...next[idx], amountDollars: detail.value };
                                                                    setSessionTiers(next);
                                                                }}
                                                                disabled={readOnlyLocked}
                                                            />
                                                        </FormField>
                                                        <FormField label={<FieldLabel required>Included sessions / month</FieldLabel>}>
                                                            <Input
                                                                value={tier.includedSessions}
                                                                onChange={({ detail }) => {
                                                                    const next = [...rows];
                                                                    next[idx] = { ...next[idx], includedSessions: detail.value };
                                                                    setSessionTiers(next);
                                                                }}
                                                                disabled={readOnlyLocked}
                                                            />
                                                        </FormField>
                                                        {!readOnlyLocked ? (
                                                            <SpaceBetween direction="horizontal" size="xs">
                                                                <Button
                                                                    onClick={() => {
                                                                        const next = [...rows];
                                                                        next.splice(idx, 1);
                                                                        setSessionTiers(next);
                                                                    }}
                                                                >
                                                                    Remove tier
                                                                </Button>
                                                                {idx === rows.length - 1 ? (
                                                                    <Button
                                                                        variant="primary"
                                                                        onClick={() => {
                                                                            const next = [...rows];
                                                                            next.push({
                                                                                tierId: '',
                                                                                name: '',
                                                                                amountDollars: '',
                                                                                includedSessions: ''
                                                                            });
                                                                            setSessionTiers(next);
                                                                        }}
                                                                    >
                                                                        Add tier
                                                                    </Button>
                                                                ) : null}
                                                            </SpaceBetween>
                                                        ) : null}
                                                    </SpaceBetween>
                                                </Box>
                                            );
                                        }
                                    )}
                                </SpaceBetween>
                                <Button
                                    disabled={readOnlyLocked}
                                    onClick={() => {
                                        try {
                                            const body = JSON.parse(deployBodyJson || '{}');
                                            const sessionModelId = body?.LlmParams?.BedrockLlmParams?.ModelId;
                                            const b = buildSessionSubscriptionBillingFromForm({
                                                currency,
                                                sessionModelId,
                                                sessionTiers
                                            });
                                            const tiers = b?.sessionCommercial?.tiers ?? [];
                                            if (tiers.length > 0) {
                                                const cur = b.currency ?? 'USD';
                                                const cents = tiers
                                                    .map((t) => t?.recurring?.amountCents)
                                                    .filter((x) => typeof x === 'number' && Number.isFinite(x) && x > 0)
                                                    .sort((a, b) => a - b)[0];
                                                const amount = cents ? (Math.round(cents) / 100).toFixed(2) : '';
                                                if (amount) {
                                                    setPricingSummary(
                                                        `From ${amount} ${String(cur).toUpperCase()} / month — includes sessions (tiered).`
                                                    );
                                                }
                                            }
                                        } catch (e) {
                                            setError(e?.message || String(e));
                                        }
                                    }}
                                >
                                    Draft pricing summary from session tiers
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
                                    label="Beyond included usage"
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
                                    description="How long the free preview lasts; leave empty if timing is only in text below."
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
                            label={<FieldLabel required>Pricing summary</FieldLabel>}
                            description="Short statement tenants see before they agree to cost. For subscription, use the draft button above when plan fields are complete."
                        >

                            <Textarea
                                value={pricingSummary}
                                onChange={({ detail }) => setPricingSummary(detail.value)}
                                rows={3}
                                disabled={readOnlyLocked}
                            />
                        </FormField>
                        <FormField label="Pricing detail URL" description="Link to calculator, SKU list, or commercial FAQ.">
                            <Input
                                value={pricingDetailUrl}
                                onChange={({ detail }) => setPricingDetailUrl(detail.value)}
                                disabled={readOnlyLocked}
                            />
                        </FormField>
                        <Header variant="h2">SLA / terms</Header>
                        <FormField
                            label={<FieldLabel required>SLA or terms URL</FieldLabel>}
                            description="Provide this URL and/or inline terms below (at least one required to publish)."
                        >
                            <Input value={slaLink} onChange={({ detail }) => setSlaLink(detail.value)} disabled={readOnlyLocked} />
                        </FormField>
                        <FormField
                            label={<FieldLabel required>SLA or terms (inline)</FieldLabel>}
                            description="Use when there is no single URL, or to summarize critical terms."
                        >
                            <Textarea
                                value={slaDocument}
                                onChange={({ detail }) => setSlaDocument(detail.value)}
                                rows={5}
                                disabled={readOnlyLocked}
                            />
                        </FormField>
                        <Header variant="h2">After deployment</Header>
                        <FormField
                            label={<FieldLabel required>Recommended onboarding steps</FieldLabel>}
                            description="Checklist for the tenant after the use case is live (markdown or plain text)."
                        >
                            <Textarea
                                value={recommendedOnboardingSteps}
                                onChange={({ detail }) => setRecommendedOnboardingSteps(detail.value)}
                                rows={8}
                                disabled={readOnlyLocked}
                            />
                        </FormField>
                        {isOrchestrator ? (
                            <>
                                <Header variant="h2">Orchestrator requirements</Header>
                                <OrchestratorToolSlotsEditor
                                    slots={requiredToolSlots}
                                    onChange={setRequiredToolSlots}
                                    readOnly={readOnlyLocked}
                                    excludeTemplateId={templateId}
                                />
                            </>
                        ) : null}
                        {!isOrchestrator ? (
                            <>
                                <Header variant="h2">Policy & guardrails (AIW)</Header>
                                <FormField
                                    label={<FieldLabel>Digital worker role</FieldLabel>}
                                    description="Required to publish Bedrock specialist templates. Determines which policy starting points tenants see on each specialist workspace Policy tab (Cedar on the specialist MCP gateway)."
                                >
                                    <Select
                                        selectedOption={
                                            DIGITAL_WORKER_ROLE_OPTIONS.find((o) => o.value === digitalWorkerRole) ??
                                            null
                                        }
                                        onChange={({ detail }) =>
                                            setDigitalWorkerRole(detail.selectedOption?.value ?? '')
                                        }
                                        options={DIGITAL_WORKER_ROLE_OPTIONS}
                                        placeholder="Choose role…"
                                        disabled={readOnlyLocked}
                                    />
                                </FormField>
                            </>
                        ) : null}
                        <Header variant="h2">Technical</Header>
                        {!isOrchestrator ? (
                            <FormField
                                label={<FieldLabel required>Use case type</FieldLabel>}
                                description="Must match the deployment API. The guided builder below applies when this is AgentBuilder."
                            >
                                <Input
                                    value={useCaseType}
                                    onChange={({ detail }) => setUseCaseType(detail.value)}
                                    disabled={readOnlyLocked}
                                />
                            </FormField>
                        ) : null}
                        {isOrchestrator ? (
                            <SpaceBetween size="l">
                                <Box variant="p" color="text-body-secondary">
                                    Workflow orchestrator definition (POST /deployments/workflows). Specialist agents are
                                    attached at tenant deploy time via tool slots above.
                                </Box>
                                {!readOnlyLocked ? (
                                    <OrchestratorDeployBodyWizard
                                        key={wizardMountKey}
                                        defaultUseCaseName={defaultProvisionedUseCaseNameHint}
                                        initialDeployBodyJson={deployBodyJson}
                                        onDeployBodyGenerated={setDeployBodyJson}
                                    />
                                ) : null}
                                <ExpandableSection
                                    variant="container"
                                    headerText="Edit raw JSON"
                                    headerDescription="Workflow deploy request body for this template version."
                                >
                                    <Textarea
                                        value={deployBodyJson}
                                        onChange={({ detail }) => setDeployBodyJson(detail.value)}
                                        rows={12}
                                        disabled={readOnlyLocked}
                                    />
                                </ExpandableSection>
                            </SpaceBetween>
                        ) : isAgentBuilderUseCaseType(useCaseType) ? (
                            <SpaceBetween size="l">
                                <Box variant="p" color="text-body-secondary">
                                    Use the wizard to fill the same fields as an AgentBuilder deployment. Model and agent
                                    settings are kept in sync with the raw JSON below; <strong>Save draft</strong> always
                                    persists the current wizard values (you do not need to click Generate JSON first).
                                </Box>
                                {!readOnlyLocked ? (
                                    <AgentDeployBodyWizard
                                        key={wizardMountKey}
                                        defaultUseCaseName={defaultProvisionedUseCaseNameHint}
                                        initialDeployBodyJson={deployBodyJson}
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
