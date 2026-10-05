import { CdpConnectionPool } from '../../src/services/cdpConnectionPool';
import { CdpService } from '../../src/services/cdpService';

jest.mock('../../src/services/cdpService');

describe('CdpConnectionPool — bug fix coverage', () => {
    let pool: CdpConnectionPool;

    beforeEach(() => {
        pool = new CdpConnectionPool({ cdpCallTimeout: 5000 });
        jest.spyOn(console, 'error').mockImplementation(() => {});
        jest.spyOn(console, 'log').mockImplementation(() => {});
    });

    afterEach(() => {
        pool.disconnectAll();
        jest.restoreAllMocks();
    });

    describe('disconnect stale connection on re-validation failure', () => {
        it('disconnects and removes the stale entry when re-validation throws', async () => {
            const mockCdp = {
                isConnected: jest.fn().mockReturnValue(true),
                discoverAndConnectForWorkspace: jest.fn()
                    .mockResolvedValueOnce(true)        // initial connect succeeds
                    .mockRejectedValueOnce(new Error('tab closed')), // re-validation fails
                on: jest.fn(),
                disconnect: jest.fn().mockResolvedValue(undefined),
            };

            const freshCdp = {
                isConnected: jest.fn().mockReturnValue(true),
                discoverAndConnectForWorkspace: jest.fn().mockResolvedValue(true),
                on: jest.fn(),
                disconnect: jest.fn().mockResolvedValue(undefined),
            };

            let callCount = 0;
            (CdpService as jest.MockedClass<typeof CdpService>).mockImplementation(() => {
                callCount++;
                return (callCount === 1 ? mockCdp : freshCdp) as any;
            });

            // First connection succeeds
            const cdp1 = await pool.getOrConnect('/path/to/Project');
            expect(cdp1).toBe(mockCdp);

            // Second call: re-validation throws → should disconnect stale, create new
            const cdp2 = await pool.getOrConnect('/path/to/Project');

            // Bug fix: stale connection should have been disconnected
            expect(mockCdp.disconnect).toHaveBeenCalled();
            // New connection should be returned
            expect(cdp2).toBe(freshCdp);
        });

        it('cleans up disconnected entries without calling disconnect', async () => {
            const mockCdp = {
                // Returns false when checked on second getOrConnect (stale entry)
                isConnected: jest.fn().mockReturnValue(false),
                discoverAndConnectForWorkspace: jest.fn().mockResolvedValue(true),
                on: jest.fn(),
                disconnect: jest.fn().mockResolvedValue(undefined),
            };

            const freshCdp = {
                isConnected: jest.fn().mockReturnValue(true),
                discoverAndConnectForWorkspace: jest.fn().mockResolvedValue(true),
                on: jest.fn(),
                disconnect: jest.fn().mockResolvedValue(undefined),
            };

            let callCount = 0;
            (CdpService as jest.MockedClass<typeof CdpService>).mockImplementation(() => {
                callCount++;
                return (callCount === 1 ? mockCdp : freshCdp) as any;
            });

            // First connect goes through createAndConnect (no isConnected check)
            await pool.getOrConnect('/path/to/Project');
            // Second call: existing found, isConnected()=false → stale, cleaned up → new connection
            const cdp2 = await pool.getOrConnect('/path/to/Project');

            // Stale disconnected entry should be replaced with fresh connection
            expect(cdp2).toBe(freshCdp);
            // disconnect() should NOT be called on stale entry (already disconnected)
            expect(mockCdp.disconnect).not.toHaveBeenCalled();
        });
    });

    describe('workspace path isolation', () => {
        it('keeps separate CDP connections for different full paths with the same basename', async () => {
            const firstCdp = {
                isConnected: jest.fn().mockReturnValue(true),
                discoverAndConnectForWorkspace: jest.fn().mockResolvedValue(true),
                on: jest.fn(),
                disconnect: jest.fn().mockResolvedValue(undefined),
            };
            const secondCdp = {
                isConnected: jest.fn().mockReturnValue(true),
                discoverAndConnectForWorkspace: jest.fn().mockResolvedValue(true),
                on: jest.fn(),
                disconnect: jest.fn().mockResolvedValue(undefined),
            };

            let callCount = 0;
            (CdpService as jest.MockedClass<typeof CdpService>).mockImplementation(() => {
                callCount++;
                return (callCount === 1 ? firstCdp : secondCdp) as any;
            });

            const a = await pool.getOrConnect('/clients/acme/app');
            const b = await pool.getOrConnect('/clients/other/app');

            expect(a).toBe(firstCdp);
            expect(b).toBe(secondCdp);
            expect(a).not.toBe(b);
            expect(firstCdp.discoverAndConnectForWorkspace).toHaveBeenCalledWith('/clients/acme/app');
            expect(secondCdp.discoverAndConnectForWorkspace).toHaveBeenCalledWith('/clients/other/app');
            expect(pool.getConnected('app')).toBeNull();
        });
    });

    describe('reconnectFailed uses disconnectWorkspace', () => {
        it('removes connection and stops detectors on reconnectFailed', async () => {
            const eventHandlers: Record<string, Function> = {};
            const mockCdp = {
                isConnected: jest.fn().mockReturnValue(true),
                discoverAndConnectForWorkspace: jest.fn().mockResolvedValue(true),
                on: jest.fn((event: string, handler: Function) => {
                    eventHandlers[event] = handler;
                }),
                disconnect: jest.fn().mockResolvedValue(undefined),
            };

            (CdpService as jest.MockedClass<typeof CdpService>).mockImplementation(() => mockCdp as any);

            await pool.getOrConnect('/path/to/Project');

            // Register a detector
            const mockDetector = {
                isActive: jest.fn().mockReturnValue(true),
                stop: jest.fn(),
                start: jest.fn(),
            } as any;
            pool.registerApprovalDetector('Project', mockDetector);

            // Simulate reconnectFailed event
            expect(eventHandlers['reconnectFailed']).toBeDefined();
            eventHandlers['reconnectFailed']();

            // Bug fix: should use disconnectWorkspace which cleans up detectors too
            expect(mockCdp.disconnect).toHaveBeenCalled();
            expect(mockDetector.stop).toHaveBeenCalled();
            expect(pool.getConnected('Project')).toBeNull();
            expect(pool.getApprovalDetector('Project')).toBeUndefined();
        });

        it('registers disconnected event handler', async () => {
            const eventHandlers: Record<string, Function> = {};
            const mockCdp = {
                isConnected: jest.fn().mockReturnValue(true),
                discoverAndConnectForWorkspace: jest.fn().mockResolvedValue(true),
                on: jest.fn((event: string, handler: Function) => {
                    eventHandlers[event] = handler;
                }),
                disconnect: jest.fn().mockResolvedValue(undefined),
            };

            (CdpService as jest.MockedClass<typeof CdpService>).mockImplementation(() => mockCdp as any);

            await pool.getOrConnect('/path/to/Project');

            expect(eventHandlers['disconnected']).toBeDefined();
            expect(eventHandlers['reconnectFailed']).toBeDefined();
        });
    });
});
