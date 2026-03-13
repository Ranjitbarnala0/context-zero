/**
 * Unit tests for rate limiting middleware.
 */

import { Request, Response, NextFunction } from 'express';

describe('Rate Limiter', () => {
    let rateLimitMiddleware: (req: Request, res: Response, next: NextFunction) => void;
    let limiter: { check: Function; destroy: Function };

    beforeEach(async () => {
        jest.resetModules();
        const mod = await import('../middleware/rate-limiter');
        rateLimitMiddleware = mod.rateLimitMiddleware;
        limiter = mod.limiter;
    });

    afterEach(() => {
        limiter.destroy();
    });

    function createMock(path: string, ip: string = '127.0.0.1') {
        const req: Partial<Request> = {
            path,
            ip,
            socket: { remoteAddress: ip } as any,
        };
        let statusCode: number | undefined;
        let body: any;
        const headers: Record<string, string> = {};

        const res: Partial<Response> = {
            status(code: number) { statusCode = code; return this as Response; },
            json(data: any) { body = data; return this as Response; },
            set(key: string, val: string) { headers[key] = val; return this as Response; },
        };
        const next = jest.fn();
        return {
            req: req as Request,
            res: res as Response,
            next,
            getStatus: () => statusCode,
            getBody: () => body,
            getHeaders: () => headers,
        };
    }

    test('allows requests within limit', () => {
        const { req, res, next } = createMock('/test');
        rateLimitMiddleware(req, res, next);
        expect(next).toHaveBeenCalled();
    });

    test('blocks requests exceeding limit', () => {
        // Default limit is 60/min
        for (let i = 0; i < 60; i++) {
            const { req, res, next } = createMock('/test');
            rateLimitMiddleware(req, res, next);
        }

        // 61st request should be blocked
        const mock = createMock('/test');
        rateLimitMiddleware(mock.req, mock.res, mock.next);
        expect(mock.next).not.toHaveBeenCalled();
        expect(mock.getStatus()).toBe(429);
        expect(mock.getHeaders()['Retry-After']).toBeDefined();
    });

    test('different IPs have independent limits', () => {
        // Fill up limit for IP 1
        for (let i = 0; i < 60; i++) {
            const { req, res, next } = createMock('/test', '10.0.0.1');
            rateLimitMiddleware(req, res, next);
        }

        // IP 2 should still be allowed
        const mock = createMock('/test', '10.0.0.2');
        rateLimitMiddleware(mock.req, mock.res, mock.next);
        expect(mock.next).toHaveBeenCalled();
    });

    test('health endpoint bypasses rate limiting', () => {
        const { req, res, next } = createMock('/health');
        rateLimitMiddleware(req, res, next);
        expect(next).toHaveBeenCalled();
    });

    test('expensive endpoints have lower limits', () => {
        // scg_ingest_repo has 5 req / 5min limit
        for (let i = 0; i < 5; i++) {
            const { req, res, next } = createMock('/scg_ingest_repo');
            rateLimitMiddleware(req, res, next);
        }

        const mock = createMock('/scg_ingest_repo');
        rateLimitMiddleware(mock.req, mock.res, mock.next);
        expect(mock.next).not.toHaveBeenCalled();
        expect(mock.getStatus()).toBe(429);
    });
});
