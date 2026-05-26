// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
    Alert,
    Box,
    Button,
    Header,
    Modal,
    SpaceBetween,
    StatusIndicator,
    Table
} from '@cloudscape-design/components';
import { CustomAppLayout, Navigation, Notifications } from '../commons/common-components';
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

function needsDeployPoll(item) {
    return item.status === 'in_testing' && item.testingDeployStatus === 'deploying';
}

function deploymentDetailsPath(item) {
    if (!item.testingUseCaseId) return null;
    const type = item.useCaseType || 'AgentBuilder';
    return `/deployment-details/${type}/${item.testingUseCaseId}`;
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
    const pollGenRef = useRef(0);

    const load = useCallback(async (pageKey) => {
        setLoading(true);
        setError(null);
        try {
            const res = await listTemplates(20, pageKey);
            setItems(res.templates ?? []);
            setNextPageKey(res.nextPageKey);
        } catch (e) {
            setError(e?.message || String(e));
        } finally {
            setLoading(false);
        }
    }, []);

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
            setError(e?.message || String(e));
            await load(undefined);
        } finally {
            setBusyId(null);
        }
    };

    const confirmDecommission = async () => {
        if (!decommissionTarget) return;
        setBusyId(decommissionTarget.templateId);
        setError(null);
        try {
            await unpublishTemplate(decommissionTarget.templateId, {});
            setDecommissionTarget(null);
            await load(undefined);
        } catch (e) {
            setError(e?.message || String(e));
        } finally {
            setBusyId(null);
        }
    };

    const canPublish = (item) =>
        item.status === 'in_testing' &&
        item.testingDeployStatus === 'active' &&
        Boolean(item.testingValidatedAt);

    const publishDisabledReason = (item) => {
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
                        <Alert type="error" header="Request failed">
                            {error}
                        </Alert>
                    ) : null}
                    <Table
                        loading={loading}
                        loadingText="Loading templates"
                        header={
                            <Header
                                variant="h1"
                                description="Draft → start testing (deploys a temporary stack; status is saved immediately) → open the test app when active → mark validated → publish. Leaving in testing destroys the test stack."
                                actions={
                                    <Button variant="primary" onClick={() => navigate('/templates/create')}>
                                        Create template
                                    </Button>
                                }
                            >
                                Templates
                            </Header>
                        }
                        columnDefinitions={[
                            {
                                id: 'slug',
                                header: 'Slug',
                                cell: (item) => (
                                    <Button
                                        variant="link"
                                        onClick={() => navigate(`/templates/${item.templateId}/edit`)}
                                    >
                                        {item.slug}
                                    </Button>
                                ),
                                isRowHeader: true
                            },
                            {
                                id: 'author',
                                header: 'Author',
                                cell: (item) => item.marketing?.author ?? '—'
                            },
                            {
                                id: 'status',
                                header: 'Status',
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
                                cell: (item) => {
                                    const busy = busyId === item.templateId;
                                    const detailsPath = deploymentDetailsPath(item);

                                    if (item.status === 'draft') {
                                        return (
                                            <SpaceBetween direction="horizontal" size="xs">
                                                <Button
                                                    loading={busy}
                                                    disabled={busy}
                                                    onClick={() =>
                                                        runAction(
                                                            item.templateId,
                                                            () => startTemplateTesting(item.templateId),
                                                            {
                                                                status: 'in_testing',
                                                                testingDeployStatus: 'deploying'
                                                            }
                                                        )
                                                    }
                                                >
                                                    Start testing
                                                </Button>
                                                <Button
                                                    disabled={busy}
                                                    onClick={() =>
                                                        runAction(item.templateId, () =>
                                                            refreshTemplateTestingStatus(item.templateId)
                                                        )
                                                    }
                                                >
                                                    Sync test status
                                                </Button>
                                            </SpaceBetween>
                                        );
                                    }
                                    if (item.status === 'in_testing') {
                                        return (
                                            <SpaceBetween direction="horizontal" size="xs">
                                                {item.testingRuntimeUrl ? (
                                                    <Button
                                                        iconAlign="right"
                                                        iconName="external"
                                                        href={item.testingRuntimeUrl}
                                                        target="_blank"
                                                        rel="noopener noreferrer"
                                                    >
                                                        Open test chat
                                                    </Button>
                                                ) : null}
                                                {detailsPath && item.testingDeployStatus === 'active' ? (
                                                    <Button variant="link" onClick={() => navigate(detailsPath)}>
                                                        Deployment details
                                                    </Button>
                                                ) : null}
                                                {!item.testingValidatedAt &&
                                                item.testingDeployStatus === 'active' ? (
                                                    <Button
                                                        loading={busy}
                                                        disabled={busy}
                                                        onClick={() =>
                                                            runAction(item.templateId, () =>
                                                                markTemplateTestingValidated(item.templateId)
                                                            )
                                                        }
                                                    >
                                                        Mark validated
                                                    </Button>
                                                ) : null}
                                                <Button
                                                    loading={busy}
                                                    disabled={busy || !canPublish(item)}
                                                    disabledReason={publishDisabledReason(item)}
                                                    onClick={() =>
                                                        runAction(item.templateId, () =>
                                                            publishTemplate(item.templateId, {})
                                                        )
                                                    }
                                                >
                                                    Publish
                                                </Button>
                                                <Button
                                                    loading={busy}
                                                    disabled={busy}
                                                    onClick={() =>
                                                        runAction(item.templateId, () =>
                                                            refreshTemplateTestingStatus(item.templateId)
                                                        )
                                                    }
                                                >
                                                    Refresh status
                                                </Button>
                                                <Button
                                                    loading={busy}
                                                    disabled={busy}
                                                    onClick={() =>
                                                        runAction(item.templateId, () =>
                                                            restartTemplateTesting(item.templateId)
                                                        )
                                                    }
                                                >
                                                    Restart testing
                                                </Button>
                                                <Button
                                                    loading={busy}
                                                    disabled={busy}
                                                    onClick={() =>
                                                        runAction(item.templateId, () =>
                                                            cancelTemplateTesting(item.templateId)
                                                        )
                                                    }
                                                >
                                                    Cancel testing
                                                </Button>
                                            </SpaceBetween>
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
                                No templates yet. Create one to add an entry to the catalog.
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
