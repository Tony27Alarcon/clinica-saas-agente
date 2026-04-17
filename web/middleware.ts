import { jwtVerify } from 'jose';
import { NextRequest, NextResponse } from 'next/server';

const COOKIE  = 'admin_session';
const COOKIE_MAX_AGE = 60 * 60 * 24; // 24 h

export type PortalRole = 'admin' | 'staff';

export interface PortalPayload {
    companyId: string;
    role:      PortalRole;
}

function secret() {
    const raw = process.env.INTERNAL_API_SECRET?.trim();
    if (!raw) throw new Error('INTERNAL_API_SECRET no está configurado');
    return new TextEncoder().encode(raw);
}

async function verify(token: string): Promise<PortalPayload | null> {
    try {
        const { payload } = await jwtVerify(token, secret());
        const companyId = payload.companyId as string | undefined;
        if (!companyId) return null;
        // Tokens viejos sin role se asumen admin (back-compat) — ver docs/company-skills.md.
        const role = (payload.role === 'staff' ? 'staff' : 'admin') as PortalRole;
        return { companyId, role };
    } catch {
        return null;
    }
}

function withAuthHeaders(req: NextRequest, payload: PortalPayload): NextResponse {
    const headers = new Headers(req.headers);
    headers.set('x-company-id', payload.companyId);
    headers.set('x-user-role',  payload.role);
    return NextResponse.next({ request: { headers } });
}

function unauthorized(req: NextRequest, isApi: boolean): NextResponse {
    if (isApi) {
        return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
    }
    return NextResponse.redirect(new URL('/admin/auth-error', req.url));
}

export async function middleware(req: NextRequest) {
    const { pathname } = req.nextUrl;
    const isApi = pathname.startsWith('/api/');

    // ── Extraer companyId de la URL ─────────────────────────────────────────
    // Páginas: /admin/[companyId]/...
    // API:     /api/admin/[companyId]/...
    const match = isApi
        ? pathname.match(/^\/api\/admin\/([^/]+)/)
        : pathname.match(/^\/admin\/([^/]+)/);
    const urlCompanyId = match?.[1];

    const urlToken = req.nextUrl.searchParams.get('token');

    // ── Flujo magic link: token en la URL (solo páginas) ────────────────────
    if (urlToken && !isApi) {
        const payload = await verify(urlToken);

        if (!payload || payload.companyId !== urlCompanyId) {
            return NextResponse.redirect(new URL('/admin/auth-error', req.url));
        }

        // Token válido: guardar en cookie HttpOnly y limpiar la URL
        const cleanUrl = req.nextUrl.clone();
        cleanUrl.searchParams.delete('token');
        const res = NextResponse.redirect(cleanUrl);
        res.cookies.set(COOKIE, urlToken, {
            httpOnly: true,
            secure:   true,
            sameSite: 'lax',
            maxAge:   COOKIE_MAX_AGE,
            path:     '/',
        });
        return res;
    }

    // ── Flujo sesión activa: cookie existente ────────────────────────────────
    const cookieToken = req.cookies.get(COOKIE)?.value;

    if (!cookieToken) return unauthorized(req, isApi);

    const payload = await verify(cookieToken);

    if (!payload) {
        const res = unauthorized(req, isApi);
        res.cookies.delete(COOKIE);
        return res;
    }

    if (urlCompanyId && payload.companyId !== urlCompanyId) {
        return unauthorized(req, isApi);
    }

    // Propagar identidad a route handlers vía headers (no leíbles desde cliente)
    return withAuthHeaders(req, payload);
}

export const config = {
    matcher: ['/admin/((?!auth-error).*)', '/api/admin/:path*'],
};
