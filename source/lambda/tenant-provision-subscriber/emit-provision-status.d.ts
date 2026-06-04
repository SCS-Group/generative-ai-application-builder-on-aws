export type ProvisionStatusPhase = 'provisioning_started' | 'stack_complete' | 'runtime_ready' | 'failed';
export declare function emitTenantProvisionStatus(detail: {
    tenantTemplateInstanceId: string;
    phase: ProvisionStatusPhase;
    message?: string;
    gaabUseCaseId?: string;
    gaabMcpGatewayUseCaseId?: string;
    runtimeUiUrl?: string;
}): Promise<void>;
