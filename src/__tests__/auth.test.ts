/**
 * Unit tests for authentication middleware.
 */

import { Request, Response, NextFunction } from 'express';

// Mock environment before importing the module
const ORIGINAL_ENV = process.env;

function createMockReqRes(opts: {
    path?: string;
    authorization?: string;
    xApiKey?: string;
    ip?: string;
}): { req: Partial<Request>; res: Partial<Response> & { statusCode?: number; body?: any }; next: jest.Mock } {
    const req: Partial<Request> = {
        path: opts.path || '/test',
        ip: opts.ip || '127.0.0.1',
        headers: {
            ...(opts.authorization ? { authorization: opts.authorization } : {}),
            ...(opts.xApiKey ? { 'x-api-key': opts.xApiKey } : {}),
        } as any,
    };

    const res: Partial<Response> & { statusCode?: number; body?: any } = {
        statusCode: undefined,
        body: undefined,
        status(code: number) {
            this.statusCode = code;
            return this as Response;
        },
        json(data: any) {
            this.body = data;
            return this as Response;
        },
    };

    const next = jest.fn();
    return { req, res, next };
}

describe('Auth Middleware', () => {
    beforeEach(() => {
        jest.resetModules();
        process.env = { ...ORIGINAL_ENV };
    });

    afterAll(() => {
        process.env = ORIGINAL_ENV;
    });

    test('rejects all requests when no API keys configured', async () => {
        process.env['SCG_API_KEYS'] = '';
        const { authMiddleware } = await import('../middleware/auth');
        const { req, res, next } = createMockReqRes({});

        authMiddleware(req as Request, res as Response, next as NextFunction);

        expect(res.statusCode).toBe(503);
        expect(next).not.toHaveBeenCalled();
    });

    test('allows health check without auth', async () => {
        process.env['SCG_API_KEYS'] = '';
        const { authMiddleware } = await import('../middleware/auth');
        const { req, res, next } = createMockReqRes({ path: '/health' });

        authMiddleware(req as Request, res as Response, next as NextFunction);

        expect(next).toHaveBeenCalled();
    });

    test('allows ready check without auth', async () => {
        process.env['SCG_API_KEYS'] = '';
        const { authMiddleware } = await import('../middleware/auth');
        const { req, res, next } = createMockReqRes({ path: '/ready' });

        authMiddleware(req as Request, res as Response, next as NextFunction);

        expect(next).toHaveBeenCalled();
    });

    test('accepts valid Bearer token', async () => {
        process.env['SCG_API_KEYS'] = 'my-secret-key';
        const { authMiddleware } = await import('../middleware/auth');
        const { req, res, next } = createMockReqRes({
            authorization: 'Bearer my-secret-key',
        });

        authMiddleware(req as Request, res as Response, next as NextFunction);

        expect(next).toHaveBeenCalled();
    });

    test('accepts valid X-API-Key header', async () => {
        process.env['SCG_API_KEYS'] = 'my-secret-key';
        const { authMiddleware } = await import('../middleware/auth');
        const { req, res, next } = createMockReqRes({
            xApiKey: 'my-secret-key',
        });

        authMiddleware(req as Request, res as Response, next as NextFunction);

        expect(next).toHaveBeenCalled();
    });

    test('rejects invalid key with 403', async () => {
        process.env['SCG_API_KEYS'] = 'correct-key';
        const { authMiddleware } = await import('../middleware/auth');
        const { req, res, next } = createMockReqRes({
            authorization: 'Bearer wrong-key',
        });

        authMiddleware(req as Request, res as Response, next as NextFunction);

        expect(res.statusCode).toBe(403);
        expect(next).not.toHaveBeenCalled();
    });

    test('rejects missing key with 401', async () => {
        process.env['SCG_API_KEYS'] = 'correct-key';
        const { authMiddleware } = await import('../middleware/auth');
        const { req, res, next } = createMockReqRes({});

        authMiddleware(req as Request, res as Response, next as NextFunction);

        expect(res.statusCode).toBe(401);
        expect(next).not.toHaveBeenCalled();
    });

    test('supports multiple comma-separated keys', async () => {
        process.env['SCG_API_KEYS'] = 'key-1,key-2,key-3';
        const { authMiddleware } = await import('../middleware/auth');
        const { req, res, next } = createMockReqRes({
            xApiKey: 'key-2',
        });

        authMiddleware(req as Request, res as Response, next as NextFunction);

        expect(next).toHaveBeenCalled();
    });
});
