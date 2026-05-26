// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

export const AGENT_TEMPLATES_TABLE_NAME_ENV_VAR = 'AGENT_TEMPLATES_TABLE_NAME';
export const EVENT_BUS_NAME_ENV_VAR = 'EVENT_BUS_NAME';
export const TEMPLATE_TEST_AGENT_FUNCTION_NAME_ENV_VAR = 'TEMPLATE_TEST_AGENT_FUNCTION_NAME';
export const TEMPLATE_TEST_SYSTEM_USER_ID_ENV_VAR = 'TEMPLATE_TEST_SYSTEM_USER_ID';
export const USE_CASES_TABLE_NAME_ENV_VAR = 'USE_CASES_TABLE_NAME';

export const REQUIRED_ENV_VARS = [
    AGENT_TEMPLATES_TABLE_NAME_ENV_VAR,
    EVENT_BUS_NAME_ENV_VAR,
    TEMPLATE_TEST_AGENT_FUNCTION_NAME_ENV_VAR,
    TEMPLATE_TEST_SYSTEM_USER_ID_ENV_VAR,
    USE_CASES_TABLE_NAME_ENV_VAR
];

export const STATUS_DRAFT = 'draft';
export const STATUS_IN_TESTING = 'in_testing';
export const STATUS_PUBLISHED = 'published';
/** Removed from tenant catalog; emits `TemplateUnpublished` to AIW. */
export const STATUS_ARCHIVED = 'archived';

export const GSI_STATUS_SLUG = 'StatusSlugIndex';

/** TestingDeployStatus values on template records */
export const TESTING_DEPLOY_DEPLOYING = 'deploying';
export const TESTING_DEPLOY_ACTIVE = 'active';
export const TESTING_DEPLOY_FAILED = 'failed';
export const TESTING_DEPLOY_STALE = 'stale';

export const ACTIVE_STACK_STATUSES = new Set(['CREATE_COMPLETE', 'UPDATE_COMPLETE']);
/** Terminal failure — does not trigger stack deletion; operator uses Cancel or Restart. */
export const FAILED_STACK_STATUSES = new Set([
    'CREATE_FAILED',
    'ROLLBACK_COMPLETE',
    'ROLLBACK_FAILED',
    'DELETE_FAILED',
    'UPDATE_ROLLBACK_COMPLETE',
    'UPDATE_ROLLBACK_FAILED'
]);

/** In-flight — must not be treated as failed (would confuse UI; never delete stack for these). */
export const IN_PROGRESS_STACK_STATUSES = new Set([
    'CREATE_IN_PROGRESS',
    'UPDATE_IN_PROGRESS',
    'UPDATE_COMPLETE_CLEANUP_IN_PROGRESS',
    'UPDATE_ROLLBACK_IN_PROGRESS',
    'UPDATE_ROLLBACK_COMPLETE_CLEANUP_IN_PROGRESS',
    'ROLLBACK_IN_PROGRESS'
]);
