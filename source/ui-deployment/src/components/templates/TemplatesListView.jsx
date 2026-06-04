// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
    Alert,
    Box,
    Button,
    ButtonDropdown,
    Header,
    Link,
    Modal,
    Select,
    SpaceBetween,
    StatusIndicator,
    Table
} from '@cloudscape-design/components';
import { CustomAppLayout, Navigation, Notifications } from '../commons/common-components';
import { isOrchestratorCatalogTemplate } from './templateOrchestratorUtils';
import {
    cancelTemplateTesting,
    listTemplates,
    markTemplateTestingValidated,
    publishTemplate,
    refreshTemplateTestingStatus,
    restartTemplateTesting,
    startTemplateTesting,
    unpublishTemplate
} from '../../services/fetchTemplates';

const STATUS_FILTER_OPTIONS = [
    { label: 'Published', value: 'published' },
    { label: 'Draft', value: 'draft' },
    { label: 'Archived', value: 'archived' }
];

function emptyListMessage(statusFilter) {
    if (statusFilter === 'published') {
        return 'No published templates. Publish a draft from the Draft view, or create a new template.';
    }
    if (statusFilter === 'archived') {
        return 'No archived templates.';
    }
    return 'No draft or in-testing templates. Create a template or switch to Published.';
}

function statusIndicatorType(status) {
    if (status === 'published') return 'success';
    if (status === 'archived') return 'stopped';
    if (status === 'in_testing') return 'in-progress';
    return 'info';
}

function testingDeployLabel(item) {
    const ds = item.testingDeployStatus;
    if (!ds) return null;
    if (ds === 'active') return 'Test stack active';
    if (ds === 'deploying') return 'Deploying…';
    if (ds === 'failed') return 'Test deploy failed (see note — usually CFN rollback, not Publish)';
    if (ds === 'stale') return 'Config changed — restart testing';
    return ds;
}

function testingValidationLabel(item) {
    if (item.status !== 'in_testing') return null;
    if (item.testingValidatedAt) return 'Validated — you can publish';
    if (item.testingDeployStatus === 'active') {
        return 'Smoke-test the app, then click Mark validated before Publish';
    }
    return null;
}

function needsDeployPoll(item) {
    return item.status === 'in_testing' && item.testingDeployStatus === 'deploying';
}

function deploymentDetailsPath(item) {
    if (!item.testingUseCaseId) return null;
    const type = item.useCaseType || 'AgentBuilder';
    return `/deployment-details/${type}/${item.testingUseCaseId}`;
}

function TemplateActionsDropdown({ items, busy, onItemClick, ariaLabel = 'More actions' }) {
    if (!items.length) {
        return null;
    }
    return (
        <ButtonDropdown
            ariaLabel={ariaLabel}
            items={items}
            disabled={busy}
            loading={busy}
            onItemClick={onItemClick}
        >
            Actions
        </ButtonDropdown>
    );
}

function DraftTemplateActions({ busy, onStartTesting, onSyncStatus }) {
    const dropdownItems = [{ text: 'Sync test status', id: 'sync' }];
    return (
        <SpaceBetween direction="horizontal" size="xs">
            <Button variant="primary" loading={busy} disabled={busy} onClick={onStartTesting}>
                Start testing
            </Button>
            <TemplateActionsDropdown
                items={dropdownItems}
                busy={busy}
                onItemClick={({ detail }) => {
                    if (detail.id === 'sync') onSyncStatus();
                }}
            />
        </SpaceBetween>
    );
}

function DraftOrchestratorTemplateActions({ busy, onPublish }) {
    return (
        <Button variant="primary" loading={busy} loadingText="Publishing…" disabled={busy} onClick={onPublish}>
            Publish to catalog
        </Button>
    );
}

