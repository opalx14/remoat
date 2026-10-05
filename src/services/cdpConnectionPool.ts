import { EventEmitter } from 'events';
import * as path from 'path';

import { logger } from '../utils/logger';
import { extractProjectNameFromPath } from '../utils/pathUtils';
import { CdpService, CdpServiceOptions } from './cdpService';
import { ApprovalDetector } from './approvalDetector';
import { ErrorPopupDetector } from './errorPopupDetector';
import { PlanningDetector } from './planningDetector';
import { UserMessageDetector } from './userMessageDetector';

/**
 * Pool that manages independent CdpService instances per workspace.
 *
 * Each workspace owns its own WebSocket / contexts / pendingCalls, so
 * switching to workspace B while workspace A's ResponseMonitor is polling
 * does not destroy A's WebSocket.
 *
 * Emits workspace lifecycle events:
 * - `workspace:disconnected` (projectName: string)
 * - `workspace:reconnected` (projectName: string)
 * - `workspace:reconnectFailed` (projectName: string)
 */
export class CdpConnectionPool extends EventEmitter {
    /** CDP connections keyed by normalized full workspace path. */
    private readonly connections = new Map<string, CdpService>();
    /** Human-readable project name for each full-path connection key. */
    private readonly connectionProjectNames = new Map<string, string>();
    private readonly approvalDetectors = new Map<string, ApprovalDetector>();
    private readonly errorPopupDetectors = new Map<string, ErrorPopupDetector>();
    private readonly planningDetectors = new Map<string, PlanningDetector>();
    private readonly userMessageDetectors = new Map<string, UserMessageDetector>();
    private readonly connectingPromises = new Map<string, Promise<CdpService>>();
    private readonly cdpOptions: CdpServiceOptions;

    constructor(cdpOptions: CdpServiceOptions = {}) {
        super();
        this.cdpOptions = cdpOptions;
    }

    /**
     * Get a CdpService for the given workspace path.
     * Creates a new connection and caches it if not already connected.
     * Prevents concurrent connections via Promise locking.
     *
     * @param workspacePath Full path of the workspace
     * @returns Connected CdpService
     */
    async getOrConnect(workspacePath: string): Promise<CdpService> {
        const projectName = this.extractProjectName(workspacePath);
        const connectionKey = this.getConnectionKey(workspacePath);

        // Return an existing connection only for this exact workspace path.
        // Basenames are not unique: /client-a/app and /client-b/app are different workspaces.
        const existing = this.connections.get(connectionKey);
        if (existing) {
            if (existing.isConnected()) {
                try {
                    // Re-validate that the still-open window is actually bound to this workspace.
                    await existing.discoverAndConnectForWorkspace(workspacePath);
                    return existing;
                } catch {
                    // Connection dropped during re-validation; close WebSocket and clean up.
                    existing.disconnect().catch(() => {});
                    this.connections.delete(connectionKey);
                    this.connectionProjectNames.delete(connectionKey);
                }
            } else {
                // Stale disconnected entry (e.g. reconnect was disabled) — clean up.
                this.connections.delete(connectionKey);
                this.connectionProjectNames.delete(connectionKey);
            }
        }

        // Wait for a pending connection to this exact workspace path.
        const pending = this.connectingPromises.get(connectionKey);
        if (pending) {
            return pending;
        }

        const connectPromise = this.createAndConnect(workspacePath, projectName, connectionKey);
        this.connectingPromises.set(connectionKey, connectPromise);

        try {
            return await connectPromise;
        } finally {
            this.connectingPromises.delete(connectionKey);
        }
    }

    /**
     * Get a connected CdpService (read-only).
     * Returns null if not connected.
     */
    getConnected(projectName: string): CdpService | null {
        const matches = [...this.connections.entries()].filter(([key, cdp]) =>
            this.connectionProjectNames.get(key) === projectName && cdp.isConnected(),
        );

        if (matches.length === 1) {
            return matches[0][1];
        }

        if (matches.length > 1) {
            logger.warn(
                `[CdpConnectionPool] Ambiguous project name "${projectName}" maps to ${matches.length} workspace paths; refusing implicit selection.`,
            );
        }
        return null;
    }

