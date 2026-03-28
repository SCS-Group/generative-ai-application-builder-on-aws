// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
    Alert,
    Box,
    Button,
    FormField,
    Header,
    Input,
    SpaceBetween,
    Textarea
} from '@cloudscape-design/components';
import { CustomAppLayout, Navigation, Notifications } from '../commons/common-components';
import { createTemplate } from '../../services/fetchTemplates';
import { USECASE_TYPES } from '../../utils/constants';

const DEFAULT_DEPLOY_BODY = '{\n  \n}';
const DEFAULT_AUTHOR = 'SCS Group';

export default function TemplateCreateView() {
    const navigate = useNavigate();
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

    const onFollowNavigationHandler = (event) => {
        navigate(event.detail.href);
    };

    const onSubmit = async (e) => {
        e.preventDefault();
        setError(null);
        let deployRequestBody;
        try {
            deployRequestBody = JSON.parse(deployBodyJson || '{}');
        } catch {
            setError('Deploy request body must be valid JSON.');
            return;
        }
        setSubmitting(true);
        try {
            await createTemplate({
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
                deployRequestBody
            });
            navigate('/templates');
        } catch (err) {
            setError(err?.message || String(err));
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <CustomAppLayout
            navigation={<Navigation activeHref="/templates/create" onFollowHandler={onFollowNavigationHandler} />}
            contentType="default"
            content={
                <form onSubmit={onSubmit}>
                    <SpaceBetween size="l">
                        <Header
                            variant="h1"
                            description="Creates a draft template. Before you can publish, GAAB requires pricing summary, SLA (link or text), and recommended onboarding steps so tenants know cost, terms, and next steps after deployment."
                        >
                            Create template
                        </Header>
                        <Alert type="info" header="Before tenants commit (in AIW)">
                            Complete the <strong>Pricing</strong>, <strong>SLA</strong>, and <strong>Onboarding</strong>{' '}
                            sections — publishing will fail until <code>pricing.summary</code>, an SLA link or document,
                            and onboarding steps are all non-empty. <strong>Ratings</strong> are not captured here; they
                            are reserved for a future AIW feature and are never shown in GAAB.
                        </Alert>
                        {error ? (
                            <Alert type="error" header="Could not create template">
                                {error}
                            </Alert>
                        ) : null}
                        <FormField label="Slug" description="URL-safe identifier (e.g. support-copilot). Required.">
                            <Input value={slug} onChange={({ detail }) => setSlug(detail.value)} />
                        </FormField>
                        <FormField label="Display name">
                            <Input value={displayName} onChange={({ detail }) => setDisplayName(detail.value)} />
                        </FormField>
                        <FormField label="Short description">
                            <Input value={shortDescription} onChange={({ detail }) => setShortDescription(detail.value)} />
                        </FormField>
                        <FormField
                            label="Author"
                            description="Shown in the catalog. Defaults to SCS Group for templates created in GAAB."
                        >
                            <Input value={author} onChange={({ detail }) => setAuthor(detail.value)} />
                        </FormField>
                        <Header variant="h2">Pricing (before commit)</Header>
                        <FormField
                            label="Pricing summary"
                            description="Short statement tenants see before accepting cost (e.g. tier, “from $X/mo”, usage model). Required to publish."
                        >
                            <Textarea value={pricingSummary} onChange={({ detail }) => setPricingSummary(detail.value)} rows={3} />
                        </FormField>
                        <FormField label="Pricing detail URL" description="Optional link to calculator, SKU list, or commercial FAQ.">
                            <Input value={pricingDetailUrl} onChange={({ detail }) => setPricingDetailUrl(detail.value)} />
                        </FormField>
                        <Header variant="h2">SLA / terms</Header>
                        <FormField label="SLA or terms URL" description="Provide a URL and/or paste key terms below. Required to publish (at least one).">
                            <Input value={slaLink} onChange={({ detail }) => setSlaLink(detail.value)} />
                        </FormField>
                        <FormField label="SLA or terms (inline)" description="Use when there is no single URL, or to summarize critical terms.">
                            <Textarea value={slaDocument} onChange={({ detail }) => setSlaDocument(detail.value)} rows={5} />
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
                            />
                        </FormField>
                        <Header variant="h2">Technical</Header>
                        <FormField label="Use case type">
                            <Input value={useCaseType} onChange={({ detail }) => setUseCaseType(detail.value)} />
                        </FormField>
                        <FormField
                            label="Agent deploy request body (JSON)"
                            description="Becomes devops.gaab.provisioning.deployRequestBody for POST /deployments/agents when AIW provisions a tenant."
                        >
                            <Textarea value={deployBodyJson} onChange={({ detail }) => setDeployBodyJson(detail.value)} rows={12} />
                        </FormField>
                        <Box>
                            <SpaceBetween direction="horizontal" size="xs">
                                <Button variant="primary" disabled={submitting || !slug.trim()} formAction="submit">
                                    Save draft
                                </Button>
                                <Button variant="link" onClick={() => navigate('/templates')}>
                                    Cancel
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