function InTestingTemplateActions({
    item,
    busy,
    detailsPath,
    onOpenPublish,
    onMarkValidated,
    onRefresh,
    onRestart,
    onCancel,
    onNavigateDetails
}) {
    const dropdownItems = [];
    if (detailsPath && item.testingDeployStatus === 'active') {
        dropdownItems.push({ text: 'Deployment details', id: 'details' });
    }
    dropdownItems.push(
        { text: 'Refresh status', id: 'refresh' },
        { text: 'Restart testing', id: 'restart' },
        { text: 'Cancel testing', id: 'cancel' }
    );

    const showMarkValidated =
        !item.testingValidatedAt && item.testingDeployStatus === 'active';

    return (
        <SpaceBetween direction="horizontal" size="xs">
            {item.testingRuntimeUrl ? (
                <Button
                    iconAlign="right"
                    iconName="external"
                    href={item.testingRuntimeUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    disabled={busy}
                >
                    Open test chat
                </Button>
            ) : null}
            {showMarkValidated ? (
                <Button variant="primary" loading={busy} disabled={busy} onClick={onMarkValidated}>
                    Mark validated
                </Button>
            ) : (
                <Button
                    variant="primary"
                    loading={busy}
                    loadingText="Publishing…"
                    disabled={busy}
                    onClick={onOpenPublish}
                >
                    Publish
                </Button>
            )}
            <TemplateActionsDropdown
                items={dropdownItems}
                busy={busy}
                onItemClick={({ detail }) => {
                    if (detail.id === 'details') onNavigateDetails();
                    else if (detail.id === 'refresh') onRefresh();
                    else if (detail.id === 'restart') onRestart();
                    else if (detail.id === 'cancel') onCancel();
                }}
            />
        </SpaceBetween>
    );
}

export default function TemplatesListView() {
    const navigate = useNavigate();
    const location = useLocation();
    const [savedMessage, setSavedMessage] = useState(null);
    const [items, setItems] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [nextPageKey, setNextPageKey] = useState(undefined);
    const [busyId, setBusyId] = useState(null);
    const [decommissionTarget, setDecommissionTarget] = useState(null);
    const [statusFilter, setStatusFilter] = useState('published');
    const pollGenRef = useRef(0);

    const load = useCallback(
        async (pageKey, filter = statusFilter) => {
            setLoading(true);
            setError(null);
            try {
                const res = await listTemplates(20, pageKey, filter);
                setItems(res.templates ?? []);
                setNextPageKey(res.nextPageKey);
            } catch (e) {
                setError(e?.message || String(e));
            } finally {
                setLoading(false);
            }
        },
        [statusFilter]
    );

    const onStatusFilterChange = (filter) => {
        setStatusFilter(filter);
        setNextPageKey(undefined);
        void load(undefined, filter);
    };

    useEffect(() => {
        const message = location.state?.templateSavedMessage;
        if (typeof message === 'string' && message.trim()) {
            setSavedMessage(message.trim());
            navigate(location.pathname, { replace: true, state: {} });
        }
    }, [location.pathname, location.state, navigate]);

    useEffect(() => {
        load(undefined);
    }, [load]);

    useEffect(() => {
        const polling = items.filter(needsDeployPoll);
        if (polling.length === 0) {
            return undefined;
        }

        const generation = pollGenRef.current + 1;
        pollGenRef.current = generation;

        const tick = async () => {
            if (pollGenRef.current !== generation) return;
            for (const row of polling) {
                try {
                    const updated = await refreshTemplateTestingStatus(row.templateId);
                    if (pollGenRef.current !== generation) return;
                    setItems((prev) =>
                        prev.map((t) => (t.templateId === row.templateId ? { ...t, ...updated } : t))
                    );
                } catch {
                    /* keep polling */
                }
            }
        };

        const id = window.setInterval(() => {
            void tick();
        }, 25000);
        void tick();

        return () => {
            pollGenRef.current += 1;
            window.clearInterval(id);
        };
    }, [items]);

    const onFollowNavigationHandler = (event) => {
        navigate(event.detail.href);
    };

    const mergeTemplate = (templateId, patch) => {
        setItems((prev) => prev.map((t) => (t.templateId === templateId ? { ...t, ...patch } : t)));
    };

    const runAction = async (templateId, fn, optimisticPatch) => {
        setBusyId(templateId);
        setError(null);
        if (optimisticPatch) {
            mergeTemplate(templateId, optimisticPatch);
        }
        try {
            const updated = await fn();
            if (updated && typeof updated === 'object' && updated.templateId) {
                mergeTemplate(templateId, updated);
            } else {
                await load(undefined);
            }
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
            await load(undefined);
        } finally {
            setBusyId(null);
        }
    };

    const runPublish = async (templateId, slug) => {
        setBusyId(templateId);
        setError(null);
        setSavedMessage(null);
        try {
            const updated = await publishTemplate(templateId, {});
            if (updated && typeof updated === 'object' && updated.templateId) {
                mergeTemplate(templateId, updated);
            }
            if (statusFilter !== 'published') {
                setStatusFilter('published');
                await load(undefined, 'published');
            } else {
                await load(undefined);
            }
            setSavedMessage(`Published "${slug}" to the catalog.`);
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
            await load(undefined);
        } finally {
            setBusyId(null);
        }
    };

    const handlePublish = (item, event) => {
        event?.stopPropagation?.();
        if (!canPublish(item)) {
            const reason = publishDisabledReason(item);
            setError(reason || 'Cannot publish yet. Check the status column for what is missing.');
            return;
        }
        if (!window.confirm(`Publish "${item.slug}" to the AIW catalog?`)) {
            return;
        }
        void runPublish(item.templateId, item.slug);
    };

    const confirmDecommission = async () => {
        if (!decommissionTarget) return;
        setBusyId(decommissionTarget.templateId);
        setError(null);
        try {
            await unpublishTemplate(decommissionTarget.templateId, {});
            setDecommissionTarget(null);
            if (statusFilter === 'published') {
                await load(undefined);
            } else {
                await load(undefined, statusFilter);
            }
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        } finally {
            setBusyId(null);
        }
    };

    const canPublish = (item) => {
        if (isOrchestratorCatalogTemplate(item)) {
            return item.status === 'draft' || item.status === 'in_testing';
        }
        return (
            item.status === 'in_testing' &&
            item.testingDeployStatus === 'active' &&
            Boolean(item.testingValidatedAt)
        );
    };

    const publishDisabledReason = (item) => {
        if (isOrchestratorCatalogTemplate(item)) {
            if (item.status === 'draft' || item.status === 'in_testing') {
                return undefined;
            }
            return 'Orchestrator templates publish from draft after you save the template.';
        }
        if (item.status !== 'in_testing') {
            return 'Only templates in testing can be published.';
        }
        if (!item.testingDeployStatus) {
            return 'Refresh status to load the test deployment state.';
        }
        if (item.testingDeployStatus === 'deploying') {
            return 'Wait until the test stack is active, then click Refresh status.';
        }
        if (item.testingDeployStatus === 'stale') {
            return 'Deploy configuration changed — use Restart testing, then validate again.';
        }
        if (item.testingDeployStatus === 'failed') {
            return 'Fix or restart the test deployment before publishing.';
        }
        if (item.testingDeployStatus !== 'active') {
            return `Test deploy status: ${item.testingDeployStatus}`;
        }
        if (!item.testingValidatedAt) {
            return 'Click Mark validated after you smoke-test the deployment.';
        }
        return undefined;
    };

    return (
        <CustomAppLayout
            navigation={<Navigation activeHref="/templates" onFollowHandler={onFollowNavigationHandler} />}
            contentType="table"
            content={
                <SpaceBetween size="l">
                    <Modal
                        onDismiss={() => setDecommissionTarget(null)}
                        visible={Boolean(decommissionTarget)}
                        closeAriaLabel="Close"
                        header="Decommission template"
                        footer={
                            <Box float="right">
                                <SpaceBetween direction="horizontal" size="xs">
                                    <Button variant="link" onClick={() => setDecommissionTarget(null)}>
                                        Cancel
                                    </Button>
                                    <Button
                                        variant="primary"
                                        onClick={confirmDecommission}
                                        loading={Boolean(busyId)}
                                        disabled={Boolean(busyId)}
                                    >
                                        Decommission
                                    </Button>
                                </SpaceBetween>
                            </Box>
                        }
                    >
                        Decommission <strong>{decommissionTarget?.slug}</strong>? This removes the template from the public
                        catalog and archives it in GAAB. You cannot edit it afterward. You may create a new draft later
                        (the slug can be reused once nothing <em>published</em> uses it).
                    </Modal>
                    {savedMessage ? (
                        <Alert
                            type="success"
                            dismissible
                            onDismiss={() => setSavedMessage(null)}
                            header={savedMessage}
                        >
                            Return to the list anytime to start testing or publish when ready.
                        </Alert>
                    ) : null}
                    {error ? (
                        <Alert type="error" dismissible onDismiss={() => setError(null)} header="Action failed">
                            {error}
                        </Alert>
                    ) : null}
                    <Table
                        loading={loading}
                        loadingText="Loading templates"
                        filter={
                            <Select
                                selectedOption={
                                    STATUS_FILTER_OPTIONS.find((o) => o.value === statusFilter) ??
                                    STATUS_FILTER_OPTIONS[0]
                                }
                                onChange={({ detail }) => {
                                    const next = detail.selectedOption?.value;
                                    if (next && next !== statusFilter) {
                                        onStatusFilterChange(next);
                                    }
                                }}
                                options={STATUS_FILTER_OPTIONS}
                                ariaLabel="Filter templates by status"
                                selectedAriaLabel="Selected"
                            />
                        }
                        header={
                            <Header
                                variant="h1"
                                description="Agent templates: draft → start testing → validate → publish. Workflow orchestrator templates: save draft → publish to catalog (specialists attach in AIW; no GAAB test stack)."
                                actions={
                                    <Button variant="primary" onClick={() => navigate('/templates/create')}>
                                        Create template
                                    </Button>
                                }
                            >
                                Templates
                            </Header>
                        }
                        wrapLines={false}
                        resizableColumns
                        columnDefinitions={[
                            {
                                id: 'slug',
                                header: 'Slug',
                                minWidth: 160,
                                cell: (item) => (
                                    <Link
                                        href={`/templates/${item.templateId}/edit`}
                                        onFollow={(event) => {
                                            event.preventDefault();
                                            navigate(`/templates/${item.templateId}/edit`);
                                        }}
                                    >
                                        {item.slug}
                                    </Link>
                                ),
                                isRowHeader: true
                            },
                            {
                                id: 'author',
                                header: 'Author',
                                minWidth: 120,
                                cell: (item) => item.marketing?.author ?? '—'
                            },
                            {
                                id: 'status',
                                header: 'Status',
                                minWidth: 220,
                                cell: (item) => (
                                    <SpaceBetween size="xxs">
                                        <StatusIndicator type={statusIndicatorType(item.status)}>
                                            {item.status}
                                        </StatusIndicator>
                                        {item.status === 'in_testing' && testingDeployLabel(item) ? (
                                            <Box variant="small" color="text-body-secondary">
                                                {testingDeployLabel(item)}
                                                {item.testingError ? ` — ${item.testingError}` : ''}
                                            </Box>
                                        ) : null}
                                        {testingValidationLabel(item) ? (
                                            <Box
                                                variant="small"
                                                color={item.testingValidatedAt ? 'text-status-success' : 'text-status-warning'}
                                            >
                                                {testingValidationLabel(item)}
                                            </Box>
                                        ) : null}
                                    </SpaceBetween>
                                )
                            },
                            {
                                id: 'type',
                                header: 'Use case type',
                                cell: (item) => item.useCaseType ?? '—'
                            },
                            {
                                id: 'actions',
                                header: 'Actions',
                                minWidth: 280,
                                cell: (item) => {
                                    const busy = busyId === item.templateId;
                                    const detailsPath = deploymentDetailsPath(item);
                                    const templateId = item.templateId;

                                    if (item.status === 'draft') {
                                        if (isOrchestratorCatalogTemplate(item)) {
                                            return (
                                                <DraftOrchestratorTemplateActions
                                                    busy={busy}
                                                    onPublish={(e) => handlePublish(item, e)}
                                                />
                                            );
                                        }
                                        return (
                                            <DraftTemplateActions
                                                busy={busy}
                                                onStartTesting={() =>
                                                    runAction(
                                                        templateId,
                                                        () => startTemplateTesting(templateId),
                                                        {
                                                            status: 'in_testing',
                                                            testingDeployStatus: 'deploying'
                                                        }
                                                    )
                                                }
                                                onSyncStatus={() =>
                                                    runAction(templateId, () =>
                                                        refreshTemplateTestingStatus(templateId)
                                                    )
                                                }
                                            />
                                        );
                                    }
                                    if (item.status === 'in_testing') {
                                        return (
                                            <InTestingTemplateActions
                                                item={item}
                                                busy={busy}
                                                detailsPath={detailsPath}
                                                onOpenPublish={(e) => handlePublish(item, e)}
                                                onMarkValidated={() =>
                                                    runAction(
                                                        templateId,
                                                        () => markTemplateTestingValidated(templateId),
                                                        { testingValidatedAt: new Date().toISOString() }
                                                    )
                                                }
                                                onRefresh={() =>
                                                    runAction(templateId, () =>
                                                        refreshTemplateTestingStatus(templateId)
                                                    )
                                                }
                                                onRestart={() =>
                                                    runAction(templateId, () =>
                                                        restartTemplateTesting(templateId)
                                                    )
                                                }
                                                onCancel={() =>
                                                    runAction(templateId, () =>
                                                        cancelTemplateTesting(templateId)
                                                    )
                                                }
                                                onNavigateDetails={() => navigate(detailsPath)}
                                            />
                                        );
                                    }
                                    if (item.status === 'published') {
                                        return (
                                            <Button
                                                disabled={busy}
                                                onClick={() => setDecommissionTarget(item)}
                                            >
                                                Decommission
                                            </Button>
                                        );
                                    }
                                    return '—';
                                }
                            }
                        ]}
                        items={items}
                        empty={
                            <Box textAlign="center" padding="l">
                                {emptyListMessage(statusFilter)}
                            </Box>
                        }
                    />
                    {nextPageKey ? (
                        <Button onClick={() => load(nextPageKey)} disabled={loading}>
                            Load more
                        </Button>
                    ) : null}
                </SpaceBetween>
            }
            notifications={<Notifications successNotification={true} />}
        />
    );
}