    /**
     * Disconnect the specified workspace.
     */
    disconnectWorkspace(projectName: string): void {
        const matchingKeys = [...this.connections.keys()].filter(
            (key) => this.connectionProjectNames.get(key) === projectName,
        );

        for (const key of matchingKeys) {
            const cdp = this.connections.get(key);
            if (cdp) {
                cdp.disconnect().catch((err) => {
                    logger.error(`[CdpConnectionPool] Error while disconnecting ${projectName}:`, err);
                });
            }
            this.connections.delete(key);
            this.connectionProjectNames.delete(key);
        }

        const detector = this.approvalDetectors.get(projectName);
        if (detector) {
            detector.stop();
            this.approvalDetectors.delete(projectName);
        }

        const errorPopupDetector = this.errorPopupDetectors.get(projectName);
        if (errorPopupDetector) {
            errorPopupDetector.stop();
            this.errorPopupDetectors.delete(projectName);
        }

        const planningDetector = this.planningDetectors.get(projectName);
        if (planningDetector) {
            planningDetector.stop();
            this.planningDetectors.delete(projectName);
        }

        const userMsgDetector = this.userMessageDetectors.get(projectName);
        if (userMsgDetector) {
            userMsgDetector.stop();
            this.userMessageDetectors.delete(projectName);
        }
    }

    /**
     * Completely close the Antigravity instance for the specified workspace via CDP.
     */
    async closeBrowserWorkspace(projectName: string): Promise<void> {
        const matchingCdps = [...this.connections.entries()]
            .filter(([key]) => this.connectionProjectNames.get(key) === projectName)
            .map(([, cdp]) => cdp);

        for (const cdp of matchingCdps) {
            try {
                await cdp.closeBrowserTarget();
            } catch (err) {
                logger.error(`[CdpConnectionPool] Error while closing browser for ${projectName}:`, err);
            }
        }
        this.disconnectWorkspace(projectName);
    }

    /**
     * Disconnect all workspace connections.
     */
    disconnectAll(): void {
        for (const [key, cdp] of [...this.connections.entries()]) {
            cdp.disconnect().catch((err) => {
                logger.error(`[CdpConnectionPool] Error while disconnecting ${key}:`, err);
            });
        }
        this.connections.clear();
        this.connectionProjectNames.clear();

        for (const projectName of [...this.approvalDetectors.keys()]) {
            this.disconnectDetectors(projectName);
        }
    }

    /**
     * Register an approval detector for a workspace.
     */
    registerApprovalDetector(projectName: string, detector: ApprovalDetector): void {
        // Stop existing detector
        const existing = this.approvalDetectors.get(projectName);
        if (existing && existing.isActive()) {
            existing.stop();
        }
        this.approvalDetectors.set(projectName, detector);
    }

    /**
     * Get the approval detector for a workspace.
     */
    getApprovalDetector(projectName: string): ApprovalDetector | undefined {
        return this.approvalDetectors.get(projectName);
    }

    /**
     * Register an error popup detector for a workspace.
     */
    registerErrorPopupDetector(projectName: string, detector: ErrorPopupDetector): void {
        // Stop existing detector
        const existing = this.errorPopupDetectors.get(projectName);
        if (existing && existing.isActive()) {
            existing.stop();
        }
        this.errorPopupDetectors.set(projectName, detector);
    }

    /**
     * Get the error popup detector for a workspace.
     */
    getErrorPopupDetector(projectName: string): ErrorPopupDetector | undefined {
        return this.errorPopupDetectors.get(projectName);
    }

    /**
     * Register a planning detector for a workspace.
     */
    registerPlanningDetector(projectName: string, detector: PlanningDetector): void {
        // Stop existing detector
        const existing = this.planningDetectors.get(projectName);
        if (existing && existing.isActive()) {
            existing.stop();
        }
        this.planningDetectors.set(projectName, detector);
    }

    /**
     * Get the planning detector for a workspace.
     */
    getPlanningDetector(projectName: string): PlanningDetector | undefined {
        return this.planningDetectors.get(projectName);
    }

