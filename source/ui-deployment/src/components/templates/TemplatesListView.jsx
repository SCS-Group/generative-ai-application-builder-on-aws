// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
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
import { listTemplates, publishTemplate, unpublishTemplate } from '../../services/fetchTemplates';

function statusIndicatorType(status) {
    if (status === 'published') return 'success';
    if (status === 'archived') return 'stopped';
    return 'in-progress';
}

export default function TemplatesListView() {
    const navigate = useNavigate();
    const [items, setItems] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [nextPageKey, setNextPageKey] = useState(undefined);
    const [publishingId, setPublishingId] = useState(null);
    const [unpublishingId, setUnpublishingId] = useState(null);
    const [decommissionTarget, setDecommissionTarget] = useState(null);

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
        load(undefined);
    }, [load]);

    const onFollowNavigationHandler = (event) => {
        navigate(event.detail.href);
    };

    const onPublish = async (row) => {
        setPublishingId(row.templateId);
        setError(null);
        try {
            await publishTemplate(row.templateId, {});
            await load(undefined);
        } catch (e) {
            setError(e?.message || String(e));
        } finally {
            setPublishingId(null);
        }
    };

    const confirmDecommission = async () => {
        if (!decommissionTarget) return;
        setUnpublishingId(decommissionTarget.templateId);
        setError(null);
        try {
            await unpublishTemplate(decommissionTarget.templateId, {});
            setDecommissionTarget(null);
            await load(undefined);
        } catch (e) {
            setError(e?.message || String(e));
        } finally {
            setUnpublishingId(null);
        }
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
                                        loading={Boolean(unpublishingId)}
                                        disabled={Boolean(unpublishingId)}
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
                                description="Drafts are editable in GAAB. Publishing makes the template available in the public catalog. Decommissioning removes it from the catalog and archives the row."
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
                                    <StatusIndicator type={statusIndicatorType(item.status)}>{item.status}</StatusIndicator>
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
                                    if (item.status === 'draft') {
                                        return (
                                            <Button
                                                disabled={publishingId === item.templateId}
                                                onClick={() => onPublish(item)}
                                            >
                                                Publish
                                            </Button>
                                        );
                                    }
                                    if (item.status === 'published') {
                                        return (
                                            <Button
                                                disabled={unpublishingId === item.templateId}
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