    /**
     * Register a user message detector for a workspace.
     */
    registerUserMessageDetector(projectName: string, detector: UserMessageDetector): void {
        const existing = this.userMessageDetectors.get(projectName);
        if (existing && existing.isActive()) {
            existing.stop();
        }
        this.userMessageDetectors.set(projectName, detector);
    }

    /**
     * Get the user message detector for a workspace.
     */
    getUserMessageDetector(projectName: string): UserMessageDetector | undefined {
        return this.userMessageDetectors.get(projectName);
    }

    /**
     * Return a list of workspace names with active connections.
     */
    getActiveWorkspaceNames(): string[] {
        const active = new Set<string>();
        for (const [key, cdp] of this.connections) {
            if (cdp.isConnected()) {
                const projectName = this.connectionProjectNames.get(key);
                if (projectName) active.add(projectName);
            }
        }
        return [...active];
    }

    /**
     * Extract the project name from a workspace path.
     */
    extractProjectName(workspacePath: string): string {
        return extractProjectNameFromPath(workspacePath) || workspacePath;
    }

    /**
     * Create a new CdpService and connect to the workspace.
     */
    private async createAndConnect(
        workspacePath: string,
        projectName: string,
        connectionKey: string,
    ): Promise<CdpService> {
        // Disconnect an old connection only for this exact workspace path.
        const old = this.connections.get(connectionKey);
        if (old) {
            await old.disconnect().catch(() => {});
            this.connections.delete(connectionKey);
            this.connectionProjectNames.delete(connectionKey);
        }

        const cdp = new CdpService(this.cdpOptions);

        // Auto-cleanup on disconnect
        cdp.on('disconnected', () => {
            logger.error(`[CdpConnectionPool] Workspace "${projectName}" disconnected`);
            this.emit('workspace:disconnected', projectName);
            // Only remove from Map when reconnection fails
            // (CdpService attempts reconnection internally, so we don't remove here)
        });

        cdp.on('reconnected', () => {
            logger.info(`[CdpConnectionPool] Workspace "${projectName}" reconnected`);
            this.emit('workspace:reconnected', projectName);
        });

        cdp.on('reconnectFailed', () => {
            logger.error(`[CdpConnectionPool] Reconnection failed for workspace "${projectName}". Removing exact path from pool`);
            this.emit('workspace:reconnectFailed', projectName);
            this.disconnectConnectionKey(connectionKey);
            this.disconnectDetectors(projectName);
        });

        // Connect to the workspace.
        await cdp.discoverAndConnectForWorkspace(workspacePath);
        this.connections.set(connectionKey, cdp);
        this.connectionProjectNames.set(connectionKey, projectName);

        return cdp;
    }

    private getConnectionKey(workspacePath: string): string {
        return path.resolve(workspacePath);
    }

    private disconnectConnectionKey(connectionKey: string): void {
        const cdp = this.connections.get(connectionKey);
        const projectName = this.connectionProjectNames.get(connectionKey) || connectionKey;
        if (cdp) {
            cdp.disconnect().catch((err) => {
                logger.error(`[CdpConnectionPool] Error while disconnecting ${projectName}:`, err);
            });
        }
        this.connections.delete(connectionKey);
        this.connectionProjectNames.delete(connectionKey);
    }

    private disconnectDetectors(projectName: string): void {
        const detector = this.approvalDetectors.get(projectName);
        if (detector) {
            detector.stop();
            this.approvalDetectors.delete(projectName);
        }

        const errorPopupDetector = this.errorPopupDetectors.get(projectName);
        if (errorPopupDetector) {
            errorPopupDetector.stop();
            this.errorPopupDetectors.delete(projectName);
        }

        const planningDetector = this.planningDetectors.get(projectName);
        if (planningDetector) {
            planningDetector.stop();
            this.planningDetectors.delete(projectName);
        }

        const userMsgDetector = this.userMessageDetectors.get(projectName);
        if (userMsgDetector) {
            userMsgDetector.stop();
            this.userMessageDetectors.delete(projectName);
        }
    }
}
